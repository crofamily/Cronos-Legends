// Cronos Legends burn monitor (and price keeper).
//
// Runs on a schedule (GitHub Actions, see .github/workflows/burn-monitor.yml). Each run it:
//   0. (if POKE_PRIVATE_KEY is set) records an hourly price checkpoint in the oracle — the oracle
//      needs one about every hour to keep pricing burns,
//   1. reads every deployed burn redeemer (reserve, payout, burns left) and the price oracle,
//   2. posts Discord alerts when a reserve runs low or empty, when burns stop (oracle warming up,
//      stale, or a liquidity floor tripped), when checkpoints stop arriving, when the two averages
//      diverge, or when the oracle disagrees with GeckoTerminal's CLG price,
//   3. posts one message per new burn,
//   4. once a day posts a digest with reserves, burns, CLG price and the LP's uncollected fees.
//
// Config comes from assets/data/burn.json (the same file the website reads). State between runs
// (last scanned block, last alert levels) lives in a small JSON file persisted with actions/cache.
//
// Environment:
//   DISCORD_WEBHOOK_URL   Discord webhook (required to post; without it the run only logs)
//   DISCORD_MENTION_ID    optional Discord user ID to ping on critical alerts
//   POKE_PRIVATE_KEY      optional key of a small gas-only wallet that pokes the oracle (never the
//                         treasury key: poke() is permissionless and this wallet needs only a few CRO)
//   LOW_BURNS             warn when a reserve covers this many burns or fewer (default 5)
//   DIGEST_HOUR_UTC       hour after which the daily digest is sent (default 8)
//   MONITOR_MODE          "run" (default), "test" (send a test message), "digest" (force digest)
//   MONITOR_STATE         state file path (default .monitor-state/state.json)
//   BURN_CONFIG           alternative config file path (used for local fork testing)

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { ethers } from "ethers";

const CONFIG_URL = process.env.BURN_CONFIG ? new URL(`file://${process.env.BURN_CONFIG.replace(/\\/g, "/").replace(/^\/?/, "/")}`) : new URL("../assets/data/burn.json", import.meta.url);
const STATE_PATH = process.env.MONITOR_STATE || ".monitor-state/state.json";
const WEBHOOK = process.env.DISCORD_WEBHOOK_URL || "";
const MENTION_ID = (process.env.DISCORD_MENTION_ID || "").trim();
const POKE_KEY = (process.env.POKE_PRIVATE_KEY || "").trim();
const LOW_BURNS = Number(process.env.LOW_BURNS || 5);
const DIGEST_HOUR_UTC = Number(process.env.DIGEST_HOUR_UTC || 8);
const MODE = process.env.MONITOR_MODE || "run";

const HOUR = 3600 * 1000;
const REMIND_AFTER = { empty: 6 * HOUR, oracle: 6 * HOUR, low: 24 * HOUR, divergence: 6 * HOUR, stale: 6 * HOUR, keeper: 24 * HOUR };
const MAX_LOG_RANGE = 9000; // publicnode allows 10k blocks per eth_getLogs
const MAX_BACKFILL = 60000; // ~6.5h of blocks; older gaps are skipped
const DIVERGENCE = 0.15; // long vs short average
const EXTERNAL_DEVIATION = 0.2; // oracle vs GeckoTerminal
const CHECKPOINT_STALE_SECONDS = 2 * 3600;
const KEEPER_MIN_CRO = 5;

const COLOR = { critical: 0xe74c3c, warning: 0xf39c12, ok: 0x2ecc71, info: 0x3498db, digest: 0xf1c40f };

const ORACLE_ERRORS = [
  "error WarmingUp()",
  "error Stale(uint256 referenceAge)",
  "error LiquidityTooLow(uint256 poolCronus, uint256 inRangeLiquidity)",
  "error PairReservesTooLow(uint256 cronusPairWcro, uint256 croPairUsdc)",
];
const REDEEMER_ABI = [
  "function quote() view returns (uint256 clgAmount, uint256 clgUsdPrice)",
  "function reserveBalance() view returns (uint256)",
  "function totalRedeemed() view returns (uint256)",
  "function totalClgPaid() view returns (uint256)",
  "event Redeemed(address indexed holder, uint256 indexed tokenId, uint256 clgAmount, uint256 clgUsdPrice)",
  ...ORACLE_ERRORS,
];
const ORACLE_ABI = [
  "function prices() view returns (uint256 longTwapPrice, uint256 shortTwapPrice)",
  "function poke() returns (bool)",
  "function latestCheckpoint() view returns ((uint32 timestamp,int56 clgTickCumulative,uint96 poolCronus,uint256 cronusPriceCumulative,uint256 croPriceCumulative))",
  ...ORACLE_ERRORS,
];
const NFPM_ABI = [
  "function balanceOf(address) view returns (uint256)",
  "function tokenOfOwnerByIndex(address,uint256) view returns (uint256)",
  "function positions(uint256) view returns (uint96 nonce,address operator,address token0,address token1,uint24 fee,int24 tickLower,int24 tickUpper,uint128 liquidity,uint256 feeGrowthInside0LastX128,uint256 feeGrowthInside1LastX128,uint128 tokensOwed0,uint128 tokensOwed1)",
  "function collect((uint256 tokenId,address recipient,uint128 amount0Max,uint128 amount1Max)) returns (uint256 amount0,uint256 amount1)",
];
const V2_ABI = ["function getReserves() view returns (uint112,uint112,uint32)", "function token0() view returns (address)"];

const WHY = {
  WarmingUp: "The price oracle is still warming up: it needs a day of hourly checkpoints before it can price a burn.",
  Stale: "The price oracle's checkpoints are too old (the keeper stopped?). Burns resume about 10 minutes after the next checkpoint if the gap was under ~6 hours, otherwise after a new day of hourly checkpoints. Anyone can call poke() on the oracle.",
  LiquidityTooLow: "The CLG/CRONUS V3 pool is below its liquidity floor now, or was at an hourly checkpoint in the last 24 hours. Burns stop until the liquidity is back and that checkpoint has aged out.",
  PairReservesTooLow: "One of the VVS V2 pairs used for pricing (CRONUS/WCRO or WCRO/USDC) is below its reserve floor.",
};

// ---------------------------------------------------------------------------
// RPC with failover
// ---------------------------------------------------------------------------

function makeProviders(urls, chainId) {
  const network = ethers.Network.from(chainId);
  return urls.map((url) => new ethers.JsonRpcProvider(url, network, { staticNetwork: network, batchMaxCount: 1 }));
}

async function withFailover(providers, fn) {
  let lastErr;
  for (const p of providers) {
    try {
      return await fn(p);
    } catch (err) {
      // A contract revert is an answer, not an RPC failure: don't retry it elsewhere.
      if (err && (err.code === "CALL_EXCEPTION" || err.revert || err.data)) throw err;
      lastErr = err;
    }
  }
  throw lastErr;
}

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------

const fmt = (x, digits = 4) => Number(x).toLocaleString("en-US", { maximumFractionDigits: digits });
const clgStr = (wei) => `${fmt(ethers.formatUnits(wei, 18), 4)} CLG`;
const usdStr = (e18) => `$${fmt(ethers.formatUnits(e18, 18), 2)}`;
const short = (a) => `${a.slice(0, 6)}…${a.slice(-4)}`;

function decodeRevert(err, iface) {
  const data = err?.data || err?.info?.error?.data || err?.error?.data;
  if (typeof data === "string" && data.startsWith("0x") && data.length >= 10) {
    try {
      const parsed = iface.parseError(data);
      if (parsed) return parsed.name;
    } catch {
      /* not one of ours */
    }
  }
  return err?.shortMessage || err?.message || "unknown error";
}

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

async function loadState() {
  try {
    return JSON.parse(await readFile(STATE_PATH, "utf8"));
  } catch {
    return { lastBlock: 0, alerts: {}, lastDigestDate: "", digestTotals: {} };
  }
}

async function saveState(state) {
  await mkdir(dirname(STATE_PATH), { recursive: true });
  await writeFile(STATE_PATH, JSON.stringify(state, null, 2));
}

/// Decide whether an alert for `key` at `level` should be sent now, and record it.
function shouldAlert(state, key, level, reminderMs) {
  const prev = state.alerts[key];
  const now = Date.now();
  if (!prev || prev.level !== level) {
    state.alerts[key] = { level, at: now };
    return true;
  }
  if (reminderMs && now - prev.at >= reminderMs) {
    state.alerts[key] = { level, at: now };
    return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Discord
// ---------------------------------------------------------------------------

async function postDiscord(embeds, { critical = false } = {}) {
  if (!embeds.length) return;
  if (!WEBHOOK) {
    console.log("[dry-run] no DISCORD_WEBHOOK_URL; would post:\n" + JSON.stringify(embeds, null, 2));
    return;
  }
  for (let i = 0; i < embeds.length; i += 10) {
    const body = {
      username: "Cronos Legends Monitor",
      embeds: embeds.slice(i, i + 10),
      allowed_mentions: critical && MENTION_ID ? { users: [MENTION_ID] } : { parse: [] },
    };
    if (critical && MENTION_ID && i === 0) body.content = `<@${MENTION_ID}>`;
    for (let attempt = 0; attempt < 3; attempt++) {
      const res = await fetch(WEBHOOK + (WEBHOOK.includes("?") ? "&" : "?") + "wait=true", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      if (res.status === 429) {
        const j = await res.json().catch(() => ({}));
        await new Promise((r) => setTimeout(r, Math.ceil((j.retry_after || 2) * 1000)));
        continue;
      }
      if (!res.ok) throw new Error(`Discord webhook failed: ${res.status} ${await res.text()}`);
      break;
    }
  }
}

// ---------------------------------------------------------------------------
// Keeper
// ---------------------------------------------------------------------------

async function keep(providers, oracleAddr) {
  if (!POKE_KEY) return { enabled: false };
  const out = { enabled: true };
  await withFailover(providers, async (p) => {
    const wallet = new ethers.Wallet(POKE_KEY, p);
    out.address = wallet.address;
    out.balance = Number(ethers.formatEther(await p.getBalance(wallet.address)));
    const oracle = new ethers.Contract(oracleAddr, ORACLE_ABI, wallet);
    if (await oracle.poke.staticCall()) {
      const tx = await oracle.poke({ gasLimit: 400000n });
      out.tx = tx.hash;
      await tx.wait();
      console.log(`Recorded oracle checkpoint: ${tx.hash}`);
    }
  });
  return out;
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

async function readRedeemer(providers, col, iface) {
  const out = { col, ok: false };
  return withFailover(providers, async (p) => {
    const r = new ethers.Contract(col.redeemer, REDEEMER_ABI, p);
    const [reserve, totalRedeemed, totalClgPaid] = await Promise.all([r.reserveBalance(), r.totalRedeemed(), r.totalClgPaid()]);
    Object.assign(out, { reserve, totalRedeemed, totalClgPaid });
    try {
      const [clgAmount, clgUsdPrice] = await r.quote();
      Object.assign(out, { ok: true, clgAmount, clgUsdPrice, burnsLeft: clgAmount > 0n ? reserve / clgAmount : 0n });
    } catch (err) {
      out.error = decodeRevert(err, iface);
    }
    return out;
  });
}

async function readOracle(providers, oracleAddr, iface) {
  return withFailover(providers, async (p) => {
    const o = new ethers.Contract(oracleAddr, ORACLE_ABI, p);
    const cp = await o.latestCheckpoint();
    const res = { lastCheckpointAge: Math.floor(Date.now() / 1000) - Number(cp.timestamp) };
    try {
      const [longTwap, shortTwap] = await o.prices();
      Object.assign(res, { longTwap, shortTwap, price: longTwap > shortTwap ? longTwap : shortTwap });
    } catch (err) {
      res.error = decodeRevert(err, iface);
    }
    return res;
  });
}

async function geckoClgPrice(clg) {
  try {
    const r = await fetch(`https://api.geckoterminal.com/api/v2/networks/cro/tokens/${clg.toLowerCase()}`, { headers: { accept: "application/json" } });
    if (!r.ok) return null;
    const j = await r.json();
    const p = Number(j?.data?.attributes?.price_usd);
    return Number.isFinite(p) && p > 0 ? p : null;
  } catch {
    return null;
  }
}

async function readLp(providers, cfg) {
  return withFailover(providers, async (p) => {
    const nfpm = new ethers.Contract(cfg.lp.positionManager, NFPM_ABI, p);
    const owner = cfg.lp.owner;
    const n = Number(await nfpm.balanceOf(owner));
    let fees0 = 0n;
    let fees1 = 0n;
    const ids = [];
    for (let i = 0; i < Math.min(n, 50); i++) {
      const id = await nfpm.tokenOfOwnerByIndex(owner, i);
      const pos = await nfpm.positions(id);
      const isPool =
        Number(pos.fee) === cfg.lp.feeTier &&
        [pos.token0.toLowerCase(), pos.token1.toLowerCase()].sort().join() === [cfg.clg.toLowerCase(), cfg.cronus.toLowerCase()].sort().join();
      if (!isPool) continue;
      const max = (1n << 128n) - 1n;
      const [a0, a1] = await nfpm.collect.staticCall({ tokenId: id, recipient: owner, amount0Max: max, amount1Max: max }, { from: owner });
      const clgIs0 = pos.token0.toLowerCase() === cfg.clg.toLowerCase();
      fees0 += clgIs0 ? a0 : a1; // CLG
      fees1 += clgIs0 ? a1 : a0; // CRONUS
      if (pos.liquidity > 0n) ids.push(id.toString());
    }
    return { feesClg: fees0, feesCronus: fees1, ids };
  });
}

async function cronusUsd(providers, cfg) {
  return withFailover(providers, async (p) => {
    const cw = new ethers.Contract(cfg.pricing.cronusWcroPair, V2_ABI, p);
    const wu = new ethers.Contract(cfg.pricing.wcroUsdcPair, V2_ABI, p);
    const [[c0, c1], cT0, [u0, u1], uT0] = await Promise.all([cw.getReserves(), cw.token0(), wu.getReserves(), wu.token0()]);
    const cronusIs0 = cT0.toLowerCase() === cfg.cronus.toLowerCase();
    const wcroPerCronus = cronusIs0 ? Number(c1) / Number(c0) : Number(c0) / Number(c1);
    const wcroIs0 = uT0.toLowerCase() !== "0xc21223249ca28397b4b6541dffaecc539bff0c59";
    const usdPerWcro = wcroIs0 ? Number(u1) / 1e6 / (Number(u0) / 1e18) : Number(u0) / 1e6 / (Number(u1) / 1e18);
    return wcroPerCronus * usdPerWcro;
  });
}

async function scanBurns(providers, logProvider, cols, fromBlock, toBlock) {
  const iface = new ethers.Interface(REDEEMER_ABI);
  const topic = iface.getEvent("Redeemed").topicHash;
  const byAddr = Object.fromEntries(cols.map((c) => [c.redeemer.toLowerCase(), c]));
  const burns = [];
  for (let start = fromBlock; start <= toBlock; start += MAX_LOG_RANGE) {
    const end = Math.min(start + MAX_LOG_RANGE - 1, toBlock);
    const logs = await withFailover([logProvider, ...providers], (p) =>
      p.getLogs({ address: cols.map((c) => c.redeemer), topics: [topic], fromBlock: start, toBlock: end })
    );
    for (const log of logs) {
      const ev = iface.parseLog(log);
      burns.push({
        col: byAddr[log.address.toLowerCase()],
        holder: ev.args.holder,
        tokenId: ev.args.tokenId,
        clgAmount: ev.args.clgAmount,
        clgUsdPrice: ev.args.clgUsdPrice,
        tx: log.transactionHash,
      });
    }
  }
  return burns;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const cfg = JSON.parse(await readFile(CONFIG_URL, "utf8"));
  const providers = makeProviders(cfg.rpc, cfg.chainId);
  const logProvider = providers.find((p) => p._getConnection().url.includes("publicnode")) || providers[0];
  const iface = new ethers.Interface(REDEEMER_ABI);
  const explorer = cfg.explorer.replace(/\/$/, "");

  if (MODE === "test") {
    await postDiscord([{ title: "✅ Burn monitor connected", description: "Test message from the Cronos Legends burn monitor.", color: COLOR.ok, timestamp: new Date().toISOString() }]);
    return;
  }

  if (!cfg.oracle) {
    console.log("No oracle deployed yet (assets/data/burn.json). Nothing to monitor.");
    return;
  }
  const cols = cfg.collections.filter((c) => c.redeemer);
  const state = await loadState();
  const alerts = [];
  let critical = false;

  // 0. Keeper.
  let keeper = { enabled: false };
  try {
    keeper = await keep(providers, cfg.oracle);
  } catch (err) {
    keeper = { enabled: true, error: err.shortMessage || err.message };
    console.warn("Keeper poke failed:", keeper.error);
  }
  if (keeper.enabled && keeper.balance !== undefined && keeper.balance < KEEPER_MIN_CRO) {
    if (shouldAlert(state, "keeper-gas", "low", REMIND_AFTER.keeper)) {
      alerts.push({ title: "⛽ Keeper wallet needs CRO", description: `The wallet that records price checkpoints (${keeper.address}) has ${fmt(keeper.balance, 2)} CRO left. Send it ~30 CRO.`, color: COLOR.warning });
    }
  }

  // 1. Oracle health.
  const oracle = await readOracle(providers, cfg.oracle, new ethers.Interface(ORACLE_ABI));
  if (oracle.lastCheckpointAge > CHECKPOINT_STALE_SECONDS) {
    if (shouldAlert(state, "checkpoints", "stale", REMIND_AFTER.stale)) {
      alerts.push({
        title: "⏱️ Price checkpoints stopped",
        url: `${explorer}/address/${cfg.oracle}`,
        description: `The last oracle checkpoint is ${fmt(oracle.lastCheckpointAge / 3600, 1)} hours old. ${keeper.enabled ? "The keeper could not record one" + (keeper.error ? `: ${keeper.error}` : "") + "." : "Set the POKE_PRIVATE_KEY secret so the monitor records one every hour, or call poke() on the oracle."} Burns stop after ~6 hours without checkpoints.`,
        color: COLOR.warning,
      });
    }
  } else {
    delete state.alerts.checkpoints;
  }
  if (oracle.longTwap && oracle.shortTwap) {
    const l = Number(ethers.formatUnits(oracle.longTwap, 18));
    const s = Number(ethers.formatUnits(oracle.shortTwap, 18));
    const dev = Math.abs(s - l) / l;
    if (dev > DIVERGENCE) {
      if (shouldAlert(state, "divergence", "high", REMIND_AFTER.divergence)) {
        alerts.push({
          title: "📉 CLG price moved sharply",
          url: `${explorer}/address/${cfg.oracle}`,
          description: `The last-hour and 24-hour averages differ by ${(dev * 100).toFixed(1)}%. Burns pay at the higher of the two, so the reserve is protected, but check the CLG/CRONUS pool for unusual trading.`,
          color: COLOR.warning,
          fields: [{ name: "24h average", value: `$${fmt(l, 2)}`, inline: true }, { name: "Short average", value: `$${fmt(s, 2)}`, inline: true }],
        });
      }
    } else {
      delete state.alerts.divergence;
    }
    const gecko = await geckoClgPrice(cfg.clg);
    const used = Math.max(l, s);
    if (gecko) {
      const ext = Math.abs(used - gecko) / gecko;
      if (ext > EXTERNAL_DEVIATION) {
        if (shouldAlert(state, "external", "high", REMIND_AFTER.divergence)) {
          alerts.push({
            title: "🧭 Oracle price disagrees with GeckoTerminal",
            url: `${explorer}/address/${cfg.oracle}`,
            description: `Burns currently use $${fmt(used, 2)} per CLG, GeckoTerminal shows $${fmt(gecko, 2)} (${(ext * 100).toFixed(1)}% apart). A lasting gap can mean someone is holding the pool price away from the market. Consider pausing top-ups until it closes.`,
            color: COLOR.warning,
          });
        }
      } else {
        delete state.alerts.external;
      }
    }
  }

  // 2. Reserves and payouts.
  const reads = [];
  for (const col of cols) reads.push(await readRedeemer(providers, col, iface));

  for (const r of reads) {
    const url = `${explorer}/address/${r.col.redeemer}`;
    if (!r.ok) {
      if (shouldAlert(state, `oracle:${r.col.key}`, r.error, REMIND_AFTER.oracle)) {
        critical = r.error !== "WarmingUp";
        alerts.push({ title: `⛔ ${r.col.name}: burns are not working`, url, description: WHY[r.error] || `The payout could not be priced: ${r.error}`, color: COLOR.critical, fields: [{ name: "Reserve", value: clgStr(r.reserve), inline: true }] });
      }
      continue;
    }
    delete state.alerts[`oracle:${r.col.key}`];

    const burnsLeft = Number(r.burnsLeft);
    const level = burnsLeft < 1 ? "empty" : burnsLeft <= LOW_BURNS ? "low" : "ok";
    const key = `reserve:${r.col.key}`;
    const prevLevel = state.alerts[key]?.level;
    if (level === "ok") {
      if (prevLevel && prevLevel !== "ok") {
        alerts.push({ title: `✅ ${r.col.name}: reserve topped up`, url, color: COLOR.ok, fields: [{ name: "Reserve", value: clgStr(r.reserve), inline: true }, { name: "Burns covered", value: String(burnsLeft), inline: true }] });
      }
      state.alerts[key] = { level: "ok", at: Date.now() };
    } else if (shouldAlert(state, key, level, REMIND_AFTER[level])) {
      if (level === "empty") critical = true;
      alerts.push({
        title: level === "empty" ? `🚨 ${r.col.name}: reserve is EMPTY` : `⚠️ ${r.col.name}: reserve is running low`,
        url,
        description:
          level === "empty"
            ? `Holders cannot burn right now: the reserve holds less than one payout. Send CLG to the redeemer contract \`${r.col.redeemer}\` to reopen burns.`
            : `Only ${burnsLeft} burn${burnsLeft === 1 ? "" : "s"} left at today's payout. Top up by sending CLG to \`${r.col.redeemer}\`.`,
        color: level === "empty" ? COLOR.critical : COLOR.warning,
        fields: [
          { name: "Reserve", value: clgStr(r.reserve), inline: true },
          { name: "Payout per NFT", value: `${clgStr(r.clgAmount)} (${usdStr((r.clgAmount * r.clgUsdPrice) / 10n ** 18n)})`, inline: true },
          { name: "Burned so far", value: String(r.totalRedeemed), inline: true },
        ],
      });
    }
  }

  // 3. New burns.
  const head = await withFailover(providers, (p) => p.getBlockNumber());
  let from = state.lastBlock ? state.lastBlock + 1 : head - 4500;
  if (head - from > MAX_BACKFILL) {
    console.log(`Skipping ${head - MAX_BACKFILL - from} blocks of backlog.`);
    from = head - MAX_BACKFILL;
  }
  if (cols.length && from <= head) {
    const burns = await scanBurns(providers, logProvider, cols, from, head);
    for (const b of burns.slice(0, 20)) {
      alerts.push({
        title: `🔥 ${b.col.name} #${b.tokenId} burned`,
        url: `${explorer}/tx/${b.tx}`,
        color: COLOR.info,
        fields: [
          { name: "Holder", value: `[${short(b.holder)}](${explorer}/address/${b.holder})`, inline: true },
          { name: "Paid", value: `${clgStr(b.clgAmount)} (${usdStr((b.clgAmount * b.clgUsdPrice) / 10n ** 18n)})`, inline: true },
        ],
      });
    }
    if (burns.length > 20) alerts.push({ title: `…and ${burns.length - 20} more burns`, color: COLOR.info });
  }
  state.lastBlock = head;

  // 4. Daily digest.
  const now = new Date();
  const today = now.toISOString().slice(0, 10);
  if (MODE === "digest" || (now.getUTCHours() >= DIGEST_HOUR_UTC && state.lastDigestDate !== today)) {
    const fields = [];
    for (const r of reads) {
      const prev = BigInt(state.digestTotals[r.col.key] ?? r.totalRedeemed);
      fields.push({
        name: r.col.name,
        value: r.ok
          ? `Reserve ${clgStr(r.reserve)} · ${r.burnsLeft} burns left · ${r.totalRedeemed - prev} burned in 24h (${r.totalRedeemed} total)`
          : `Reserve ${clgStr(r.reserve)} · burns paused: ${r.error}`,
      });
      state.digestTotals[r.col.key] = r.totalRedeemed.toString();
    }
    if (oracle.longTwap) fields.push({ name: "CLG price (burns use the higher)", value: `24h avg $${fmt(ethers.formatUnits(oracle.longTwap, 18), 2)} · last hour $${fmt(ethers.formatUnits(oracle.shortTwap, 18), 2)}` });
    fields.push({ name: "Oracle checkpoints", value: `last one ${fmt(oracle.lastCheckpointAge / 60, 0)} min ago · keeper ${keeper.enabled ? `on (${keeper.address ? short(keeper.address) : "?"}${keeper.balance !== undefined ? `, ${fmt(keeper.balance, 1)} CRO` : ""})` : "off"}` });
    try {
      const lp = await readLp(providers, cfg);
      const cUsd = await cronusUsd(providers, cfg);
      const clgUsd = oracle.price ? Number(ethers.formatUnits(oracle.price, 18)) : 0;
      const feeUsd = Number(ethers.formatUnits(lp.feesClg, 18)) * clgUsd + Number(ethers.formatUnits(lp.feesCronus, 18)) * cUsd;
      fields.push({ name: "LP fees waiting to be collected (VVS CLG/CRONUS 1%)", value: `${fmt(ethers.formatUnits(lp.feesClg, 18), 5)} CLG + ${fmt(ethers.formatUnits(lp.feesCronus, 18), 2)} CRONUS ≈ $${fmt(feeUsd, 2)} (positions ${lp.ids.join(", ") || "none"})` });
    } catch (err) {
      fields.push({ name: "LP fees", value: `could not read: ${err.shortMessage || err.message}` });
    }
    alerts.push({ title: "📊 Daily burn & LP report", color: COLOR.digest, fields, timestamp: now.toISOString() });
    state.lastDigestDate = today;
  }

  await postDiscord(alerts, { critical });
  await saveState(state);
  console.log(`Done. ${alerts.length} message(s). Head block ${head}.`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

// Builds assets/data/lp-history.json: the swap fees the project's CLG/CRONUS liquidity positions
// have already collected. The website adds the live (not yet collected) fees on top in the browser.
//
// Fees collected by a V3 position = sum(Collect amounts) - sum(DecreaseLiquidity amounts), because
// a Collect also withdraws any principal that DecreaseLiquidity moved into tokensOwed.
//
// Runs in the Pages deploy workflow (on push and daily). Incremental: the last scanned block and
// running sums are kept in a cache file between runs.
//
//   node monitor/lp-history.mjs --out _site/assets/data/lp-history.json --cache .lp-history-cache/state.json

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { ethers } from "ethers";

const args = Object.fromEntries(
  process.argv.slice(2).reduce((acc, a, i, all) => (a.startsWith("--") ? [...acc, [a.slice(2), all[i + 1]]] : acc), [])
);
const OUT = args.out || "assets/data/lp-history.json";
const CACHE = args.cache || ".lp-history-cache/state.json";
const CONFIG_URL = new URL("../assets/data/burn.json", import.meta.url);

// The treasury opened its first position in the 1% pool on 2026-09-05 (block ~91,982,101).
const START_BLOCK = 91_980_000;
const RANGE = 9_000;

const NFPM_ABI = [
  "function balanceOf(address) view returns (uint256)",
  "function tokenOfOwnerByIndex(address,uint256) view returns (uint256)",
  "function positions(uint256) view returns (uint96,address,address token0,address token1,uint24 fee,int24,int24,uint128 liquidity,uint256,uint256,uint128,uint128)",
  "event Collect(uint256 indexed tokenId, address recipient, uint256 amount0, uint256 amount1)",
  "event DecreaseLiquidity(uint256 indexed tokenId, uint128 liquidity, uint256 amount0, uint256 amount1)",
];

async function readJson(path, fallback) {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch {
    return fallback;
  }
}

async function writeJson(path, data) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(data, null, 2));
}

async function main() {
  const cfg = JSON.parse(await readFile(CONFIG_URL, "utf8"));
  const network = ethers.Network.from(cfg.chainId);
  const providers = cfg.rpc.map((u) => new ethers.JsonRpcProvider(u, network, { staticNetwork: network, batchMaxCount: 1 }));
  const logProvider = providers.find((p) => p._getConnection().url.includes("publicnode")) || providers[0];
  const call = async (fn) => {
    let last;
    for (const p of providers) {
      try {
        return await fn(p);
      } catch (e) {
        last = e;
      }
    }
    throw last;
  };

  const clg = cfg.clg.toLowerCase();
  const cronus = cfg.cronus.toLowerCase();
  const state = await readJson(CACHE, { lastBlock: START_BLOCK - 1, tokenIds: [], sums: {} });

  // Discover the owner's positions in the CLG/CRONUS pool at this fee tier.
  const owned = await call(async (p) => {
    const nfpm = new ethers.Contract(cfg.lp.positionManager, NFPM_ABI, p);
    const n = Number(await nfpm.balanceOf(cfg.lp.owner));
    const out = [];
    for (let i = 0; i < n; i++) {
      const id = await nfpm.tokenOfOwnerByIndex(cfg.lp.owner, i);
      const pos = await nfpm.positions(id);
      const pair = [pos.token0.toLowerCase(), pos.token1.toLowerCase()];
      if (Number(pos.fee) === cfg.lp.feeTier && pair.includes(clg) && pair.includes(cronus)) {
        out.push({ id: id.toString(), clgIs0: pair[0] === clg, liquidity: pos.liquidity.toString() });
      }
    }
    return out;
  });
  for (const o of owned) if (!state.tokenIds.includes(o.id)) state.tokenIds.push(o.id);
  const clgIs0 = Object.fromEntries(owned.map((o) => [o.id, o.clgIs0]));

  const iface = new ethers.Interface(NFPM_ABI);
  const collectTopic = iface.getEvent("Collect").topicHash;
  const decreaseTopic = iface.getEvent("DecreaseLiquidity").topicHash;
  const idTopics = state.tokenIds.map((id) => ethers.toBeHex(BigInt(id), 32));
  const head = await call((p) => p.getBlockNumber());

  if (idTopics.length) {
    for (let from = state.lastBlock + 1; from <= head; from += RANGE) {
      const to = Math.min(from + RANGE - 1, head);
      const logs = await call(async (p) =>
        (p === providers[0] ? logProvider : p).getLogs({
          address: cfg.lp.positionManager,
          topics: [[collectTopic, decreaseTopic], idTopics],
          fromBlock: from,
          toBlock: to,
        })
      );
      for (const log of logs) {
        const ev = iface.parseLog(log);
        const id = ev.args.tokenId.toString();
        const s = (state.sums[id] ||= { c0: "0", c1: "0", d0: "0", d1: "0" });
        if (ev.name === "Collect") {
          s.c0 = (BigInt(s.c0) + ev.args.amount0).toString();
          s.c1 = (BigInt(s.c1) + ev.args.amount1).toString();
        } else {
          s.d0 = (BigInt(s.d0) + ev.args.amount0).toString();
          s.d1 = (BigInt(s.d1) + ev.args.amount1).toString();
        }
      }
      state.lastBlock = to;
    }
  } else {
    state.lastBlock = head;
  }

  let feesClg = 0n;
  let feesCronus = 0n;
  for (const [id, s] of Object.entries(state.sums)) {
    const f0 = BigInt(s.c0) - BigInt(s.d0);
    const f1 = BigInt(s.c1) - BigInt(s.d1);
    // Positions the owner no longer holds keep the orientation of the pool (CLG is token0 there).
    const is0 = clgIs0[id] ?? true;
    feesClg += is0 ? f0 : f1;
    feesCronus += is0 ? f1 : f0;
  }

  const out = {
    generatedAt: new Date().toISOString(),
    asOfBlock: head,
    pool: cfg.lp.pool,
    owner: cfg.lp.owner,
    positions: owned.map((o) => ({ id: o.id, active: BigInt(o.liquidity) > 0n })),
    collected: {
      clg: ethers.formatUnits(feesClg, 18),
      cronus: ethers.formatUnits(feesCronus, 18),
    },
  };
  await writeJson(OUT, out);
  await writeJson(CACHE, state);
  console.log(`LP history up to block ${head}: collected ${out.collected.clg} CLG + ${out.collected.cronus} CRONUS from ${state.tokenIds.length} position(s).`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

/* Cronos Legends — tiny read-only chain client (no libraries).
 *
 * Plain JSON-RPC eth_call against public Cronos RPCs with failover, for pages that only need to
 * show live numbers (home, $CLG, collections). The burn page uses ethers instead (chain.js).
 * Values are BigInt; helpers convert to floats for display only.
 */
(function () {
  "use strict";
  const CL = (window.CL = window.CL || {});

  const SEL = {
    balanceOf: "0x70a08231",
    slot0: "0x3850c7bd",
    getReserves: "0x0902f1ac",
    token0: "0x0dfe1681",
    liquidity: "0x1a686502",
    tokenOfOwnerByIndex: "0x2f745c59",
    positions: "0x99fbab88",
    collect: "0xfc6f7865",
    reserveBalance: "0xa10954fe",
    totalRedeemed: "0xf35dad40",
    quote: "0x999b93af",
    outstandingNfts: "0x9c6be17a",
  };
  const ERRORS = {
    "0xfaacbbfc": "WarmingUp",
    "0xc231471f": "Stale",
    "0x005f990f": "LiquidityTooLow",
    "0x70a847f1": "PairReservesTooLow",
    "0x78fe52a6": "ReserveTooLow",
  };
  const USDC = "0xc21223249ca28397b4b6541dffaecc539bff0c59";
  const MAX128 = (1n << 128n) - 1n;

  CL.config =
    CL.config ||
    (function () {
      let p;
      return () =>
        (p =
          p ||
          fetch("/assets/data/burn.json", { cache: "no-cache" }).then((r) => {
            if (!r.ok) throw new Error("config " + r.status);
            return r.json();
          }));
    })();

  // ---------------------------------------------------------------------------
  // RPC
  // ---------------------------------------------------------------------------

  let rpcId = 1;
  let preferred = 0;
  const cache = new Map();

  async function rpc(method, params) {
    const cfg = await CL.config();
    const urls = cfg.rpc;
    let lastErr;
    for (let k = 0; k < urls.length; k++) {
      const i = (preferred + k) % urls.length;
      try {
        const res = await fetch(urls[i], {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ jsonrpc: "2.0", id: rpcId++, method, params }),
        });
        if (!res.ok) throw new Error("HTTP " + res.status);
        const j = await res.json();
        if (j.error) {
          // Reverts are answers, not transport failures.
          const data = j.error.data && (typeof j.error.data === "string" ? j.error.data : j.error.data.data);
          if (data || /revert/i.test(j.error.message || "")) {
            const err = new Error(j.error.message || "execution reverted");
            err.revertData = data || null;
            err.revertName = data ? ERRORS[data.slice(0, 10)] || null : null;
            throw err;
          }
          throw new Error(j.error.message || "RPC error");
        }
        preferred = i;
        return j.result;
      } catch (e) {
        if (e.revertData !== undefined) throw e;
        lastErr = e;
      }
    }
    throw lastErr;
  }

  /** eth_call with a short cache so several widgets on one page share reads. */
  async function call(to, data, from) {
    const key = to + data + (from || "");
    const hit = cache.get(key);
    if (hit && Date.now() - hit.t < 15000) return hit.v;
    const p = rpc("eth_call", [from ? { to, data, from } : { to, data }, "latest"]);
    cache.set(key, { t: Date.now(), v: p });
    p.catch(() => cache.delete(key));
    return p;
  }

  // ---------------------------------------------------------------------------
  // ABI helpers (static types only)
  // ---------------------------------------------------------------------------

  const word = (hex, i) => "0x" + (hex.startsWith("0x") ? hex.slice(2) : hex).slice(i * 64, i * 64 + 64);
  const u = (hex, i = 0) => BigInt(word(hex, i));
  const s = (hex, i, bits) => {
    let v = u(hex, i) & ((1n << BigInt(bits)) - 1n);
    if (v >> BigInt(bits - 1)) v -= 1n << BigInt(bits);
    return v;
  };
  const addrOut = (hex, i) => "0x" + word(hex, i).slice(-40);
  const pad = (v) => BigInt(v).toString(16).padStart(64, "0");
  const addrIn = (a) => a.toLowerCase().replace(/^0x/, "").padStart(64, "0");
  const num = (wei, decimals = 18) => Number(wei) / 10 ** decimals;
  CL.num = num;

  CL.lite = {
    call,
    async balanceOf(token, owner) {
      return u(await call(token, SEL.balanceOf + addrIn(owner)));
    },
    async token0(pair) {
      return addrOut(await call(pair, SEL.token0), 0);
    },
    async reserves(pair) {
      const r = await call(pair, SEL.getReserves);
      return [u(r, 0), u(r, 1)];
    },
    async slot0(pool) {
      const r = await call(pool, SEL.slot0);
      return { sqrtPriceX96: u(r, 0), tick: Number(s(r, 1, 24)) };
    },
    async liquidity(pool) {
      return u(await call(pool, SEL.liquidity));
    },

    /** Spot USD prices of CLG, CRONUS and CRO from the same VVS pools the oracle uses. Display only. */
    async prices() {
      const cfg = await CL.config();
      const [slot0, t0, cw, cwT0, wu, wuT0] = await Promise.all([
        this.slot0(cfg.lp.pool),
        this.token0(cfg.lp.pool),
        this.reserves(cfg.pricing.cronusWcroPair),
        this.token0(cfg.pricing.cronusWcroPair),
        this.reserves(cfg.pricing.wcroUsdcPair),
        this.token0(cfg.pricing.wcroUsdcPair),
      ]);
      const clgIs0 = t0.toLowerCase() === cfg.clg.toLowerCase();
      const cronusPerClg = clgIs0 ? Math.pow(1.0001, slot0.tick) : 1 / Math.pow(1.0001, slot0.tick);
      const cronusIs0 = cwT0.toLowerCase() === cfg.cronus.toLowerCase();
      const wcroPerCronus = cronusIs0 ? Number(cw[1]) / Number(cw[0]) : Number(cw[0]) / Number(cw[1]);
      const usdcIs0 = wuT0.toLowerCase() === USDC;
      const usdPerCro = usdcIs0 ? num(wu[0], 6) / num(wu[1]) : num(wu[1], 6) / num(wu[0]);
      const cronus = wcroPerCronus * usdPerCro;
      return { clg: cronusPerClg * cronus, cronus, cro: usdPerCro, slot0 };
    },

    /** The project's liquidity positions in the CLG/CRONUS pool and the fees they could collect now. */
    async lp() {
      const cfg = await CL.config();
      const nfpm = cfg.lp.positionManager;
      const owner = cfg.lp.owner;
      const clg = cfg.clg.toLowerCase();
      const cronus = cfg.cronus.toLowerCase();
      const count = Number(u(await call(nfpm, SEL.balanceOf + addrIn(owner))));
      const ids = await Promise.all(
        Array.from({ length: Math.min(count, 30) }, (_, i) => call(nfpm, SEL.tokenOfOwnerByIndex + addrIn(owner) + pad(i)).then((r) => u(r)))
      );
      const out = [];
      for (const id of ids) {
        const p = await call(nfpm, SEL.positions + pad(id));
        const token0 = addrOut(p, 2).toLowerCase();
        const token1 = addrOut(p, 3).toLowerCase();
        const fee = Number(u(p, 4));
        if (fee !== cfg.lp.feeTier || ![token0, token1].includes(clg) || ![token0, token1].includes(cronus)) continue;
        // collect() simulated with eth_call from the owner: needs no signature and changes nothing.
        const c = await call(nfpm, SEL.collect + pad(id) + addrIn(owner) + pad(MAX128) + pad(MAX128), owner);
        out.push({
          id: id.toString(),
          clgIs0: token0 === clg,
          tickLower: Number(s(p, 5, 24)),
          tickUpper: Number(s(p, 6, 24)),
          liquidity: u(p, 7),
          owed0: u(c, 0),
          owed1: u(c, 1),
        });
      }
      return out;
    },

    /** Reserve and live payout of a burn redeemer; `error` names the reason when it can't price. */
    async redeemer(address) {
      const [reserve, burned] = await Promise.all([
        call(address, SEL.reserveBalance).then((r) => u(r)),
        call(address, SEL.totalRedeemed).then((r) => u(r)),
      ]);
      try {
        const q = await call(address, SEL.quote);
        const amount = u(q, 0);
        const price = u(q, 1);
        return { reserve, burned, amount, price, burnsLeft: amount > 0n ? reserve / amount : 0n };
      } catch (e) {
        return { reserve, burned, error: e.revertName || "Unavailable" };
      }
    },
  };

  /** Token amounts held by a V3 position (float, for display). */
  CL.amountsForLiquidity = function (L, sqrtPriceX96, tickLower, tickUpper) {
    const liq = Number(L);
    const sp = Number(sqrtPriceX96) / 2 ** 96;
    const sa = Math.sqrt(Math.pow(1.0001, tickLower));
    const sb = Math.sqrt(Math.pow(1.0001, tickUpper));
    if (sp <= sa) return [(liq * (sb - sa)) / (sa * sb), 0];
    if (sp >= sb) return [0, liq * (sb - sa)];
    return [(liq * (sb - sp)) / (sp * sb), liq * (sp - sa)];
  };

  // ---------------------------------------------------------------------------
  // Formatting (shared with chain.js; defined here when chain.js is not loaded)
  // ---------------------------------------------------------------------------

  CL.fmt =
    CL.fmt ||
    function (n, max = 2, min = 0) {
      return Number(n).toLocaleString("en-US", { maximumFractionDigits: max, minimumFractionDigits: min });
    };
  CL.usd =
    CL.usd ||
    function (n) {
      if (!isFinite(n)) return "—";
      if (n >= 1000) return "$" + CL.fmt(n / 1000, 1) + "k";
      return "$" + CL.fmt(n, n < 10 ? 2 : 0, n < 10 ? 2 : 0);
    };
})();

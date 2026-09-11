/* Cronos Legends — live LP & fees widget. Requires chain-lite.js.
 *
 * Fills any element carrying data-lp="<field>" inside a [data-lp-widget] container:
 *   tvl, pool-clg, pool-cronus, position-value, position-share, position-clg, position-cronus,
 *   uncollected-clg, uncollected-cronus, uncollected-usd, collected-clg, collected-cronus,
 *   collected-usd, earned-usd, clg-price, updated, position-ids
 * The container gets data-state="loading" | "ready" | "error". Elements with
 * data-lp-needs="history" are hidden when the collected-fees history file is unavailable.
 *
 * Everything is read live from public contracts: the pool's token balances, the project's VVS V3
 * position(s), and the fees they could collect right now (a read-only simulation of collect()).
 * "Collected so far" comes from /assets/data/lp-history.json, rebuilt daily from on-chain events.
 */
(function () {
  "use strict";
  const CL = (window.CL = window.CL || {});

  async function readLp() {
    const cfg = await CL.config();
    const [prices, positions, poolClg, poolCronus, poolLiquidity, history] = await Promise.all([
      CL.lite.prices(),
      CL.lite.lp(),
      CL.lite.balanceOf(cfg.clg, cfg.lp.pool),
      CL.lite.balanceOf(cfg.cronus, cfg.lp.pool),
      CL.lite.liquidity(cfg.lp.pool),
      fetch("/assets/data/lp-history.json", { cache: "no-cache" })
        .then((r) => (r.ok ? r.json() : null))
        .catch(() => null),
    ]);

    let posClg = 0;
    let posCronus = 0;
    let feeClg = 0;
    let feeCronus = 0;
    let posLiquidity = 0n;
    const activeIds = [];
    for (const x of positions) {
      const [a0, a1] = CL.amountsForLiquidity(x.liquidity, prices.slot0.sqrtPriceX96, x.tickLower, x.tickUpper);
      posClg += (x.clgIs0 ? a0 : a1) / 1e18;
      posCronus += (x.clgIs0 ? a1 : a0) / 1e18;
      feeClg += CL.num(x.clgIs0 ? x.owed0 : x.owed1);
      feeCronus += CL.num(x.clgIs0 ? x.owed1 : x.owed0);
      posLiquidity += x.liquidity;
      if (x.liquidity > 0n) activeIds.push(x.id);
    }

    const pClg = CL.num(poolClg);
    const pCronus = CL.num(poolCronus);
    const uncollectedUsd = feeClg * prices.clg + feeCronus * prices.cronus;
    const collectedClg = history ? Number(history.collected.clg) : 0;
    const collectedCronus = history ? Number(history.collected.cronus) : 0;
    const collectedUsd = collectedClg * prices.clg + collectedCronus * prices.cronus;
    return {
      prices,
      tvl: pClg * prices.clg + pCronus * prices.cronus,
      poolClg: pClg,
      poolCronus: pCronus,
      positionValue: posClg * prices.clg + posCronus * prices.cronus,
      positionShare: poolLiquidity > 0n ? Number((posLiquidity * 10000n) / poolLiquidity) / 100 : 0,
      posClg,
      posCronus,
      feeClg,
      feeCronus,
      uncollectedUsd,
      history,
      collectedClg,
      collectedCronus,
      collectedUsd,
      earnedUsd: uncollectedUsd + (history ? collectedUsd : 0),
      activeIds,
    };
  }
  CL.readLp = readLp;

  function set(root, field, text) {
    root.querySelectorAll('[data-lp="' + field + '"]').forEach((el) => (el.textContent = text));
  }

  async function render(root) {
    root.dataset.state = "loading";
    try {
      const d = await readLp();
      const usd = (n) => "$" + CL.fmt(n, n < 100 ? 2 : 0, n < 100 ? 2 : 0);
      set(root, "tvl", usd(d.tvl));
      set(root, "pool-clg", CL.fmt(d.poolClg, 2) + " CLG");
      set(root, "pool-cronus", CL.fmt(d.poolCronus, 0) + " CRONUS");
      set(root, "position-value", usd(d.positionValue));
      set(root, "position-share", CL.fmt(d.positionShare, 2) + "%");
      set(root, "position-clg", CL.fmt(d.posClg, 2) + " CLG");
      set(root, "position-cronus", CL.fmt(d.posCronus, 0) + " CRONUS");
      set(root, "uncollected-clg", CL.fmt(d.feeClg, 5) + " CLG");
      set(root, "uncollected-cronus", CL.fmt(d.feeCronus, 2) + " CRONUS");
      set(root, "uncollected-usd", usd(d.uncollectedUsd));
      set(root, "collected-clg", CL.fmt(d.collectedClg, 5) + " CLG");
      set(root, "collected-cronus", CL.fmt(d.collectedCronus, 2) + " CRONUS");
      set(root, "collected-usd", usd(d.collectedUsd));
      set(root, "earned-usd", usd(d.earnedUsd));
      set(root, "clg-price", usd(d.prices.clg));
      set(root, "position-ids", d.activeIds.map((id) => "#" + id).join(", ") || "—");
      set(root, "updated", new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }));
      root.querySelectorAll('[data-lp-needs="history"]').forEach((el) => (el.hidden = !d.history));
      root.dataset.state = "ready";
    } catch (err) {
      console.warn("LP widget:", err);
      root.dataset.state = "error";
    }
  }

  CL.initLpWidgets = function () {
    document.querySelectorAll("[data-lp-widget]").forEach((root) => {
      render(root);
      root.querySelectorAll("[data-lp-refresh]").forEach((b) => b.addEventListener("click", () => render(root)));
    });
  };

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", CL.initLpWidgets);
  else CL.initLpWidgets();
})();

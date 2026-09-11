/* Cronos Legends — read-only chain access for the website.
 *
 * Loads /assets/data/burn.json, talks to public Cronos RPCs with failover (the official RPC
 * rate-limits bursts and a 429 shows up in browsers as a CORS "Failed to fetch"), and exposes
 * small helpers used by the burn page and the LP widget. Requires window.ethers (vendored v6).
 */
(function () {
  "use strict";
  const CL = (window.CL = window.CL || {});

  const ABI = {
    erc20: ["function balanceOf(address) view returns (uint256)", "function decimals() view returns (uint8)"],
    erc721: [
      "function ownerOf(uint256) view returns (address)",
      "function balanceOf(address) view returns (uint256)",
      "function tokenURI(uint256) view returns (string)",
      "function isApprovedForAll(address,address) view returns (bool)",
      "function safeTransferFrom(address,address,uint256,bytes)",
    ],
    erc721a: ["function tokensOfOwner(address) view returns (uint256[])", "function tokensOfOwnerIn(address,uint256,uint256) view returns (uint256[])"],
    redeemer: [
      "function quote() view returns (uint256 clgAmount, uint256 clgUsdPrice)",
      "function reserveBalance() view returns (uint256)",
      "function totalRedeemed() view returns (uint256)",
      "function totalClgPaid() view returns (uint256)",
      "function outstandingNfts() view returns (uint256)",
      "function backingPerNft() view returns (uint256)",
      "function isEligible(uint256) view returns (bool)",
      "function collection() view returns (address)",
      "function clg() view returns (address)",
      "function oracle() view returns (address)",
      "function owner() view returns (address)",
      "function USD_PER_NFT() view returns (uint256)",
      "function MAX_CLG_PER_NFT() view returns (uint256)",
      "function MIN_TOKEN_ID() view returns (uint256)",
      "function MAX_TOKEN_ID() view returns (uint256)",
      "event Redeemed(address indexed holder, uint256 indexed tokenId, uint256 clgAmount, uint256 clgUsdPrice)",
      // Redeemer
      "error BadConfig()",
      "error WrongCollection(address caller)",
      "error MintsNotAccepted()",
      "error TokenNotEligible(uint256 tokenId)",
      "error AlreadyRedeemed(uint256 tokenId)",
      "error NotReceived(uint256 tokenId)",
      "error InvalidData()",
      "error PayoutBelowMinimum(uint256 payout, uint256 minimum)",
      "error ReserveTooLow(uint256 reserve, uint256 payout)",
      // Oracle (bubbled up through quote())
      "error WarmingUp()",
      "error Stale(uint256 referenceAge)",
      "error LiquidityTooLow(uint256 poolCronus, uint256 inRangeLiquidity)",
      "error PairReservesTooLow(uint256 cronusPairWcro, uint256 croPairUsdc)",
      // NFT contracts (ERC721A for Legends Awaken, OpenZeppelin ERC721 for Elderborn)
      "error TransferToNonERC721ReceiverImplementer()",
      "error TransferFromIncorrectOwner()",
      "error TransferCallerNotOwnerNorApproved()",
      "error OwnerQueryForNonexistentToken()",
      "error ERC721InvalidReceiver(address receiver)",
      "error ERC721IncorrectOwner(address sender, uint256 tokenId, address owner)",
      "error ERC721InsufficientApproval(address operator, uint256 tokenId)",
      "error ERC721NonexistentToken(uint256 tokenId)",
    ],
    oracle: [
      "function clgUsdPrice() view returns (uint256)",
      "function prices() view returns (uint256 longTwapPrice, uint256 shortTwapPrice)",
      "error WarmingUp()",
      "error Stale(uint256 referenceAge)",
      "error LiquidityTooLow(uint256 poolCronus, uint256 inRangeLiquidity)",
      "error PairReservesTooLow(uint256 cronusPairWcro, uint256 croPairUsdc)",
    ],
    v3pool: ["function slot0() view returns (uint160 sqrtPriceX96,int24 tick,uint16,uint16,uint16,uint32,bool)", "function liquidity() view returns (uint128)", "function token0() view returns (address)"],
    v2pair: ["function getReserves() view returns (uint112,uint112,uint32)", "function token0() view returns (address)"],
    nfpm: [
      "function balanceOf(address) view returns (uint256)",
      "function tokenOfOwnerByIndex(address,uint256) view returns (uint256)",
      "function positions(uint256) view returns (uint96 nonce,address operator,address token0,address token1,uint24 fee,int24 tickLower,int24 tickUpper,uint128 liquidity,uint256 feeGrowthInside0LastX128,uint256 feeGrowthInside1LastX128,uint128 tokensOwed0,uint128 tokensOwed1)",
      "function collect((uint256 tokenId,address recipient,uint128 amount0Max,uint128 amount1Max)) returns (uint256 amount0,uint256 amount1)",
    ],
  };
  CL.ABI = ABI;

  let configPromise;
  CL.config = function () {
    configPromise = configPromise || fetch("/assets/data/burn.json", { cache: "no-cache" }).then((r) => {
      if (!r.ok) throw new Error("config " + r.status);
      return r.json();
    });
    return configPromise;
  };

  let providers;
  async function getProviders() {
    if (providers) return providers;
    const cfg = await CL.config();
    const net = ethers.Network.from(cfg.chainId);
    providers = cfg.rpc.map((url) => new ethers.JsonRpcProvider(url, net, { staticNetwork: net, batchMaxCount: 1 }));
    return providers;
  }

  const isRevert = (e) => !!(e && (e.code === "CALL_EXCEPTION" || e.revert || (e.data && typeof e.data === "string")));

  /** Runs fn(provider) against each public RPC in turn until one answers. Reverts are answers. */
  CL.read = async function (fn) {
    const list = await getProviders();
    let last;
    for (const p of list) {
      try {
        return await fn(p);
      } catch (e) {
        if (isRevert(e)) throw e;
        last = e;
      }
    }
    throw last;
  };

  CL.contract = function (address, abi, runner) {
    return new ethers.Contract(address, ABI[abi] || abi, runner);
  };

  /** Name of a custom error in a failed call, if it is one of ours. */
  CL.errorName = function (err) {
    const data = err && (err.data || (err.info && err.info.error && err.info.error.data) || (err.error && err.error.data));
    if (typeof data === "string" && data.length >= 10) {
      try {
        const parsed = new ethers.Interface(ABI.redeemer).parseError(data);
        if (parsed) return parsed.name;
      } catch (_) {
        /* not ours */
      }
    }
    if (err && (err.code === "ACTION_REJECTED" || err.code === 4001)) return "UserRejected";
    return null;
  };

  // ---------------------------------------------------------------------------
  // Prices (for display; burns always use the on-chain oracle)
  // ---------------------------------------------------------------------------

  /** USD prices of CLG, CRONUS and CRO from the same VVS pools the oracle uses (spot). */
  CL.spotPrices = async function () {
    const cfg = await CL.config();
    return CL.read(async (p) => {
      const pool = CL.contract(cfg.lp.pool, "v3pool", p);
      const cw = CL.contract(cfg.pricing.cronusWcroPair, "v2pair", p);
      const wu = CL.contract(cfg.pricing.wcroUsdcPair, "v2pair", p);
      const [slot0, t0, cwRes, cwT0, wuRes, wuT0] = await Promise.all([pool.slot0(), pool.token0(), cw.getReserves(), cw.token0(), wu.getReserves(), wu.token0()]);
      const clgIs0 = t0.toLowerCase() === cfg.clg.toLowerCase();
      const cronusPerClg = clgIs0 ? Math.pow(1.0001, Number(slot0.tick)) : 1 / Math.pow(1.0001, Number(slot0.tick));
      const cronusIs0 = cwT0.toLowerCase() === cfg.cronus.toLowerCase();
      const wcroPerCronus = cronusIs0 ? Number(cwRes[1]) / Number(cwRes[0]) : Number(cwRes[0]) / Number(cwRes[1]);
      const wcroIs0InUsdc = wuT0.toLowerCase() !== "0xc21223249ca28397b4b6541dffaecc539bff0c59";
      const usdPerCro = wcroIs0InUsdc ? Number(wuRes[1]) / 1e6 / (Number(wuRes[0]) / 1e18) : Number(wuRes[0]) / 1e6 / (Number(wuRes[1]) / 1e18);
      const cronus = wcroPerCronus * usdPerCro;
      return { clg: cronusPerClg * cronus, cronus, cro: usdPerCro };
    });
  };

  // ---------------------------------------------------------------------------
  // Formatting
  // ---------------------------------------------------------------------------

  CL.fmt = function (n, max = 2, min = 0) {
    return Number(n).toLocaleString("en-US", { maximumFractionDigits: max, minimumFractionDigits: min });
  };
  CL.fmtUnits = function (wei, decimals = 18, max = 4) {
    return CL.fmt(ethers.formatUnits(wei, decimals), max);
  };
  CL.usd = function (n) {
    if (!isFinite(n)) return "—";
    return "$" + CL.fmt(n, n < 10 ? 2 : 0, n < 10 ? 2 : 0);
  };
  CL.short = function (addr) {
    return addr ? addr.slice(0, 6) + "…" + addr.slice(-4) : "";
  };
  CL.explorer = async function (kind, value) {
    const cfg = await CL.config();
    return cfg.explorer.replace(/\/$/, "") + "/" + kind + "/" + value;
  };
})();

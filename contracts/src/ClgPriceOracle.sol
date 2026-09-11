// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {TickMath} from "@uniswap/v4-core/src/libraries/TickMath.sol";
import {FullMath} from "@uniswap/v4-core/src/libraries/FullMath.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";

import {IClgPriceOracle} from "./interfaces/IClgPriceOracle.sol";
import {IV3PoolLike, IV2PairLike} from "./interfaces/IPools.sol";

/// @title ClgPriceOracle
/// @notice Ownerless, immutable CLG/USD price for the Cronos Legends burn redeemers.
///
/// Route, through three VVS Finance pools:
///   CLG -> CRONUS  (VVS V3 CLG/CRONUS 1% pool, where CLG's liquidity is)
///   CRONUS -> WCRO (VVS V2 CRONUS/WCRO pair)
///   WCRO -> USDC   (VVS V2 WCRO/USDC pair; USDC is counted as $1)
///
/// The contract keeps its own checkpoints of the pools' cumulative price counters. Anyone may record
/// one with poke(), at most once per CHECKPOINT_INTERVAL; the redeemers try to record one after every
/// burn, and a keeper is expected to poke about once an hour. Checkpoints hold cumulative counters, so
/// only the time a price is actually held counts: a price moved and restored inside one block never
/// enters them.
///
/// Published price = the higher of two time-weighted averages:
///   long TWAP  - from the newest checkpoint at least LONG_WINDOW old (24 hours),
///   short TWAP - from the newest checkpoint at least SHORT_WINDOW old (10 minutes).
/// Taking the higher one means a burn never pays more CLG than either average implies. Pushing the
/// payout up would need CLG's price held down for a whole day.
///
/// Pricing reverts (and burns wait) when:
///   - no checkpoint is LONG_WINDOW old yet (the first day after deployment), or a reference checkpoint
///     is more than MAX_STALENESS older than its window (checkpoints stopped arriving);
///   - the CLG/CRONUS pool holds less than MIN_POOL_CRONUS of CRONUS now or at any checkpoint in the
///     long window, or its in-range liquidity is below MIN_IN_RANGE_LIQUIDITY now. The pool balance
///     measures real depth that a narrow position cannot fake cheaply;
///   - either V2 pair's quote-side reserve is below its floor.
/// Most of the CLG/CRONUS liquidity was provided by the Cronos Legends project wallet when this was
/// deployed. If it is withdrawn, pricing stops until it is back and no checkpoint in the window saw it
/// missing.
///
/// There is no owner, no admin and no upgrade path: nothing here can be changed after deployment.
/// Timestamps are stored as uint32, which is valid until the year 2106.
contract ClgPriceOracle is IClgPriceOracle {
    struct Config {
        address clgCronusPool;
        address cronusWcroPair;
        address wcroUsdcPair;
        address clg;
        address cronus;
        address wcro;
        address usdc;
        uint32 longWindow;
        uint32 shortWindow;
        uint32 maxStaleness;
        uint32 checkpointInterval;
        uint96 minPoolCronus;
        uint128 minInRangeLiquidity;
        uint256 minCronusPairWcro;
        uint256 minCroPairUsdc;
    }

    struct Checkpoint {
        uint32 timestamp;
        int56 clgTickCumulative;
        uint96 poolCronus;
        uint256 cronusPriceCumulative;
        uint256 croPriceCumulative;
    }

    /// Checkpoints are kept in a ring buffer; 48 hourly checkpoints cover two days.
    uint256 public constant RING_SIZE = 48;
    uint256 private constant Q112 = 2 ** 112;

    IV3PoolLike public immutable clgCronusPool;
    IV2PairLike public immutable cronusWcroPair;
    IV2PairLike public immutable wcroUsdcPair;
    address public immutable clg;
    address public immutable cronus;
    address public immutable wcro;
    address public immutable usdc;

    uint32 public immutable LONG_WINDOW;
    uint32 public immutable SHORT_WINDOW;
    uint32 public immutable MAX_STALENESS;
    uint32 public immutable CHECKPOINT_INTERVAL;
    /// Minimum CRONUS held by the CLG/CRONUS pool (raw units), now and at every checkpoint in the window.
    uint96 public immutable MIN_POOL_CRONUS;
    /// Minimum in-range liquidity of the CLG/CRONUS pool, now.
    uint128 public immutable MIN_IN_RANGE_LIQUIDITY;
    /// Minimum WCRO reserve of the CRONUS/WCRO pair and USDC reserve of the WCRO/USDC pair (raw units), now.
    uint256 public immutable MIN_CRONUS_PAIR_WCRO;
    uint256 public immutable MIN_CRO_PAIR_USDC;

    bool private immutable clgIsToken0InPool;
    bool private immutable cronusIsToken0InPair;
    bool private immutable wcroIsToken0InUsdcPair;
    uint128 private immutable oneClg;
    uint256 private immutable usdcToE18;

    Checkpoint[RING_SIZE] private _checkpoints;
    uint256 public checkpointCount;
    uint256 public latestIndex;

    event CheckpointRecorded(
        uint256 indexed index,
        uint32 timestamp,
        int56 clgTickCumulative,
        uint96 poolCronus,
        uint256 cronusPriceCumulative,
        uint256 croPriceCumulative
    );

    error WrongPoolTokens();
    error UnsupportedDecimals();
    error BadConfig();
    error WarmingUp();
    error Stale(uint256 referenceAge);
    error LiquidityTooLow(uint256 poolCronus, uint256 inRangeLiquidity);
    error PairReservesTooLow(uint256 cronusPairWcro, uint256 croPairUsdc);

    constructor(Config memory c) {
        if (c.shortWindow == 0 || c.longWindow <= c.shortWindow || c.checkpointInterval == 0) revert BadConfig();
        // With pokes as frequent as allowed, a reference is at most one interval older than its window.
        if (c.maxStaleness < c.checkpointInterval) revert BadConfig();
        // The ring must still hold the long reference when pokes arrive at the maximum rate.
        if ((uint256(c.longWindow) + c.maxStaleness) / c.checkpointInterval + 2 > RING_SIZE) revert BadConfig();

        clgCronusPool = IV3PoolLike(c.clgCronusPool);
        cronusWcroPair = IV2PairLike(c.cronusWcroPair);
        wcroUsdcPair = IV2PairLike(c.wcroUsdcPair);
        clg = c.clg;
        cronus = c.cronus;
        wcro = c.wcro;
        usdc = c.usdc;
        LONG_WINDOW = c.longWindow;
        SHORT_WINDOW = c.shortWindow;
        MAX_STALENESS = c.maxStaleness;
        CHECKPOINT_INTERVAL = c.checkpointInterval;
        MIN_POOL_CRONUS = c.minPoolCronus;
        MIN_IN_RANGE_LIQUIDITY = c.minInRangeLiquidity;
        MIN_CRONUS_PAIR_WCRO = c.minCronusPairWcro;
        MIN_CRO_PAIR_USDC = c.minCroPairUsdc;

        clgIsToken0InPool = _orientation(IV3PoolLike(c.clgCronusPool).token0(), IV3PoolLike(c.clgCronusPool).token1(), c.clg, c.cronus);
        cronusIsToken0InPair = _orientation(IV2PairLike(c.cronusWcroPair).token0(), IV2PairLike(c.cronusWcroPair).token1(), c.cronus, c.wcro);
        wcroIsToken0InUsdcPair = _orientation(IV2PairLike(c.wcroUsdcPair).token0(), IV2PairLike(c.wcroUsdcPair).token1(), c.wcro, c.usdc);

        uint8 clgDecimals = IERC20Metadata(c.clg).decimals();
        uint8 usdcDecimals = IERC20Metadata(c.usdc).decimals();
        if (clgDecimals > 38 || usdcDecimals > 18) revert UnsupportedDecimals();
        oneClg = uint128(10 ** clgDecimals);
        usdcToE18 = 10 ** (18 - usdcDecimals);

        _record();
    }

    /// @notice Explicitly ownerless: there is no admin of any kind.
    function owner() external pure returns (address) {
        return address(0);
    }

    // ---------------------------------------------------------------------
    // Checkpoints
    // ---------------------------------------------------------------------

    /// @notice Records a checkpoint if the last one is at least CHECKPOINT_INTERVAL old.
    /// Anyone may call this; it only stores the pools' public counters and balances.
    function poke() external returns (bool recorded) {
        if (block.timestamp < uint256(_checkpoints[latestIndex].timestamp) + CHECKPOINT_INTERVAL) return false;
        _record();
        return true;
    }

    function checkpoint(uint256 index) external view returns (Checkpoint memory) {
        return _checkpoints[index];
    }

    function latestCheckpoint() external view returns (Checkpoint memory) {
        return _checkpoints[latestIndex];
    }

    // ---------------------------------------------------------------------
    // Prices
    // ---------------------------------------------------------------------

    /// @inheritdoc IClgPriceOracle
    function clgUsdPrice() external view returns (uint256) {
        (uint256 longTwap, uint256 shortTwap) = prices();
        return longTwap > shortTwap ? longTwap : shortTwap;
    }

    /// @notice The two averages the published price is the maximum of, in USD with 18 decimals.
    /// Reverts with WarmingUp, Stale, LiquidityTooLow or PairReservesTooLow when it cannot price safely.
    function prices() public view returns (uint256 longTwapPrice, uint256 shortTwapPrice) {
        State memory s = _state();
        uint128 inRange = clgCronusPool.liquidity();
        if (s.poolCronus < MIN_POOL_CRONUS || inRange < MIN_IN_RANGE_LIQUIDITY) revert LiquidityTooLow(s.poolCronus, inRange);
        if (s.cronusPairWcro < MIN_CRONUS_PAIR_WCRO || s.croPairUsdc < MIN_CRO_PAIR_USDC) {
            revert PairReservesTooLow(s.cronusPairWcro, s.croPairUsdc);
        }

        (uint256 longIdx, uint256 shortIdx, uint96 minPoolCronus) = _references();
        if (minPoolCronus < MIN_POOL_CRONUS) revert LiquidityTooLow(minPoolCronus, inRange);

        longTwapPrice = _twapPrice(s, _checkpoints[longIdx]);
        shortTwapPrice = _twapPrice(s, _checkpoints[shortIdx]);
    }

    /// @notice The checkpoints the long and short averages are currently measured from, and the lowest
    /// pool CRONUS balance recorded from the long reference up to the newest checkpoint.
    function references() external view returns (Checkpoint memory longRef, Checkpoint memory shortRef, uint96 minPoolCronus) {
        (uint256 longIdx, uint256 shortIdx, uint96 minCronus) = _references();
        return (_checkpoints[longIdx], _checkpoints[shortIdx], minCronus);
    }

    // ---------------------------------------------------------------------
    // Internals
    // ---------------------------------------------------------------------

    struct State {
        int56 clgTickCumulative;
        uint96 poolCronus;
        uint256 cronusPriceCumulative;
        uint256 croPriceCumulative;
        uint256 cronusPairWcro;
        uint256 croPairUsdc;
    }

    /// Walks the ring from the newest checkpoint back to the long reference, reading only each
    /// checkpoint's first (packed) slot, and returns the ring indices of both references.
    function _references() private view returns (uint256 longIdx, uint256 shortIdx, uint96 minPoolCronus) {
        uint256 count = checkpointCount;
        uint256 latest = latestIndex;
        bool shortFound;
        minPoolCronus = type(uint96).max;
        for (uint256 i = 0; i < count; ++i) {
            uint256 idx = (latest + RING_SIZE - i) % RING_SIZE;
            Checkpoint storage cp = _checkpoints[idx];
            uint256 age = block.timestamp - cp.timestamp;
            uint96 poolCronus = cp.poolCronus;
            if (poolCronus < minPoolCronus) minPoolCronus = poolCronus;
            if (!shortFound && age >= SHORT_WINDOW) {
                if (age > uint256(SHORT_WINDOW) + MAX_STALENESS) revert Stale(age);
                shortIdx = idx;
                shortFound = true;
            }
            if (age >= LONG_WINDOW) {
                if (age > uint256(LONG_WINDOW) + MAX_STALENESS) revert Stale(age);
                return (idx, shortIdx, minPoolCronus);
            }
        }
        revert WarmingUp();
    }

    function _twapPrice(State memory s, Checkpoint storage ref) private view returns (uint256) {
        uint32 elapsed = uint32(block.timestamp) - ref.timestamp;
        int24 avgTick = _averageTick(s.clgTickCumulative, ref.clgTickCumulative, elapsed);
        uint256 cronusTwap;
        uint256 croTwap;
        unchecked {
            cronusTwap = (s.cronusPriceCumulative - ref.cronusPriceCumulative) / elapsed;
            croTwap = (s.croPriceCumulative - ref.croPriceCumulative) / elapsed;
        }
        return _usdPrice(avgTick, cronusTwap, croTwap);
    }

    function _record() private {
        State memory s = _state();
        uint256 idx = checkpointCount == 0 ? 0 : (latestIndex + 1) % RING_SIZE;
        _checkpoints[idx] = Checkpoint({
            timestamp: uint32(block.timestamp),
            clgTickCumulative: s.clgTickCumulative,
            poolCronus: s.poolCronus,
            cronusPriceCumulative: s.cronusPriceCumulative,
            croPriceCumulative: s.croPriceCumulative
        });
        latestIndex = idx;
        if (checkpointCount < RING_SIZE) checkpointCount += 1;
        emit CheckpointRecorded(idx, uint32(block.timestamp), s.clgTickCumulative, s.poolCronus, s.cronusPriceCumulative, s.croPriceCumulative);
    }

    function _state() private view returns (State memory s) {
        uint32[] memory secondsAgos = new uint32[](1);
        (int56[] memory tickCumulatives,) = clgCronusPool.observe(secondsAgos);
        s.clgTickCumulative = tickCumulatives[0];

        uint256 bal = IERC20Metadata(cronus).balanceOf(address(clgCronusPool));
        s.poolCronus = bal > type(uint96).max ? type(uint96).max : uint96(bal);

        // WCRO per CRONUS, and USDC per WCRO, both UQ112x112 cumulatives in raw token units.
        (s.cronusPriceCumulative, s.cronusPairWcro) = _v2(cronusWcroPair, cronusIsToken0InPair);
        (s.croPriceCumulative, s.croPairUsdc) = _v2(wcroUsdcPair, wcroIsToken0InUsdcPair);
    }

    /// Current cumulative price of `base` (in units of the pair's other token), following the Uniswap V2
    /// oracle library: extend the stored cumulative to now using the current reserves. Overflow of the
    /// cumulative is intended and handled with unchecked math. Also returns the other token's reserve.
    function _v2(IV2PairLike pair, bool baseIsToken0) private view returns (uint256 cumulative, uint256 quoteReserve) {
        (uint112 r0, uint112 r1, uint32 tsLast) = pair.getReserves();
        cumulative = baseIsToken0 ? pair.price0CumulativeLast() : pair.price1CumulativeLast();
        quoteReserve = baseIsToken0 ? r1 : r0;
        uint32 ts = uint32(block.timestamp);
        if (tsLast != ts) {
            uint256 spot = baseIsToken0 ? (uint256(r1) << 112) / r0 : (uint256(r0) << 112) / r1;
            unchecked {
                cumulative += spot * (ts - tsLast);
            }
        }
    }

    function _averageTick(int56 nowCumulative, int56 thenCumulative, uint32 elapsed) private pure returns (int24) {
        int56 delta = nowCumulative - thenCumulative;
        int56 period = int56(uint56(elapsed));
        int56 avg = delta / period;
        // Round toward negative infinity, as the Uniswap V3 oracle library does.
        if (delta < 0 && (delta % period != 0)) avg--;
        return int24(avg);
    }

    /// USD price of one CLG with 18 decimals.
    function _usdPrice(int24 tick, uint256 wcroPerCronusX112, uint256 usdcPerWcroX112) private view returns (uint256) {
        uint256 cronusPerClg = _quoteAtTick(tick, oneClg, clgIsToken0InPool);
        uint256 wcroPerClg = FullMath.mulDiv(cronusPerClg, wcroPerCronusX112, Q112);
        uint256 usdcPerClg = FullMath.mulDiv(wcroPerClg, usdcPerWcroX112, Q112);
        return usdcPerClg * usdcToE18;
    }

    /// Amount of the pool's other token worth `baseAmount` of the base token at `tick`.
    function _quoteAtTick(int24 tick, uint128 baseAmount, bool baseIsToken0) private pure returns (uint256 quote) {
        uint160 sqrtPriceX96 = TickMath.getSqrtPriceAtTick(tick);
        if (sqrtPriceX96 <= type(uint128).max) {
            uint256 ratioX192 = uint256(sqrtPriceX96) * sqrtPriceX96;
            quote = baseIsToken0
                ? FullMath.mulDiv(ratioX192, baseAmount, 1 << 192)
                : FullMath.mulDiv(1 << 192, baseAmount, ratioX192);
        } else {
            uint256 ratioX128 = FullMath.mulDiv(sqrtPriceX96, sqrtPriceX96, 1 << 64);
            quote = baseIsToken0
                ? FullMath.mulDiv(ratioX128, baseAmount, 1 << 128)
                : FullMath.mulDiv(1 << 128, baseAmount, ratioX128);
        }
    }

    /// Returns true when `base` is token0; reverts unless the pool is exactly {base, other}.
    function _orientation(address token0, address token1, address base, address other) private pure returns (bool) {
        if (token0 == base && token1 == other) return true;
        if (token0 == other && token1 == base) return false;
        revert WrongPoolTokens();
    }
}

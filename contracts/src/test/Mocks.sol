// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {ERC721} from "@openzeppelin/contracts/token/ERC721/ERC721.sol";
import {IERC721Receiver} from "@openzeppelin/contracts/token/ERC721/IERC721Receiver.sol";

/// Test-only contracts. Never deployed to mainnet.

contract MockERC20 is ERC20 {
    uint8 private immutable _decimals;

    constructor(string memory name_, string memory symbol_, uint8 decimals_) ERC20(name_, symbol_) {
        _decimals = decimals_;
    }

    function decimals() public view override returns (uint8) {
        return _decimals;
    }

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }
}

contract MockERC721 is ERC721 {
    constructor() ERC721("Mock Legends", "MOCK") {}

    function mint(address to, uint256 tokenId) external {
        _mint(to, tokenId);
    }

    function safeMint(address to, uint256 tokenId) external {
        _safeMint(to, tokenId);
    }
}

/// Emulates the cumulative accounting of a Uniswap-V3-style pool well enough for the oracle:
/// tickCumulative and secondsPerLiquidityCumulativeX128 accrue with time at the current tick
/// and liquidity; observe([0]) extrapolates to now.
contract MockV3Pool {
    address public token0;
    address public token1;
    int24 public tick;
    uint128 public liquidity;
    int56 public tickCumulative;
    uint160 public secondsPerLiquidityX128;
    uint32 public lastTimestamp;

    constructor(address token0_, address token1_, int24 tick_, uint128 liquidity_) {
        token0 = token0_;
        token1 = token1_;
        tick = tick_;
        liquidity = liquidity_;
        lastTimestamp = uint32(block.timestamp);
    }

    function _accrue() internal {
        uint32 nowTs = uint32(block.timestamp);
        uint32 delta = nowTs - lastTimestamp;
        if (delta > 0) {
            tickCumulative += int56(tick) * int56(uint56(delta));
            unchecked {
                secondsPerLiquidityX128 += uint160((uint256(delta) << 128) / (liquidity > 0 ? liquidity : 1));
            }
            lastTimestamp = nowTs;
        }
    }

    function setTick(int24 tick_) external {
        _accrue();
        tick = tick_;
    }

    function setLiquidity(uint128 liquidity_) external {
        _accrue();
        liquidity = liquidity_;
    }

    /// Moves tokens the "pool" holds, to simulate liquidity being withdrawn or added back.
    function sweep(address token, address to, uint256 amount) external {
        ERC20(token).transfer(to, amount);
    }

    function slot0() external view returns (uint160, int24, uint16, uint16, uint16, uint32, bool) {
        return (0, tick, 0, 1, 1, 0, true);
    }

    function observe(uint32[] calldata secondsAgos) external view returns (int56[] memory tc, uint160[] memory spl) {
        require(secondsAgos.length == 1 && secondsAgos[0] == 0, "mock: only observe([0])");
        tc = new int56[](1);
        spl = new uint160[](1);
        uint32 delta = uint32(block.timestamp) - lastTimestamp;
        tc[0] = tickCumulative + int56(tick) * int56(uint56(delta));
        unchecked {
            spl[0] = secondsPerLiquidityX128 + uint160((uint256(delta) << 128) / (liquidity > 0 ? liquidity : 1));
        }
    }
}

/// Emulates a Uniswap-V2-style pair's reserves and cumulative prices.
contract MockV2Pair {
    address public token0;
    address public token1;
    uint112 private reserve0;
    uint112 private reserve1;
    uint32 private blockTimestampLast;
    uint256 public price0CumulativeLast;
    uint256 public price1CumulativeLast;

    constructor(address token0_, address token1_, uint112 r0, uint112 r1) {
        token0 = token0_;
        token1 = token1_;
        reserve0 = r0;
        reserve1 = r1;
        blockTimestampLast = uint32(block.timestamp);
    }

    function setReserves(uint112 r0, uint112 r1) external {
        uint32 ts = uint32(block.timestamp);
        unchecked {
            uint32 elapsed = ts - blockTimestampLast;
            if (elapsed > 0 && reserve0 != 0 && reserve1 != 0) {
                price0CumulativeLast += ((uint256(reserve1) << 112) / reserve0) * elapsed;
                price1CumulativeLast += ((uint256(reserve0) << 112) / reserve1) * elapsed;
            }
        }
        reserve0 = r0;
        reserve1 = r1;
        blockTimestampLast = ts;
    }

    function getReserves() external view returns (uint112, uint112, uint32) {
        return (reserve0, reserve1, blockTimestampLast);
    }
}

contract MockOracle {
    uint256 public price;
    bool public shouldRevert;
    uint256 public pokes;

    constructor(uint256 price_) {
        price = price_;
    }

    function setPrice(uint256 price_) external {
        price = price_;
    }

    function setRevert(bool r) external {
        shouldRevert = r;
    }

    function clgUsdPrice() external view returns (uint256) {
        require(!shouldRevert, "mock: oracle down");
        return price;
    }

    function poke() external returns (bool) {
        pokes += 1;
        return true;
    }
}

interface IOracleView {
    function clgUsdPrice() external view returns (uint256);
}

/// Moves the V3 tick and reads the oracle in the same transaction (same block).
contract SameBlockManipulator {
    function crashAndRead(MockV3Pool pool, IOracleView oracle, int24 tick) external returns (uint256) {
        pool.setTick(tick);
        return oracle.clgUsdPrice();
    }
}

/// Tries to call the redeemer's receiver hook directly, impersonating a collection.
contract HookCaller {
    function callHook(address target, address from, uint256 tokenId) external returns (bytes4) {
        return IERC721Receiver(target).onERC721Received(msg.sender, from, tokenId, "");
    }
}

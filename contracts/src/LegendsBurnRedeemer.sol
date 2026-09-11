// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {IERC721} from "@openzeppelin/contracts/token/ERC721/IERC721.sol";
import {IERC721Receiver} from "@openzeppelin/contracts/token/ERC721/IERC721Receiver.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";

import {IClgPriceOracle} from "./interfaces/IClgPriceOracle.sol";

/// @title LegendsBurnRedeemer
/// @notice Burn one Cronos Legends NFT and receive $CLG from this contract's reserve in the same transaction.
///
/// How to burn: call `safeTransferFrom(yourAddress, <this contract>, tokenId)` on the NFT contract,
/// ideally with `data = abi.encode(minClgOut)` so the burn reverts instead of paying less than you
/// expect. In that same transaction this contract forwards the NFT to
/// 0x000000000000000000000000000000000000dEaD and pays the previous owner `payout()` CLG from its own
/// balance. No approval, signature, allowlist or team action is involved. Only safeTransferFrom pays:
/// a plain transferFrom or batch transfer moves the NFT here with no payment and it cannot be recovered.
///
/// Payout per NFT = min(USD_PER_NFT / P, MAX_CLG_PER_NFT), where P is the ClgPriceOracle price: the
/// higher of CLG's 24-hour and ~10-minute time-weighted averages. At the current market price the
/// payout can be worth less than USD_PER_NFT (after a sharp fall, or when the ceiling applies).
/// First come, first served while this contract holds at least one payout.
///
/// This contract has no owner and no admin functions; nothing can be changed or upgraded. Its CLG can
/// leave only as burn payouts: there is no withdraw, rescue, sweep, pause function, cap, window or queue.
/// Burns revert (and the NFT stays with its owner) whenever the oracle cannot price safely — see
/// ClgPriceOracle for when that happens.
contract LegendsBurnRedeemer is IERC721Receiver, ReentrancyGuard {
    using SafeERC20 for IERC20;

    address public constant BURN_ADDRESS = 0x000000000000000000000000000000000000dEaD;

    IERC721 public immutable collection;
    IERC20 public immutable clg;
    IClgPriceOracle public immutable oracle;
    /// USD value paid per burned NFT, 18 decimals (35e18 = $35).
    uint256 public immutable USD_PER_NFT;
    /// Hard ceiling on CLG paid per NFT, in CLG base units.
    uint256 public immutable MAX_CLG_PER_NFT;
    /// Only token IDs in [MIN_TOKEN_ID, MAX_TOKEN_ID] can be burned for CLG. Tokens minted
    /// later with higher IDs are never eligible.
    uint256 public immutable MIN_TOKEN_ID;
    uint256 public immutable MAX_TOKEN_ID;
    /// Recorded so anyone can tell a holder's burn apart from the deployer's.
    address public immutable deployer;

    uint256 private immutable oneClg;

    uint256 public totalRedeemed;
    uint256 public totalClgPaid;
    mapping(uint256 tokenId => bool) public redeemed;

    event Redeemed(address indexed holder, uint256 indexed tokenId, uint256 clgAmount, uint256 clgUsdPrice);

    error BadConfig();
    error WrongCollection(address caller);
    error MintsNotAccepted();
    error TokenNotEligible(uint256 tokenId);
    error AlreadyRedeemed(uint256 tokenId);
    error NotReceived(uint256 tokenId);
    error InvalidData();
    error PayoutBelowMinimum(uint256 payout, uint256 minimum);
    error ReserveTooLow(uint256 reserve, uint256 payout);

    constructor(
        IERC721 collection_,
        IERC20 clg_,
        IClgPriceOracle oracle_,
        uint256 usdPerNft_,
        uint256 maxClgPerNft_,
        uint256 minTokenId_,
        uint256 maxTokenId_
    ) {
        if (
            address(collection_).code.length == 0 || address(clg_).code.length == 0 || address(oracle_).code.length == 0
                || usdPerNft_ == 0 || maxClgPerNft_ == 0 || minTokenId_ > maxTokenId_
        ) revert BadConfig();

        collection = collection_;
        clg = clg_;
        oracle = oracle_;
        USD_PER_NFT = usdPerNft_;
        MAX_CLG_PER_NFT = maxClgPerNft_;
        MIN_TOKEN_ID = minTokenId_;
        MAX_TOKEN_ID = maxTokenId_;
        deployer = msg.sender;
        oneClg = 10 ** IERC20Metadata(address(clg_)).decimals();
    }

    /// @notice Explicitly ownerless: there is no admin of any kind.
    function owner() external pure returns (address) {
        return address(0);
    }

    // ---------------------------------------------------------------------
    // Views
    // ---------------------------------------------------------------------

    /// @notice CLG paid for one NFT right now, and the CLG/USD price (18 decimals) used.
    function quote() public view returns (uint256 clgAmount, uint256 clgUsdPrice) {
        clgUsdPrice = oracle.clgUsdPrice();
        clgAmount = Math.min(Math.mulDiv(USD_PER_NFT, oneClg, clgUsdPrice), MAX_CLG_PER_NFT);
    }

    /// @notice CLG paid for one NFT right now.
    function payout() external view returns (uint256 clgAmount) {
        (clgAmount,) = quote();
    }

    /// @notice CLG available for payouts (this contract's whole CLG balance).
    function reserveBalance() public view returns (uint256) {
        return clg.balanceOf(address(this));
    }

    /// @notice How many burns the current reserve covers at the current payout.
    function burnsAvailable() external view returns (uint256) {
        (uint256 clgAmount,) = quote();
        return reserveBalance() / clgAmount;
    }

    /// @notice Approximate number of eligible NFTs not yet burned: the eligible ID range minus all
    /// tokens held by the burn address or stuck in this contract (saturating at zero). Tokens outside
    /// the range held by those addresses, or destroyed with the collection's own burn(), make this an
    /// approximation.
    function outstandingNfts() public view returns (uint256) {
        uint256 range = MAX_TOKEN_ID - MIN_TOKEN_ID + 1;
        uint256 gone = collection.balanceOf(BURN_ADDRESS) + collection.balanceOf(address(this));
        return gone >= range ? 0 : range - gone;
    }

    /// @notice CLG backing per outstanding NFT: min(payout, reserve / outstanding NFTs).
    function backingPerNft() external view returns (uint256) {
        (uint256 clgAmount,) = quote();
        uint256 outstanding = outstandingNfts();
        uint256 reserve = reserveBalance();
        if (outstanding == 0) return Math.min(clgAmount, reserve);
        return Math.min(clgAmount, reserve / outstanding);
    }

    /// @notice Whether `tokenId` can still be burned here for CLG: in the eligible range, not paid out
    /// before, and not sitting at the burn address or in this contract. Ignores reserve and price.
    function isEligible(uint256 tokenId) external view returns (bool) {
        if (tokenId < MIN_TOKEN_ID || tokenId > MAX_TOKEN_ID || redeemed[tokenId]) return false;
        try collection.ownerOf(tokenId) returns (address holder) {
            return holder != BURN_ADDRESS && holder != address(this);
        } catch {
            return false;
        }
    }

    // ---------------------------------------------------------------------
    // Burn
    // ---------------------------------------------------------------------

    /// @notice Called by the NFT contract during safeTransferFrom. Burns the NFT and pays CLG
    /// to its previous owner. Any failure reverts the whole transfer, so the NFT stays put.
    function onERC721Received(address, address from, uint256 tokenId, bytes calldata data)
        external
        nonReentrant
        returns (bytes4)
    {
        if (msg.sender != address(collection)) revert WrongCollection(msg.sender);
        if (from == address(0)) revert MintsNotAccepted();
        if (tokenId < MIN_TOKEN_ID || tokenId > MAX_TOKEN_ID) revert TokenNotEligible(tokenId);
        if (redeemed[tokenId]) revert AlreadyRedeemed(tokenId);
        if (collection.ownerOf(tokenId) != address(this)) revert NotReceived(tokenId);

        (uint256 clgAmount, uint256 clgUsdPrice) = quote();
        if (data.length != 0) {
            if (data.length != 32) revert InvalidData();
            uint256 minClgOut = abi.decode(data, (uint256));
            if (clgAmount < minClgOut) revert PayoutBelowMinimum(clgAmount, minClgOut);
        }
        uint256 reserve = clg.balanceOf(address(this));
        if (reserve < clgAmount) revert ReserveTooLow(reserve, clgAmount);

        redeemed[tokenId] = true;
        totalRedeemed += 1;
        totalClgPaid += clgAmount;

        collection.transferFrom(address(this), BURN_ADDRESS, tokenId);
        clg.safeTransfer(from, clgAmount);
        emit Redeemed(from, tokenId, clgAmount, clgUsdPrice);

        // Keep the oracle's checkpoints fresh. A failure here must not block a valid burn.
        try oracle.poke() {} catch {}

        return IERC721Receiver.onERC721Received.selector;
    }
}

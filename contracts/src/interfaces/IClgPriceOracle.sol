// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

interface IClgPriceOracle {
    /// @notice USD value of one whole CLG, with 18 decimals.
    function clgUsdPrice() external view returns (uint256);

    /// @notice Records a price checkpoint if one is due. Permissionless.
    function poke() external returns (bool recorded);
}

// Builds constructor arguments from deploy/addresses.json. Shared by the fork tests and scripts;
// deploy/deploy.html mirrors the same mapping in the browser.
const { ethers } = require("ethers");

function oracleConfig(A) {
  const o = A.oracle;
  return {
    clgCronusPool: o.clgCronusPool,
    cronusWcroPair: o.cronusWcroPair,
    wcroUsdcPair: o.wcroUsdcPair,
    clg: A.tokens.CLG,
    cronus: A.tokens.CRONUS,
    wcro: A.tokens.WCRO,
    usdc: A.tokens.USDC,
    longWindow: o.longWindowSeconds,
    shortWindow: o.shortWindowSeconds,
    maxStaleness: o.maxStalenessSeconds,
    checkpointInterval: o.checkpointIntervalSeconds,
    minPoolCronus: BigInt(o.minPoolCronus),
    minInRangeLiquidity: BigInt(o.minInRangeLiquidity),
    minCronusPairWcro: BigInt(o.minCronusPairWcro),
    minCroPairUsdc: BigInt(o.minCroPairUsdc),
  };
}

function redeemerArgs(A, key, oracleAddress) {
  const c = A.collections[key];
  if (!c.address || c.minTokenId == null) throw new Error(`${key}: collection address / minTokenId not set`);
  return [c.address, A.tokens.CLG, oracleAddress, ethers.parseUnits(c.usdPerNft, 18), ethers.parseUnits(c.maxClgPerNft, 18), c.minTokenId, c.maxTokenId];
}

module.exports = { oracleConfig, redeemerArgs };

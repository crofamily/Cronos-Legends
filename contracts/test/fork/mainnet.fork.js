// Fork tests against live Cronos mainnet state. Run with:
//   PowerShell:  $env:FORK="1"; npx hardhat test test/fork/mainnet.fork.js
//   bash:        FORK=1 npx hardhat test test/fork/mainnet.fork.js
const { expect } = require("chai");
const { ethers, network } = require("hardhat");
const { time } = require("@nomicfoundation/hardhat-network-helpers");
const A = require("../../deploy/addresses.json");
const { oracleConfig, redeemerArgs } = require("../../scripts/config");

const E18 = 10n ** 18n;
const DEAD = "0x000000000000000000000000000000000000dEaD";
const abi = ethers.AbiCoder.defaultAbiCoder();
const SAFE_DATA = "safeTransferFrom(address,address,uint256,bytes)";

const TREASURY = "0xAF87e4Df58D735ec2971d2D8Db663B02cA60175D";
const NFPM = "0xc2DDB059FEc2afa593dFF9c70Fda2cfABe9b4eC8";
const LP_TOKEN_ID = 49804n;

async function impersonate(addr) {
  await network.provider.request({ method: "hardhat_impersonateAccount", params: [addr] });
  await network.provider.send("hardhat_setBalance", [addr, "0x" + (10n ** 21n).toString(16)]);
  return ethers.getSigner(addr);
}

const ERC20 = ["function balanceOf(address) view returns (uint256)", "function transfer(address,uint256) returns (bool)"];
const ERC721A = [
  "function ownerOf(uint256) view returns (address)",
  "function safeTransferFrom(address,address,uint256,bytes)",
];

describe("mainnet fork: oracle + redeemers on real VVS pools and Legends Awaken NFTs", function () {
  let oracle, la1Redeemer, la2Redeemer, clg, la1, la2;

  before(async function () {
    if (!process.env.FORK) this.skip();
    await network.provider.send("evm_mine", []); // local block, so the hardfork table applies

    clg = new ethers.Contract(A.tokens.CLG, ERC20, ethers.provider);
    la1 = new ethers.Contract(A.collections.legendsAwaken1.address, ERC721A, ethers.provider);
    la2 = new ethers.Contract(A.collections.legendsAwaken2.address, ERC721A, ethers.provider);

    oracle = await (await ethers.getContractFactory("ClgPriceOracle")).deploy(oracleConfig(A));
    const R = await ethers.getContractFactory("LegendsBurnRedeemer");
    la1Redeemer = await R.deploy(...redeemerArgs(A, "legendsAwaken1", await oracle.getAddress()));
    la2Redeemer = await R.deploy(...redeemerArgs(A, "legendsAwaken2", await oracle.getAddress()));

    const treasury = await impersonate(TREASURY);
    await clg.connect(treasury).transfer(la1Redeemer, E18);
    await clg.connect(treasury).transfer(la2Redeemer, E18);
  });

  it("warms up over a day of hourly checkpoints, then prices CLG close to the live market (~$300-330)", async function () {
    await expect(oracle.clgUsdPrice()).to.be.revertedWithCustomError(oracle, "WarmingUp");
    for (let i = 0; i < 25; i++) {
      await time.increase(3600);
      await oracle.poke();
    }
    await time.increase(11 * 60);
    const [longTwap, shortTwap] = await oracle.prices();
    const price = Number(ethers.formatUnits(await oracle.clgUsdPrice(), 18));
    console.log(`      CLG/USD long=$${ethers.formatUnits(longTwap, 18)} short=$${ethers.formatUnits(shortTwap, 18)}`);
    expect(price).to.be.within(100, 1000);
    // Nothing traded on the fork during the window, so both averages agree up to rounding.
    expect(Number(longTwap)).to.be.closeTo(Number(shortTwap), Number(shortTwap) * 1e-3);
  });

  it("burns a real Legends Awaken I NFT for $35 of CLG in one transaction", async function () {
    const holderAddr = await la1.ownerOf(1);
    const holder = await impersonate(holderAddr);
    const [amount, price] = await la1Redeemer.quote();
    const usdValue = (Number(amount) / 1e18) * (Number(price) / 1e18);
    expect(usdValue).to.be.closeTo(35, 0.01);
    const before = await clg.balanceOf(holderAddr);
    const minOut = (amount * 98n) / 100n;
    const tx = await la1.connect(holder)[SAFE_DATA](holderAddr, la1Redeemer, 1, abi.encode(["uint256"], [minOut]));
    const rc = await tx.wait();
    console.log(`      LA1 #1: paid ${ethers.formatUnits(amount, 18)} CLG, gas ${rc.gasUsed}`);
    expect(await la1.ownerOf(1)).to.equal(DEAD);
    expect((await clg.balanceOf(holderAddr)) - before).to.equal(amount);
    expect(await la1Redeemer.totalRedeemed()).to.equal(1n);
    expect(await la1Redeemer.isEligible(1)).to.equal(false);
  });

  it("burns a real Legends Awaken II NFT", async function () {
    const ownerOf1 = await la2.ownerOf(1);
    const holder = await impersonate(ownerOf1);
    const [amount] = await la2Redeemer.quote();
    const before = await clg.balanceOf(ownerOf1);
    await la2.connect(holder)[SAFE_DATA](ownerOf1, la2Redeemer, 1, "0x");
    expect(await la2.ownerOf(1)).to.equal(DEAD);
    expect((await clg.balanceOf(ownerOf1)) - before).to.equal(amount);
  });

  it("an NFT from the other collection is refused", async function () {
    const holderAddr = await la1.ownerOf(2);
    const holder = await impersonate(holderAddr);
    await expect(la1.connect(holder)[SAFE_DATA](holderAddr, la2Redeemer, 2, "0x")).to.be.revertedWithCustomError(la2Redeemer, "WrongCollection");
  });

  it("stops (instead of mispricing) while the treasury's CLG/CRONUS liquidity is mostly withdrawn", async function () {
    const treasury = await impersonate(TREASURY);
    const nfpm = new ethers.Contract(NFPM, [
      "function positions(uint256) view returns (uint96,address,address,address,uint24,int24,int24,uint128,uint256,uint256,uint128,uint128)",
      "function decreaseLiquidity((uint256 tokenId,uint128 liquidity,uint256 amount0Min,uint256 amount1Min,uint256 deadline)) returns (uint256,uint256)",
    ], treasury);
    const liq = (await nfpm.positions(LP_TOKEN_ID))[7];
    await nfpm.decreaseLiquidity({ tokenId: LP_TOKEN_ID, liquidity: (liq * 80n) / 100n, amount0Min: 0, amount1Min: 0, deadline: 2n ** 40n });
    await expect(oracle.clgUsdPrice()).to.be.revertedWithCustomError(oracle, "LiquidityTooLow");

    const holderAddr = await la1.ownerOf(2);
    const holder = await impersonate(holderAddr);
    await expect(la1.connect(holder)[SAFE_DATA](holderAddr, la1Redeemer, 2, "0x")).to.be.reverted;
    expect(await la1.ownerOf(2)).to.equal(holderAddr);
  });
});

const { expect } = require("chai");
const { ethers } = require("hardhat");
const { time } = require("@nomicfoundation/hardhat-network-helpers");

const MIN = 60;
const HOUR = 3600;
const DAY = 86400;
const E18 = 10n ** 18n;

// Today's state (Sept 2026), rounded.
const TICK = 114076; // ~89,959 CRONUS per CLG
const POOL_LIQ = 27_648n * E18; // ~2.76e22 in-range liquidity
const POOL_CRONUS = 8_292_877n * E18;
const CRONUS_WCRO = { wcro: 1_150_815n * E18, cronus: 18_855_869n * E18 };
const WCRO_USDC = { wcro: 50_771_841n * E18, usdc: 2_889_349n * 10n ** 6n };

const FLOORS = {
  minPoolCronus: 3_000_000n * E18,
  minInRangeLiquidity: 10n ** 22n,
  minCronusPairWcro: 300_000n * E18,
  minCroPairUsdc: 300_000n * 10n ** 6n,
};

function expectedPrice(tick, cw = CRONUS_WCRO, wu = WCRO_USDC) {
  const cronusPerClg = Math.pow(1.0001, tick);
  const wcroPerCronus = Number(cw.wcro) / Number(cw.cronus);
  const usdPerWcro = Number(wu.usdc) / 1e6 / (Number(wu.wcro) / 1e18);
  return cronusPerClg * wcroPerCronus * usdPerWcro; // USD per CLG
}

const usd = (x) => Number(ethers.formatUnits(x, 18));

function config(f, overrides = {}) {
  return {
    clgCronusPool: f.pool.target,
    cronusWcroPair: f.pairB.target,
    wcroUsdcPair: f.pairC.target,
    clg: f.clg.target,
    cronus: f.cronus.target,
    wcro: f.wcro.target,
    usdc: f.usdc.target,
    longWindow: DAY,
    shortWindow: 10 * MIN,
    maxStaleness: 6 * HOUR,
    checkpointInterval: HOUR,
    ...FLOORS,
    ...overrides,
  };
}

async function deployFixture() {
  const T = await ethers.getContractFactory("MockERC20");
  const clg = await T.deploy("Cronos Legends", "CLG", 18);
  const cronus = await T.deploy("CRONUS", "CRONUS", 18);
  const wcro = await T.deploy("Wrapped CRO", "WCRO", 18);
  const usdc = await T.deploy("USD Coin", "USDC", 6);

  const pool = await (await ethers.getContractFactory("MockV3Pool")).deploy(clg, cronus, TICK, POOL_LIQ);
  await cronus.mint(pool, POOL_CRONUS);
  const V2 = await ethers.getContractFactory("MockV2Pair");
  // Real pairs: CRONUS/WCRO has token0 = WCRO; WCRO/USDC has token0 = WCRO.
  const pairB = await V2.deploy(wcro, cronus, CRONUS_WCRO.wcro, CRONUS_WCRO.cronus);
  const pairC = await V2.deploy(wcro, usdc, WCRO_USDC.wcro, WCRO_USDC.usdc);

  const Oracle = await ethers.getContractFactory("ClgPriceOracle");
  const f = { clg, cronus, wcro, usdc, pool, pairB, pairC, Oracle };
  f.oracle = await Oracle.deploy(config(f));
  return f;
}

/// Advances time by `hours`, poking once an hour like the keeper does.
async function run(oracle, hours) {
  for (let i = 0; i < hours; i++) {
    await time.increase(HOUR);
    await oracle.poke();
  }
}

/// Warm oracle: 25 hourly pokes, then 11 minutes so the newest checkpoint can serve the short average.
async function warm(f) {
  await run(f.oracle, 25);
  await time.increase(11 * MIN);
}

describe("ClgPriceOracle", function () {
  it("is ownerless and records a checkpoint at deployment", async function () {
    const { oracle } = await deployFixture();
    expect(await oracle.owner()).to.equal(ethers.ZeroAddress);
    expect(await oracle.checkpointCount()).to.equal(1n);
  });

  it("refuses to price during the first day (warming up), then prices", async function () {
    const f = await deployFixture();
    await run(f.oracle, 23);
    await time.increase(11 * MIN);
    await expect(f.oracle.clgUsdPrice()).to.be.revertedWithCustomError(f.oracle, "WarmingUp");
    await run(f.oracle, 1);
    await time.increase(11 * MIN);
    await f.oracle.clgUsdPrice();
  });

  it("walks CLG -> CRONUS -> WCRO -> USDC correctly (~$312 today)", async function () {
    const f = await deployFixture();
    await warm(f);
    const [longTwap, shortTwap] = await f.oracle.prices();
    const expected = expectedPrice(TICK);
    expect(usd(longTwap)).to.be.closeTo(expected, expected * 1e-4);
    expect(usd(shortTwap)).to.be.closeTo(expected, expected * 1e-4);
    expect(usd(await f.oracle.clgUsdPrice())).to.be.closeTo(expected, expected * 1e-4);
    expect(expected).to.be.within(300, 330);
  });

  it("works when the V3 pool has CLG as token1", async function () {
    const f = await deployFixture();
    const flipped = await (await ethers.getContractFactory("MockV3Pool")).deploy(f.cronus, f.clg, -TICK, POOL_LIQ);
    await f.cronus.mint(flipped, POOL_CRONUS);
    const oracle = await f.Oracle.deploy(config(f, { clgCronusPool: flipped.target }));
    await run(oracle, 25);
    await time.increase(11 * MIN);
    const expected = expectedPrice(TICK);
    expect(usd(await oracle.clgUsdPrice())).to.be.closeTo(expected, expected * 1e-3);
  });

  it("a price moved and read inside one block does not change the published price", async function () {
    const f = await deployFixture();
    await warm(f);
    const before = await f.oracle.clgUsdPrice();
    const m = await (await ethers.getContractFactory("SameBlockManipulator")).deploy();
    const during = await m.crashAndRead.staticCall(f.pool, f.oracle, TICK - 23027); // CLG price / 10
    expect(during).to.equal(before);
  });

  it("a one-hour crash barely moves the published price (the 24h average wins)", async function () {
    const f = await deployFixture();
    await warm(f);
    await f.pool.setTick(TICK - 6932); // CLG price halves
    await run(f.oracle, 1);
    await time.increase(11 * MIN);
    const [longTwap, shortTwap] = await f.oracle.prices();
    const p = expectedPrice(TICK);
    expect(usd(shortTwap)).to.be.lessThan(p * 0.8);
    expect(usd(longTwap)).to.be.greaterThan(p * 0.96);
    expect(await f.oracle.clgUsdPrice()).to.equal(longTwap);
  });

  it("a rally is reflected quickly (the short average wins, fewer CLG paid)", async function () {
    const f = await deployFixture();
    await warm(f);
    await f.pool.setTick(TICK + 6932); // CLG price doubles
    await run(f.oracle, 1);
    await time.increase(11 * MIN);
    const [longTwap, shortTwap] = await f.oracle.prices();
    expect(shortTwap).to.be.greaterThan(longTwap);
    expect(await f.oracle.clgUsdPrice()).to.equal(shortTwap);
  });

  it("a sustained full-day crash is reflected (the price is a real average, not frozen)", async function () {
    const f = await deployFixture();
    await warm(f);
    await f.pool.setTick(TICK - 6932);
    await run(f.oracle, 25);
    await time.increase(11 * MIN);
    const p = expectedPrice(TICK);
    expect(usd(await f.oracle.clgUsdPrice())).to.be.closeTo(p / 2, p * 0.03);
  });

  it("goes stale when checkpoints stop, and recovers 10 minutes after a poke if the gap was short", async function () {
    const f = await deployFixture();
    await warm(f);
    await time.increase(7 * HOUR);
    await expect(f.oracle.clgUsdPrice()).to.be.revertedWithCustomError(f.oracle, "Stale");
    await f.oracle.poke();
    await expect(f.oracle.clgUsdPrice()).to.be.revertedWithCustomError(f.oracle, "Stale");
    await time.increase(11 * MIN);
    await f.oracle.clgUsdPrice();
  });

  it("after a long gap it needs a fresh day of checkpoints (a days-old average is never used)", async function () {
    const f = await deployFixture();
    await warm(f);
    await time.increase(3 * DAY);
    await f.oracle.poke();
    await time.increase(11 * MIN);
    await expect(f.oracle.clgUsdPrice()).to.be.revertedWithCustomError(f.oracle, "Stale");
    await run(f.oracle, 24);
    await time.increase(11 * MIN);
    await f.oracle.clgUsdPrice();
  });

  it("stops while the pool's CRONUS depth is below the floor, and resumes as soon as it is back", async function () {
    const f = await deployFixture();
    const [sink] = await ethers.getSigners();
    await warm(f);
    await f.pool.sweep(f.cronus, sink.address, POOL_CRONUS - FLOORS.minPoolCronus + 1n);
    await expect(f.oracle.clgUsdPrice()).to.be.revertedWithCustomError(f.oracle, "LiquidityTooLow");
    await f.cronus.mint(f.pool, POOL_CRONUS);
    await f.oracle.clgUsdPrice();
  });

  it("a checkpoint that saw the pool drained blocks pricing until it leaves the 24h window", async function () {
    const f = await deployFixture();
    const [sink] = await ethers.getSigners();
    await warm(f);
    await time.increase(HOUR);
    await f.pool.sweep(f.cronus, sink.address, POOL_CRONUS - 1000n);
    await f.oracle.poke(); // records the drained pool
    await f.cronus.mint(f.pool, POOL_CRONUS);
    await run(f.oracle, 23);
    await time.increase(11 * MIN);
    await expect(f.oracle.clgUsdPrice()).to.be.revertedWithCustomError(f.oracle, "LiquidityTooLow");
    await run(f.oracle, 2);
    await time.increase(11 * MIN);
    await f.oracle.clgUsdPrice();
  });

  it("stops when in-range liquidity is below the floor now (narrow or out-of-range pools)", async function () {
    const f = await deployFixture();
    await warm(f);
    await f.pool.setLiquidity(FLOORS.minInRangeLiquidity - 1n);
    await expect(f.oracle.clgUsdPrice()).to.be.revertedWithCustomError(f.oracle, "LiquidityTooLow");
    await f.pool.setLiquidity(POOL_LIQ);
    await f.oracle.clgUsdPrice();
  });

  it("stops when either V2 pair is too thin", async function () {
    const f = await deployFixture();
    await warm(f);
    await f.pairB.setReserves(FLOORS.minCronusPairWcro - 1n, CRONUS_WCRO.cronus);
    await expect(f.oracle.clgUsdPrice()).to.be.revertedWithCustomError(f.oracle, "PairReservesTooLow");
    await f.pairB.setReserves(CRONUS_WCRO.wcro, CRONUS_WCRO.cronus);
    await f.pairC.setReserves(WCRO_USDC.wcro, FLOORS.minCroPairUsdc - 1n);
    await expect(f.oracle.clgUsdPrice()).to.be.revertedWithCustomError(f.oracle, "PairReservesTooLow");
  });

  it("rate-limits pokes, keeps a ring of checkpoints and references ones of the right age", async function () {
    const f = await deployFixture();
    expect(await f.oracle.poke.staticCall()).to.equal(false);
    await run(f.oracle, 60);
    expect(await f.oracle.checkpointCount()).to.equal(48n);
    await time.increase(11 * MIN);
    const now = await time.latest();
    const [longRef, shortRef] = await f.oracle.references();
    expect(now - Number(longRef.timestamp)).to.be.within(DAY, DAY + HOUR + 5);
    expect(now - Number(shortRef.timestamp)).to.be.within(10 * MIN, HOUR + 11 * MIN + 5);
  });

  it("emits every checkpoint value", async function () {
    const f = await deployFixture();
    await time.increase(HOUR);
    await expect(f.oracle.poke()).to.emit(f.oracle, "CheckpointRecorded");
  });

  it("rejects pools with the wrong tokens and inconsistent windows", async function () {
    const f = await deployFixture();
    await expect(f.Oracle.deploy(config(f, { cronusWcroPair: f.pairC.target, wcroUsdcPair: f.pairB.target }))).to.be.revertedWithCustomError(f.Oracle, "WrongPoolTokens");
    await expect(f.Oracle.deploy(config(f, { shortWindow: DAY }))).to.be.revertedWithCustomError(f.Oracle, "BadConfig");
    await expect(f.Oracle.deploy(config(f, { maxStaleness: HOUR - 1 }))).to.be.revertedWithCustomError(f.Oracle, "BadConfig");
    await expect(f.Oracle.deploy(config(f, { longWindow: 46 * HOUR }))).to.be.revertedWithCustomError(f.Oracle, "BadConfig");
  });

  it("exposes no admin or mutable configuration", async function () {
    const { oracle } = await deployFixture();
    const writes = oracle.interface.fragments
      .filter((fr) => fr.type === "function" && !["view", "pure"].includes(fr.stateMutability))
      .map((fr) => fr.name);
    expect(writes).to.deep.equal(["poke"]);
  });
});

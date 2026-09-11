const { expect } = require("chai");
const { ethers } = require("hardhat");

const E18 = 10n ** 18n;
const PRICE = 312n * E18; // $312 per CLG
const USD = 35n * E18;
const CAP = (3n * E18) / 10n; // 0.3 CLG
const abi = ethers.AbiCoder.defaultAbiCoder();
const SAFE = "safeTransferFrom(address,address,uint256)";
const SAFE_DATA = "safeTransferFrom(address,address,uint256,bytes)";
const DEAD = "0x000000000000000000000000000000000000dEaD";

async function fixture() {
  const [deployer, alice, bob] = await ethers.getSigners();
  const clg = await (await ethers.getContractFactory("MockERC20")).deploy("Cronos Legends", "CLG", 18);
  const oracle = await (await ethers.getContractFactory("MockOracle")).deploy(PRICE);
  const nft = await (await ethers.getContractFactory("MockERC721")).deploy();
  const other = await (await ethers.getContractFactory("MockERC721")).deploy();
  const Redeemer = await ethers.getContractFactory("LegendsBurnRedeemer");
  const redeemer = await Redeemer.deploy(nft, clg, oracle, USD, CAP, 1, 500);
  await clg.mint(redeemer, 3n * E18);
  for (const id of [1, 2, 3, 500]) await nft.mint(alice, id);
  await nft.mint(alice, 501);
  await other.mint(alice, 7);
  return { deployer, alice, bob, clg, oracle, nft, other, redeemer, Redeemer };
}

const expectedPayout = (price = PRICE) => {
  const raw = (USD * E18) / price;
  return raw < CAP ? raw : CAP;
};

describe("LegendsBurnRedeemer", function () {
  it("is ownerless and quotes $35 of CLG", async function () {
    const { redeemer } = await fixture();
    expect(await redeemer.owner()).to.equal(ethers.ZeroAddress);
    const [amount, price] = await redeemer.quote();
    expect(price).to.equal(PRICE);
    expect(amount).to.equal(expectedPayout());
    expect(Number(ethers.formatUnits(amount, 18))).to.be.closeTo(0.1122, 0.0001);
  });

  it("burns in one transaction: NFT to 0xdEaD, CLG to the holder, event, counters, oracle poked", async function () {
    const { alice, clg, nft, redeemer, oracle } = await fixture();
    const payout = expectedPayout();
    await expect(nft.connect(alice)[SAFE](alice.address, redeemer, 1))
      .to.emit(redeemer, "Redeemed")
      .withArgs(alice.address, 1, payout, PRICE);
    expect(await nft.ownerOf(1)).to.equal(DEAD);
    expect(await clg.balanceOf(alice)).to.equal(payout);
    expect(await redeemer.totalRedeemed()).to.equal(1n);
    expect(await redeemer.totalClgPaid()).to.equal(payout);
    expect(await redeemer.redeemed(1)).to.equal(true);
    expect(await redeemer.isEligible(1)).to.equal(false);
    expect(await oracle.pokes()).to.equal(1n);
  });

  it("honours minClgOut passed as data, and reverts (keeping the NFT) when not met", async function () {
    const { alice, nft, redeemer, clg } = await fixture();
    const payout = expectedPayout();
    await expect(
      nft.connect(alice)[SAFE_DATA](alice.address, redeemer, 2, abi.encode(["uint256"], [payout + 1n]))
    ).to.be.revertedWithCustomError(redeemer, "PayoutBelowMinimum");
    expect(await nft.ownerOf(2)).to.equal(alice.address);
    await nft.connect(alice)[SAFE_DATA](alice.address, redeemer, 2, abi.encode(["uint256"], [payout]));
    expect(await clg.balanceOf(alice)).to.equal(payout);
  });

  it("rejects malformed data", async function () {
    const { alice, nft, redeemer } = await fixture();
    await expect(nft.connect(alice)[SAFE_DATA](alice.address, redeemer, 2, "0x1234")).to.be.revertedWithCustomError(
      redeemer,
      "InvalidData"
    );
  });

  it("reverts when the reserve cannot cover the payout; the NFT stays with its owner", async function () {
    const { alice, nft, clg, oracle, Redeemer } = await fixture();
    const poor = await Redeemer.deploy(nft, clg, oracle, USD, CAP, 1, 500);
    await clg.mint(poor, expectedPayout() - 1n);
    await expect(nft.connect(alice)[SAFE](alice.address, poor, 3)).to.be.revertedWithCustomError(poor, "ReserveTooLow");
    expect(await nft.ownerOf(3)).to.equal(alice.address);
  });

  it("only accepts token IDs in the published range", async function () {
    const { alice, nft, redeemer } = await fixture();
    await expect(nft.connect(alice)[SAFE](alice.address, redeemer, 501))
      .to.be.revertedWithCustomError(redeemer, "TokenNotEligible")
      .withArgs(501);
    await nft.connect(alice)[SAFE](alice.address, redeemer, 500);
  });

  it("ignores other collections and direct calls to the hook", async function () {
    const { alice, other, redeemer } = await fixture();
    await expect(other.connect(alice)[SAFE](alice.address, redeemer, 7)).to.be.revertedWithCustomError(
      redeemer,
      "WrongCollection"
    );
    const caller = await (await ethers.getContractFactory("HookCaller")).deploy();
    await expect(caller.callHook(redeemer, alice.address, 1)).to.be.revertedWithCustomError(redeemer, "WrongCollection");
  });

  it("does not pay for NFTs minted straight into it", async function () {
    const { nft, redeemer } = await fixture();
    await expect(nft.safeMint(redeemer, 42)).to.be.revertedWithCustomError(redeemer, "MintsNotAccepted");
  });

  it("a plain transferFrom pays nothing; the NFT counts as gone in outstandingNfts()", async function () {
    const { alice, nft, redeemer, clg } = await fixture();
    const before = await redeemer.outstandingNfts();
    await nft.connect(alice).transferFrom(alice.address, redeemer, 3);
    expect(await clg.balanceOf(alice)).to.equal(0n);
    expect(await redeemer.outstandingNfts()).to.equal(before - 1n);
  });

  it("caps the payout at MAX_CLG_PER_NFT when CLG's price is very low", async function () {
    const { alice, nft, redeemer, oracle, clg } = await fixture();
    await oracle.setPrice(50n * E18); // $35 would be 0.7 CLG
    const [amount] = await redeemer.quote();
    expect(amount).to.equal(CAP);
    await nft.connect(alice)[SAFE](alice.address, redeemer, 1);
    expect(await clg.balanceOf(alice)).to.equal(CAP);
  });

  it("reverts the whole transfer if the oracle cannot price", async function () {
    const { alice, nft, redeemer, oracle } = await fixture();
    await oracle.setRevert(true);
    await expect(nft.connect(alice)[SAFE](alice.address, redeemer, 1)).to.be.reverted;
    expect(await nft.ownerOf(1)).to.equal(alice.address);
  });

  it("reports burnsAvailable and backingPerNft", async function () {
    const { redeemer } = await fixture();
    const payout = expectedPayout();
    expect(await redeemer.burnsAvailable()).to.equal((3n * E18) / payout);
    // 500 eligible IDs, 3 CLG reserve -> reserve / outstanding is the binding term.
    expect(await redeemer.backingPerNft()).to.equal((3n * E18) / 500n);
  });

  it("rejects nonsensical configuration, including addresses without contract code", async function () {
    const { nft, clg, oracle, Redeemer, bob } = await fixture();
    await expect(Redeemer.deploy(nft, clg, oracle, USD, CAP, 10, 1)).to.be.revertedWithCustomError(Redeemer, "BadConfig");
    await expect(Redeemer.deploy(nft, clg, oracle, 0, CAP, 1, 10)).to.be.revertedWithCustomError(Redeemer, "BadConfig");
    await expect(Redeemer.deploy(ethers.ZeroAddress, clg, oracle, USD, CAP, 1, 10)).to.be.revertedWithCustomError(Redeemer, "BadConfig");
    await expect(Redeemer.deploy(nft, clg, bob.address, USD, CAP, 1, 10)).to.be.revertedWithCustomError(Redeemer, "BadConfig");
    await expect(Redeemer.deploy(bob.address, clg, oracle, USD, CAP, 1, 10)).to.be.revertedWithCustomError(Redeemer, "BadConfig");
  });

  it("isEligible is false for burned tokens, tokens at the burn address and out-of-range IDs", async function () {
    const { alice, nft, redeemer } = await fixture();
    expect(await redeemer.isEligible(1)).to.equal(true);
    await nft.connect(alice)[SAFE](alice.address, redeemer, 1);
    expect(await redeemer.isEligible(1)).to.equal(false);
    await nft.mint(DEAD, 8);
    expect(await redeemer.isEligible(8)).to.equal(false);
    expect(await redeemer.isEligible(501)).to.equal(false);
    expect(await redeemer.isEligible(9)).to.equal(false); // never minted
  });

  it("has no function that can move CLG out other than the burn hook", async function () {
    const { redeemer } = await fixture();
    const writes = redeemer.interface.fragments
      .filter((f) => f.type === "function" && !["view", "pure"].includes(f.stateMutability))
      .map((f) => f.name);
    expect(writes).to.deep.equal(["onERC721Received"]);
  });
});

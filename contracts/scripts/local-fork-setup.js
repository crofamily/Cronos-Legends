// Deploys the oracle + Legends Awaken redeemers onto a LOCAL mainnet fork node, funds them from
// the (impersonated) treasury, fast-forwards past the 24h warm-up, performs one real burn, and
// writes a config the website and monitor can point at for end-to-end testing.
//
//   terminal 1:  $env:FORK="1"; npx hardhat node
//   terminal 2:  npx hardhat run scripts/local-fork-setup.js --network localhost
//
// Never used for mainnet deployment.
const fs = require("fs");
const path = require("path");
const { ethers, network } = require("hardhat");
const A = require("../deploy/addresses.json");
const { oracleConfig, redeemerArgs } = require("./config");

const TREASURY = "0xAF87e4Df58D735ec2971d2D8Db663B02cA60175D";
const ERC20 = ["function transfer(address,uint256) returns (bool)"];
const ERC721A = ["function tokensOfOwner(address) view returns (uint256[])", "function ownerOf(uint256) view returns (address)", "function safeTransferFrom(address,address,uint256,bytes)"];

async function impersonate(addr) {
  await network.provider.request({ method: "hardhat_impersonateAccount", params: [addr] });
  await network.provider.send("hardhat_setBalance", [addr, "0x" + (10n ** 21n).toString(16)]);
  return ethers.getSigner(addr);
}

async function main() {
  await network.provider.send("evm_mine", []);
  const oracle = await (await ethers.getContractFactory("ClgPriceOracle")).deploy(oracleConfig(A));
  const R = await ethers.getContractFactory("LegendsBurnRedeemer");
  const deployed = {};
  for (const key of ["legendsAwaken1", "legendsAwaken2"]) {
    const r = await R.deploy(...redeemerArgs(A, key, await oracle.getAddress()));
    deployed[key] = await r.getAddress();
  }

  const treasury = await impersonate(TREASURY);
  const clg = new ethers.Contract(A.tokens.CLG, ERC20, treasury);
  await clg.transfer(deployed.legendsAwaken1, ethers.parseUnits("1", 18));
  await clg.transfer(deployed.legendsAwaken2, ethers.parseUnits("0.3", 18)); // deliberately low

  // A day of hourly keeper pokes, then 11 minutes so the short average has a reference.
  for (let i = 0; i < 25; i++) {
    await network.provider.send("evm_increaseTime", [3600]);
    await oracle.poke();
  }
  await network.provider.send("evm_increaseTime", [660]);
  await network.provider.send("evm_mine", []);

  // One real burn so the monitor has an event to report.
  const la1 = new ethers.Contract(A.collections.legendsAwaken1.address, ERC721A, ethers.provider);
  const holderAddr = await la1.ownerOf(1);
  const holder = await impersonate(holderAddr);
  const ids = [1n];
  await la1.connect(holder).safeTransferFrom(holderAddr, deployed.legendsAwaken1, ids[0], "0x");

  const siteCfg = JSON.parse(fs.readFileSync(path.join(__dirname, "../../assets/data/burn.json"), "utf8"));
  siteCfg.rpc = ["http://127.0.0.1:8545"];
  siteCfg.oracle = await oracle.getAddress();
  for (const col of siteCfg.collections) if (deployed[col.key]) col.redeemer = deployed[col.key];
  const outDir = path.join(__dirname, "../../monitor/.local");
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, "burn.local.json"), JSON.stringify(siteCfg, null, 2));
  console.log("oracle", siteCfg.oracle);
  console.log("redeemers", deployed);
  console.log("burned LA1 #" + ids[0] + " from " + holderAddr);
  console.log("wrote monitor/.local/burn.local.json");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

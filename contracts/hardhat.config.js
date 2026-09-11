require("@nomicfoundation/hardhat-toolbox");

// Cronos runs PUSH0/TSTORE/MCOPY but rejects Osaka's CLZ opcode, so the EVM
// target is pinned to cancun. Keep this identical in the verification input.
const COMPILER = {
  version: "0.8.28",
  settings: { optimizer: { enabled: true, runs: 200 }, evmVersion: "cancun" },
};

// Fork tests need an archive-capable RPC. evm.cronos.org rate-limits bursts;
// cronos.drpc.org has worked reliably for forking.
const FORK_URL = process.env.FORK_URL || "https://cronos.drpc.org";

module.exports = {
  solidity: { compilers: [COMPILER] },
  paths: { sources: "./src", tests: "./test", artifacts: "./artifacts", cache: "./cache" },
  networks: {
    hardhat: process.env.FORK
      ? {
          chainId: 25,
          forking: { url: FORK_URL },
          chains: { 25: { hardforkHistory: { cancun: 0 } } },
        }
      : {},
    // Local fork node for end-to-end tests (see scripts/local-fork-setup.js). Forked state is
    // fetched lazily from the remote RPC, so first calls can be slow.
    localhost: { url: "http://127.0.0.1:8545", timeout: 900000 },
  },
  mocha: { timeout: 600000 },
};

// Packages what deployment and verification need, after `npx hardhat compile`:
//   deploy/artifacts.json               ABI + creation bytecode for the deploy page
//   deploy/verify/<Name>.input.json     solc standard-JSON input for explorer / Sourcify verification
//   deploy/verify/README.txt            compiler version and contract names to enter when verifying
//
//   npx hardhat compile && node scripts/export-artifacts.js
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const NAMES = {
  ClgPriceOracle: "src/ClgPriceOracle.sol",
  LegendsBurnRedeemer: "src/LegendsBurnRedeemer.sol",
};

function buildInfoFor(sourceName, contractName) {
  const dir = path.join(ROOT, "artifacts", "build-info");
  for (const f of fs.readdirSync(dir)) {
    const info = JSON.parse(fs.readFileSync(path.join(dir, f), "utf8"));
    if (info.output?.contracts?.[sourceName]?.[contractName]) return info;
  }
  throw new Error(`No build-info contains ${sourceName}:${contractName}. Run npx hardhat compile first.`);
}

const artifacts = {};
const verifyDir = path.join(ROOT, "deploy", "verify");
fs.mkdirSync(verifyDir, { recursive: true });
const readme = [];

for (const [name, source] of Object.entries(NAMES)) {
  const art = JSON.parse(fs.readFileSync(path.join(ROOT, "artifacts", source, `${name}.json`), "utf8"));
  artifacts[name] = { abi: art.abi, bytecode: art.bytecode };

  const info = buildInfoFor(source, name);
  // Keep only the sources this contract actually needs, so the verification input is minimal.
  const needed = new Set();
  const visit = (s) => {
    if (needed.has(s)) return;
    needed.add(s);
    const ast = info.output.sources[s]?.ast;
    for (const node of ast?.nodes || []) if (node.nodeType === "ImportDirective") visit(node.absolutePath);
  };
  visit(source);
  const input = { ...info.input, sources: Object.fromEntries([...needed].sort().map((s) => [s, info.input.sources[s]])) };
  input.settings = { ...input.settings, outputSelection: { "*": { "*": ["abi", "evm.bytecode", "evm.deployedBytecode", "metadata"] } } };
  fs.writeFileSync(path.join(verifyDir, `${name}.input.json`), JSON.stringify(input, null, 2));
  readme.push(`${name}: contract "${source}:${name}", compiler v${info.solcLongVersion}, optimizer ${input.settings.optimizer.enabled} (${input.settings.optimizer.runs} runs), evmVersion ${input.settings.evmVersion}, license MIT`);
}

fs.writeFileSync(path.join(ROOT, "deploy", "artifacts.json"), JSON.stringify(artifacts));
fs.writeFileSync(
  path.join(verifyDir, "README.txt"),
  [
    "Verify on https://explorer.cronos.com/verifyContract (method: Solidity, Standard JSON input)",
    "or on https://sourcify.dev (chain: Cronos Mainnet, 25).",
    "",
    ...readme,
    "",
    "Constructor arguments (ABI-encoded) are shown on the deploy page after each deployment.",
  ].join("\n")
);
console.log("Wrote deploy/artifacts.json and deploy/verify/*.input.json");

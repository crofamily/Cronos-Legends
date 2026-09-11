# Cronos Legends burn program — contracts

Burn one Cronos Legends NFT, receive a fixed USD value of **$CLG** in the same transaction.

| Collection | NFT contract | Payout | Eligible token IDs |
|---|---|---|---|
| Legends Awaken I | `0x68A3192E286AA5C2182D815F5fE796401eCe28bA` | $35 of CLG (max 0.3 CLG) | 1–500 |
| Legends Awaken II | `0xB9669AD823feB0D0e6c9A7154033ab15e85d6a0d` | $35 of CLG (max 0.3 CLG) | 1–774 |
| Trinari: Elderborn | deployed on crovia.app | $15 of CLG (max 0.13 CLG) | 1 – total minted (deploy only after sell-out) |

## How it works

- **`LegendsBurnRedeemer`** — one per collection. A holder calls `safeTransferFrom(holder, redeemer, tokenId)` on the NFT
  contract (optionally with `data = abi.encode(minClgOut)`). Inside that same transaction the redeemer forwards the NFT
  to `0x000000000000000000000000000000000000dEaD` and pays the previous owner
  `min(USD_PER_NFT / clgUsdPrice, MAX_CLG_PER_NFT)` CLG from its own balance. If anything fails (reserve too small,
  price unavailable, payout below `minClgOut`) the whole transfer reverts and the NFT stays with its owner.
- **`ClgPriceOracle`** — one, shared. CLG/USD from three VVS pools: CLG→CRONUS (V3 1% pool, where CLG's liquidity is),
  CRONUS→WCRO (V2) and WCRO→USDC (V2, USDC treated as $1). It keeps its own checkpoints (at most one per hour) of the
  pools' cumulative price counters and publishes **the higher of two time-weighted averages**: since the newest
  checkpoint ≥ 24 h old, and since the newest checkpoint ≥ 10 min old. A price moved and restored inside one block never
  enters the averages, so pushing payouts up would take holding CLG's price down for a whole day.
  Pricing reverts (burns wait, NFTs stay with their owners) when:
  - it is less than a day old (`WarmingUp`), or a reference checkpoint is > 6 h older than its window (`Stale` —
    checkpoints stopped arriving; a keeper pokes hourly, and anyone can call `poke()`);
  - the CLG/CRONUS pool holds < 3M CRONUS now or at any checkpoint in the last day, or its in-range liquidity is below
    1e22 now (`LiquidityTooLow`) — the pool's token balance measures real depth, which a narrow position can't fake;
  - either V2 pair's quote-side reserve is < 300k WCRO / 300k USDC (`PairReservesTooLow`).

Neither contract has an owner, admin, upgrade path, pause function, cap, window, queue, allowlist or withdraw function.
CLG sent to a redeemer can leave **only** as a burn payout. `owner()` returns the zero address on both.

### Things to know

- The team funds each redeemer by sending CLG to its address. First come, first served while the reserve lasts.
- **The project's LP is a dependency.** ~99.9% of the CLG/CRONUS V3 pool is the project wallet's LP position (#49804),
  which is not locked. Withdrawing more than ~64% of it stops burns while it's out; if an hourly checkpoint records
  it missing, burns stay stopped until that checkpoint is a day old. Rebalance in a single transaction (multicall), and
  keep at least 3M CRONUS / 1e22 liquidity in the pool.
- **A keeper is needed.** Without a checkpoint for ~6 hours, pricing goes `Stale`. The burn monitor records one every
  hour when its `POKE_PRIVATE_KEY` secret is set (a separate wallet holding only a few CRO for gas).
- USDC is assumed to be worth $1. `MAX_CLG_PER_NFT` bounds what one burn can pay if a price source ever misbehaves.
- Only token IDs inside the published range are eligible. Tokens minted later with higher IDs are never paid.
- Sending an NFT with plain `transferFrom` (not `safeTransferFrom`), to `0x…dEaD` directly, or through a generic burn
  tool pays **nothing**. Use cronoslegends.com/burn.
- NFTs held in the Crypto.com NFT app must first be withdrawn to a self-custody Cronos EVM wallet.

## Develop

```bash
npm install
npx hardhat test test/unit/*.js            # 33 unit tests
FORK=1 npx hardhat test test/fork/*.js     # 5 tests against a Cronos mainnet fork (PowerShell: $env:FORK="1")
```

Compiler: solc 0.8.28, optimizer 200 runs, **evmVersion cancun** (Cronos rejects Osaka's CLZ opcode).

## Deploy (from your own wallet — no private keys in files)

1. `npx hardhat compile && node scripts/export-artifacts.js`
2. Serve the repo root locally, e.g. `npx http-server .. -p 8099` (or `python -m http.server 8099` from the repo root),
   and open `http://localhost:8099/contracts/deploy/deploy.html` in a browser with your wallet extension.
3. Deploy the **oracle** first. It needs **24 hours** of price history before it can price a burn.
4. Deploy one **redeemer** per collection (Legends Awaken I and II now; Trinari Elderborn after its mint closes, once
   its contract address and first token ID are filled in `deploy/addresses.json`).
5. Fund each redeemer with a small amount of CLG (e.g. 1–3 CLG) from the deploy page.
6. Put the addresses into `../assets/data/burn.json` (`oracle` and each collection's `redeemer`). The website and the
   Discord monitor read that file.
7. Verify both contracts (see `deploy/verify/README.txt`): upload `deploy/verify/<Name>.input.json` as
   "Standard JSON input" on https://explorer.cronos.com/verifyContract, or verify on https://sourcify.dev
   (Cronos Mainnet, chain 25). The deploy page shows the ABI-encoded constructor arguments.

Before funding, the treasury's own Legends Awaken NFTs are sent to `0x…dEaD` so the team can never redeem from the
reserve itself.

## Launch checklist

1. From the project wallet `0xAF87…175D`, send its own Legends Awaken NFTs (29 LA I + 12 LA II at the time of writing)
   to `0x000000000000000000000000000000000000dEaD` with a plain transfer (e.g. crovia.app/tools/burn). Note the tx hashes.
2. Create a NEW wallet for the keeper, send it ~30 CRO, and add its private key as the GitHub secret `POKE_PRIVATE_KEY`.
   Add `DISCORD_WEBHOOK_URL` (and optionally `DISCORD_MENTION_ID`). Run the "Burn monitor" workflow once with `mode = test`.
3. Deploy the oracle from the project wallet (deploy page). Put its address in `assets/data/burn.json` → `oracle`,
   and push, so the monitor starts poking it hourly.
4. Deploy the Legends Awaken I and II redeemers. Put their addresses in `assets/data/burn.json` (`redeemer`).
5. Verify the oracle and both redeemers on explorer.cronos.com (and/or Sourcify).
6. After 24 hours, check the deploy page shows a payout of about $35 for both, then fund each reserve with CLG.
7. Update static text that can't read the config:
   - `legends-awaken-1/index.html` and `legends-awaken-2/index.html`: replace "published here at launch" with the
     claim contract address.
   - `burn/index.html` → "The project's own NFTs": add the tx links from step 1.
   - `about/index.html` → official addresses: add the oracle and claim contracts.
8. Push to `main`. Watch the Discord channel for the first burns; the first burn by a real holder completes LBNFT R3.
9. Trinari: Elderborn, after its crovia.app mint sells out: fill `address`/`minTokenId`/`maxTokenId` in
   `deploy/addresses.json` and `assets/data/burn.json` (maxTokenId = total minted), deploy its redeemer from the deploy
   page (it refuses before sell-out), verify, fund, update the Elderborn texts.

## Monitoring

`../.github/workflows/burn-monitor.yml` checks every 30 minutes and posts to Discord (secret `DISCORD_WEBHOOK_URL`)
when a reserve runs low or empty, when burns stop (oracle warming up / liquidity floor), when spot and the 24 h average
diverge by more than 25%, and for every burn; plus a daily report with reserves and the LP's uncollected fees.

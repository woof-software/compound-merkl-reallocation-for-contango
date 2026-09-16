# Compound Merkl reallocation for Contango

Tooling to find Contango position proxies inside Compound's Merkl COMP reward campaigns and map
them back to the users who actually own the positions.

Contango opens every position through a dedicated proxy contract. The proxy is what appears as the
reward recipient in Merkl's reward files, so rewards addressed to it need to be reallocated to the
position owner. Ownership is tracked by an ERC‑721 (the *position NFT*), so:

- `UnderlyingPositionCreated(address indexed account, PositionId indexed positionId)` emitted by
  Contango core (`0xDaBA83815404f5e1bc33f5885db7D96F51e127F5`) gives **proxy → positionId**
- `Transfer(from, to, tokenId)` on the position NFT (`0xC2462f03920D47fC5B9e2C5F0ba5D2ded058fD78`)
  gives **positionId (= tokenId) → owner**

Both contracts have the same address on every chain (deterministic deployment). Covered chains:
Ethereum, Base, Arbitrum, Optimism, Polygon.

Ownership is evaluated **per transaction**, not per `Transfer` event: Contango's open/close/modify
flows route the NFT through helper contracts (and back, or on to a burn) inside one transaction,
which emits `Transfer` events that are not ownership changes. For every `(tx, tokenId)` the holder
before the tx is compared with the holder after it; only net changes between two non‑zero addresses
count as an ownership transfer.

## Setup

```bash
npm install
cp .env.example .env   # fill in RPC URLs
```

RPC calls are rate‑limited process‑wide (all chains share one provider key): `RPC_MAX_RPS`
(default 10), `RPC_MAX_CONCURRENCY` (default 5), `RPC_TIMEOUT_MS` (default 30000). 429/5xx
responses are retried with exponential backoff.

## 1. Build the proxy → owner mapping

```bash
npm run proxies:all                  # every chain → output/contango-proxy-owners-<chain>.csv
npm run proxies -- arbitrum          # a single chain
```

Columns: `proxy, owner, currentOwner, originalOwner, transfers, status, positionId, tokenId, createdBlock, createdTx, lastTransferBlock, lastTransferTx`

- `owner` — last non‑zero holder of the NFT. For closed positions (`status=closed`, NFT burned)
  this is whoever held it when it was closed; `currentOwner` is `0x0` in that case.
- `originalOwner` — holder after the mint transaction.
- `transfers` — number of net ownership changes between users over the position's lifetime.
- `status` — `active` or `closed`.

## 2. Cross‑reference with Merkl reward files

Reward files are Merkl JSON of the form `{ rewardToken, rewards: { <address>: { <reason>: <wei> } } }`.
The files for the existing campaigns live in [`campaigns/`](campaigns/), named as Merkl exports
them (`rewards-<v2|v3>-<chain>-<token>-<fromBlock>-<toBlock>.merkl.json`; Ethereum is `mainnet`).
Drop new exports there when campaigns are updated.

```bash
npm run merkl:all      # every chain that has files in campaigns/ → output/contango-proxies-in-merkl-<chain>.csv
npm run all            # proxies:all followed by merkl:all
```

### One chain by hand

```bash
npm run merkl -- output/contango-proxy-owners-ethereum.csv campaigns/rewards-v3-mainnet-*.merkl.json campaigns/rewards-v2-mainnet-*.merkl.json
OUT=output/contango-proxies-in-merkl-arbitrum.csv npm run merkl -- output/contango-proxy-owners-arbitrum.csv campaigns/rewards-v3-arbitrum-*.merkl.json
```

Prints per file: number of proxies present, COMP owed to them, split by status and by reward
reason (Comet market), then combined totals, the proxies whose NFT ever changed hands (with
original → current owner), top proxies and top owners. Writes a CSV with one row per proxy:
`proxy, owner, originalOwner, transfers, status, totalCOMP, totalWei, <amount per input file>`.

## Results (2026‑09‑16, from the files in `campaigns/`)

| Chain | Proxies on chain | Proxies in rewards | COMP owed | % of chain budget | Rewarded proxies that changed hands | COMP on those |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| Ethereum | 6,183 | 71 | 308.0376 | 0.33% | 1 (1 transfer) | 1.8643 |
| Base | 13,729 | 602 | 30.5690 | 0.83% | 4 (4) | 0.5582 |
| Arbitrum | 23,792 | 4,874 | 146.7140 | 2.01% | 19 (19) | 1.0165 |
| Optimism | 16,080 | 798 | 63.4322 | 4.23% | 7 (8) | 5.8372 |
| Polygon | 1,094 | 14 | 0.4950 | 0.07% | 1 (1) | 0.0182 |
| **Total** | | **6,359** | **549.2478** | | **32 (33)** | **9.2944** |

Generated files are in [`output/`](output/).

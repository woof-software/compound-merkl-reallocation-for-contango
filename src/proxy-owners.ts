/**
 * Builds a CSV mapping Contango position proxies to their current owners on one chain.
 *
 *   proxy  = `account` from UnderlyingPositionCreated(address indexed account, PositionId indexed positionId)
 *   owner  = last non-zero holder of the position NFT with tokenId == uint256(positionId),
 *            derived from Transfer(from, to, tokenId) events. For closed (burned) positions this
 *            is whoever held it when it was burned; `currentOwner` is 0x0 in that case.
 *
 * Ownership is evaluated per transaction, not per Transfer event: Contango's open/close/modify
 * flows route the NFT through helper contracts and back (or to a helper that burns it) inside a
 * single tx, which emits Transfer events that are not ownership changes. So for every
 * (tx, tokenId) we compare the holder before the tx with the holder after it:
 *   originalOwner = holder after the mint tx
 *   transfers     = number of txs where the holder changed between two non-zero addresses
 *   owner         = holder before the burn tx (closed) / current holder (active)
 *
 * Usage: npm run proxies -- [chain=ethereum] [out.csv]
 *   chain: ethereum | base | arbitrum | polygon | optimism
 */
import 'dotenv/config';
import { writeFileSync } from 'node:fs';
import { parseAbiItem, zeroAddress, type Address, type Hex, type PublicClient } from 'viem';
import { CONTANGO, POSITION_NFT, getChain, rpcUrl } from './config.js';
import { makeClient } from './rpc.js';

const chainKey = process.argv[2] ?? 'ethereum';
const chainCfg = getChain(chainKey);
const OUT = process.argv[3] ?? `output/contango-proxy-owners-${chainKey}.csv`;

const CREATED = parseAbiItem('event UnderlyingPositionCreated(address indexed account, bytes32 indexed positionId)');
const TRANSFER = parseAbiItem('event Transfer(address indexed from, address indexed to, uint256 indexed tokenId)');

const client = makeClient(chainCfg.chain, rpcUrl(chainCfg));

/** getLogs over [from, to], halving the range whenever the provider rejects the response size. */
async function logs<T extends typeof CREATED | typeof TRANSFER>(c: PublicClient, address: Address, event: T, from: bigint, to: bigint): Promise<any[]> {
  try {
    return await c.getLogs({ address, event, fromBlock: from, toBlock: to, strict: true });
  } catch (err) {
    const msg = String((err as any)?.details ?? (err as any)?.message ?? err).toLowerCase();
    if (to === from || !(msg.includes('size exceeded') || msg.includes('block range') || msg.includes('more than'))) throw err;
    // Sequential on purpose: parallel halves burst past Alchemy's compute-units-per-second limit.
    const mid = from + (to - from) / 2n;
    return [...(await logs(c, address, event, from, mid)), ...(await logs(c, address, event, mid + 1n, to))];
  }
}

const latest = await client.getBlockNumber();
console.error(`${chainCfg.name} latest block ${latest}`);

const [created, transfers] = await Promise.all([
  logs(client, CONTANGO, CREATED, 0n, latest),
  logs(client, POSITION_NFT, TRANSFER, 0n, latest),
]);
console.error(`${created.length} UnderlyingPositionCreated, ${transfers.length} NFT Transfer events`);

// Replay transfers in chain order and collapse them to one net transition per (tx, tokenId).
transfers.sort((a, b) => (a.blockNumber === b.blockNumber ? a.logIndex - b.logIndex : a.blockNumber < b.blockNumber ? -1 : 1));
type Tx = { tokenId: bigint; before: Address; after: Address; block: bigint; tx: Hex };
const txs = new Map<string, Tx>();
const holder = new Map<bigint, Address>();
for (const t of transfers) {
  const tokenId = t.args.tokenId as bigint;
  const key = `${t.transactionHash}:${tokenId}`;
  const cur = txs.get(key);
  if (cur) cur.after = t.args.to as Address;
  else txs.set(key, { tokenId, before: holder.get(tokenId) ?? zeroAddress, after: t.args.to as Address, block: t.blockNumber, tx: t.transactionHash });
  holder.set(tokenId, t.args.to as Address);
}

type Own = { current: Address; last: Address; original: Address; transfers: number; block: bigint; tx: Hex };
const ownerOf = new Map<bigint, Own>();
for (const x of txs.values()) {
  const e = ownerOf.get(x.tokenId) ?? { current: zeroAddress, last: zeroAddress, original: zeroAddress, transfers: 0, block: 0n, tx: '0x' as Hex };
  if (x.before === zeroAddress) e.original = x.after;                                  // mint
  if (x.before !== zeroAddress && x.after !== zeroAddress && x.before !== x.after) e.transfers++;
  if (x.before === x.after) continue;                                                   // round-trip inside a tx: no-op
  e.current = x.after;
  e.last = x.after === zeroAddress ? x.before : x.after;                                // on burn, the closer is `before`
  e.block = x.block;
  e.tx = x.tx;
  ownerOf.set(x.tokenId, e);
}

const rows = created
  .map((l) => {
    const positionId = l.args.positionId as Hex;
    const tokenId = BigInt(positionId);
    const own = ownerOf.get(tokenId);
    return {
      proxy: l.args.account as Address,
      owner: own?.last ?? '',
      currentOwner: own?.current ?? '',
      originalOwner: own?.original ?? '',
      transfers: String(own?.transfers ?? 0),
      status: !own ? 'no-nft' : own.current === zeroAddress ? 'closed' : 'active',
      positionId,
      tokenId: tokenId.toString(),
      createdBlock: l.blockNumber.toString(),
      createdTx: l.transactionHash,
      lastTransferBlock: own?.block.toString() ?? '',
      lastTransferTx: own?.tx ?? '',
    };
  })
  .sort((a, b) => Number(a.createdBlock) - Number(b.createdBlock));

const header = ['proxy', 'owner', 'currentOwner', 'originalOwner', 'transfers', 'status', 'positionId', 'tokenId', 'createdBlock', 'createdTx', 'lastTransferBlock', 'lastTransferTx'];
const csv = [header.join(','), ...rows.map((r) => header.map((h) => (r as any)[h]).join(','))].join('\n') + '\n';
writeFileSync(OUT, csv);

const active = rows.filter((r) => r.status === 'active').length;
const closed = rows.filter((r) => r.status === 'closed').length;
const noNft = rows.filter((r) => r.status === 'no-nft').length;
const transferred = rows.filter((r) => Number(r.transfers) > 0);
console.error(`Wrote ${rows.length} rows to ${OUT} (active ${active}, closed ${closed}, no-nft ${noNft}, distinct owners ${new Set(rows.map((r) => r.owner.toLowerCase())).size}, positions with ownership transfers ${transferred.length} / ${transferred.reduce((s, r) => s + Number(r.transfers), 0)} transfers)`);

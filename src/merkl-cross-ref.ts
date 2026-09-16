/**
 * Cross-references Merkl reward files (rewards.<address>.<reason> = COMP wei) with the
 * Contango proxy→owner CSV, and reports how many proxies are in the rewards and how much
 * COMP is owed to them.
 *
 * Usage: npm run merkl -- <proxies.csv> <rewards.json> [more.json ...]
 *   OUT=<path> overrides the output CSV (default output/contango-proxies-in-merkl.csv)
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { basename } from 'node:path';
import { formatUnits } from 'viem';
import { COMP_DECIMALS } from './config.js';

const [csvPath, ...jsonPaths] = process.argv.slice(2);
if (!csvPath || jsonPaths.length === 0) throw new Error('usage: contango-in-merkl.ts <proxies.csv> <rewards.json>...');

const fmt = (wei: bigint, d = 4) => Number(formatUnits(wei, COMP_DECIMALS)).toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d });

// proxy (lowercase) → { owner, status }
const csv = readFileSync(csvPath, 'utf8').trim().split('\n');
const head = csv[0].split(',');
const col = (name: string) => head.indexOf(name);
const proxies = new Map<string, { proxy: string; owner: string; originalOwner: string; transfers: number; status: string }>();
for (const line of csv.slice(1)) {
  const r = line.split(',');
  proxies.set(r[col('proxy')].toLowerCase(), {
    proxy: r[col('proxy')], owner: r[col('owner')], status: r[col('status')],
    originalOwner: col('originalOwner') >= 0 ? r[col('originalOwner')] : '',
    transfers: col('transfers') >= 0 ? Number(r[col('transfers')]) : 0,
  });
}

type Rewards = { rewardToken: string; rewards: Record<string, Record<string, string>> };

const perProxy = new Map<string, { owner: string; originalOwner: string; transfers: number; status: string; total: bigint; files: Record<string, bigint> }>();
const grand = { addresses: 0, total: 0n, proxyTotal: 0n };

for (const p of jsonPaths) {
  const data = JSON.parse(readFileSync(p, 'utf8')) as Rewards;
  const name = basename(p);
  let fileTotal = 0n, proxyCount = 0, proxyTotal = 0n;
  const byReason = new Map<string, { n: number; amt: bigint }>();
  const byStatus = new Map<string, { n: number; amt: bigint }>();

  for (const [addr, reasons] of Object.entries(data.rewards)) {
    const amt = Object.values(reasons).reduce((s, v) => s + BigInt(v), 0n);
    fileTotal += amt;
    const px = proxies.get(addr.toLowerCase());
    if (!px) continue;
    proxyCount++;
    proxyTotal += amt;
    for (const [reason, v] of Object.entries(reasons)) {
      const r = byReason.get(reason) ?? { n: 0, amt: 0n };
      r.n++; r.amt += BigInt(v); byReason.set(reason, r);
    }
    const st = byStatus.get(px.status) ?? { n: 0, amt: 0n };
    st.n++; st.amt += amt; byStatus.set(px.status, st);
    const e = perProxy.get(addr.toLowerCase()) ?? { owner: px.owner, originalOwner: px.originalOwner, transfers: px.transfers, status: px.status, total: 0n, files: {} };
    e.total += amt; e.files[name] = amt; perProxy.set(addr.toLowerCase(), e);
  }

  const n = Object.keys(data.rewards).length;
  grand.addresses += n; grand.total += fileTotal; grand.proxyTotal += proxyTotal;
  console.log(`\n${name}`);
  console.log(`  addresses in file: ${n.toLocaleString()}   total COMP: ${fmt(fileTotal, 2)}`);
  console.log(`  Contango proxies:  ${proxyCount.toLocaleString()} (${(proxyCount / n * 100).toFixed(2)}% of addresses)   owed: ${fmt(proxyTotal)} COMP (${(Number(proxyTotal * 10000n / fileTotal) / 100).toFixed(2)}% of file)`);
  for (const [s, v] of byStatus) console.log(`    ${s.padEnd(8)} ${String(v.n).padStart(5)} proxies  ${fmt(v.amt).padStart(16)} COMP`);
  console.log('  by reason:');
  for (const [r, v] of [...byReason].sort((a, b) => (a[1].amt > b[1].amt ? -1 : 1))) console.log(`    ${r.padEnd(56)} ${String(v.n).padStart(5)}  ${fmt(v.amt).padStart(16)} COMP`);
}

const uniq = [...perProxy.entries()].sort((a, b) => (a[1].total > b[1].total ? -1 : 1));
const owners = new Map<string, bigint>();
for (const [, e] of uniq) owners.set(e.owner.toLowerCase(), (owners.get(e.owner.toLowerCase()) ?? 0n) + e.total);

console.log(`\n=== Combined (${jsonPaths.length} files) ===`);
console.log(`  distinct Contango proxies with rewards: ${uniq.length.toLocaleString()}`);
console.log(`  total COMP owed to proxies:             ${fmt(grand.proxyTotal)} COMP  (${(Number(grand.proxyTotal * 10000n / grand.total) / 100).toFixed(2)}% of ${fmt(grand.total, 2)} COMP across all files)`);
console.log(`  distinct owners behind them:            ${owners.size.toLocaleString()}`);
const moved = uniq.filter(([, e]) => e.transfers > 0);
const movedComp = moved.reduce((s, [, e]) => s + e.total, 0n);
console.log(`  proxies whose NFT changed hands:        ${moved.length} (${moved.reduce((s, [, e]) => s + e.transfers, 0)} ownership transfers all-time), owed ${fmt(movedComp)} COMP`);
if (moved.length) {
  console.log('\n  ownership transfers (proxy → original owner → current/last owner):');
  for (const [addr, e] of moved) console.log(`    ${proxies.get(addr)!.proxy}  ${e.status.padEnd(6)}  ${e.transfers}x  ${e.originalOwner} → ${e.owner}  ${fmt(e.total).padStart(12)} COMP`);
}
console.log('\n  top 10 proxies:');
for (const [addr, e] of uniq.slice(0, 10)) console.log(`    ${proxies.get(addr)!.proxy}  ${e.status.padEnd(6)}  owner ${e.owner}  ${fmt(e.total).padStart(14)} COMP`);
console.log('\n  top 10 owners (summed over their proxies):');
for (const [o, amt] of [...owners].sort((a, b) => (a[1] > b[1] ? -1 : 1)).slice(0, 10)) console.log(`    ${o}  ${fmt(amt).padStart(14)} COMP`);

const out = process.env.OUT ?? 'output/contango-proxies-in-merkl.csv';
const cols = ['proxy', 'owner', 'originalOwner', 'transfers', 'status', 'totalCOMP', 'totalWei', ...jsonPaths.map((p) => basename(p))];
writeFileSync(out, [cols.join(','), ...uniq.map(([addr, e]) => [proxies.get(addr)!.proxy, e.owner, e.originalOwner, e.transfers, e.status, formatUnits(e.total, COMP_DECIMALS), e.total.toString(), ...jsonPaths.map((p) => (e.files[basename(p)] ?? 0n).toString())].join(','))].join('\n') + '\n');
console.log(`\nWrote ${out}`);

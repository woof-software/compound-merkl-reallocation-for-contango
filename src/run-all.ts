/**
 * Runs the pipeline over every chain.
 *
 *   npm run proxies:all   build proxy → owner mappings for every chain in config
 *   npm run merkl:all     cross-reference each chain's mapping with its files in campaigns/
 *                         (campaigns/rewards-<v2|v3>-<merklChain>-*.merkl.json; Ethereum is "mainnet")
 *   npm run all           both, in order
 */
import { existsSync, readdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { CHAINS } from './config.js';

const CAMPAIGNS_DIR = 'campaigns';
const mode = process.argv[2] ?? 'all';
if (!['proxies', 'merkl', 'all'].includes(mode)) throw new Error(`Unknown mode "${mode}"; use proxies | merkl | all`);

/** Merkl names Ethereum "mainnet"; every other chain key matches. */
const merklName = (key: string) => (key === 'ethereum' ? 'mainnet' : key);
const proxiesCsv = (key: string) => `output/contango-proxy-owners-${key}.csv`;

const run = (args: string[], env: NodeJS.ProcessEnv = {}) =>
  execFileSync('npx', ['tsx', ...args], { stdio: 'inherit', env: { ...process.env, ...env } });

if (mode === 'proxies' || mode === 'all') {
  for (const c of CHAINS) {
    console.log(`\n################ ${c.name}: proxies`);
    run(['src/proxy-owners.ts', c.key, proxiesCsv(c.key)]);
  }
}

if (mode === 'merkl' || mode === 'all') {
  const files = existsSync(CAMPAIGNS_DIR) ? readdirSync(CAMPAIGNS_DIR).filter((f) => f.endsWith('.merkl.json')) : [];
  if (files.length === 0) {
    console.error(`No *.merkl.json files in ${CAMPAIGNS_DIR}/ — drop the Merkl reward files there first.`);
    process.exit(1);
  }
  const missing: string[] = [];
  for (const c of CHAINS) {
    const mine = files.filter((f) => f.match(new RegExp(`^rewards-v\\d+-${merklName(c.key)}-`))).map((f) => `${CAMPAIGNS_DIR}/${f}`);
    if (mine.length === 0) continue;
    if (!existsSync(proxiesCsv(c.key))) { missing.push(c.key); continue; }
    console.log(`\n################ ${c.name}: merkl`);
    run(['src/merkl-cross-ref.ts', proxiesCsv(c.key), ...mine], { OUT: `output/contango-proxies-in-merkl-${c.key}.csv` });
  }
  if (missing.length) {
    console.error(`\nSkipped ${missing.join(', ')}: no proxy mapping yet — run \`npm run proxies:all\` (or \`npm run proxies -- <chain>\`) first.`);
    process.exit(1);
  }
}

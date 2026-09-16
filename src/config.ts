import 'dotenv/config';
import { arbitrum, base, mainnet, optimism, polygon } from 'viem/chains';
import type { Address, Chain } from 'viem';

/** Contango core (emits UnderlyingPositionCreated). Deployed deterministically — same address on every chain. */
export const CONTANGO: Address = '0xDaBA83815404f5e1bc33f5885db7D96F51e127F5';
/** Contango position NFT (ERC-721; tokenId == uint256(positionId)). Same address on every chain. */
export const POSITION_NFT: Address = '0xC2462f03920D47fC5B9e2C5F0ba5D2ded058fD78';

export const COMP_DECIMALS = 18;

export interface ChainConfig {
  key: string;
  name: string;
  chain: Chain;
  rpcEnv: string;
}

export const CHAINS: ChainConfig[] = [
  { key: 'ethereum', name: 'Ethereum', chain: mainnet,  rpcEnv: 'RPC_MAINNET' },
  { key: 'base',     name: 'Base',     chain: base,     rpcEnv: 'RPC_BASE' },
  { key: 'arbitrum', name: 'Arbitrum', chain: arbitrum, rpcEnv: 'RPC_ARBITRUM' },
  { key: 'polygon',  name: 'Polygon',  chain: polygon,  rpcEnv: 'RPC_POLYGON' },
  { key: 'optimism', name: 'Optimism', chain: optimism, rpcEnv: 'RPC_OPTIMISM' },
];

export function getChain(key: string): ChainConfig {
  const c = CHAINS.find((c) => c.key === key);
  if (!c) throw new Error(`Unknown chain "${key}"; use one of ${CHAINS.map((c) => c.key).join(', ')}`);
  return c;
}

export function rpcUrl(c: ChainConfig): string {
  const url = process.env[c.rpcEnv];
  if (!url) throw new Error(`Missing env var ${c.rpcEnv} for ${c.name}`);
  return url;
}

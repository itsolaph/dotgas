import {
  createPublicClient,
  createWalletClient,
  custom,
  http,
  numberToHex,
  type Address,
  type Chain,
  type EIP1193Provider,
  type WalletClient,
} from 'viem';
import { baseChain, portaldotChain } from './config.ts';

declare global {
  interface Window {
    ethereum?: EIP1193Provider;
  }
}

export const basePublic = createPublicClient({ chain: baseChain, transport: http() });
export const portaldotPublic = createPublicClient({ chain: portaldotChain, transport: http() });

export function hasWallet() {
  return typeof window !== 'undefined' && !!window.ethereum;
}

export async function connect(): Promise<Address> {
  if (!window.ethereum) throw new Error('No injected wallet found. Install MetaMask.');
  const [addr] = (await window.ethereum.request({ method: 'eth_requestAccounts' })) as Address[];
  return addr;
}

export function walletFor(chain: Chain, account: Address): WalletClient {
  return createWalletClient({ chain, account, transport: custom(window.ethereum!) });
}

/** Switch MetaMask to `chain`, adding it first if the wallet does not know it yet. */
export async function ensureChain(chain: Chain) {
  const eth = window.ethereum!;
  const chainId = numberToHex(chain.id);
  try {
    await eth.request({ method: 'wallet_switchEthereumChain', params: [{ chainId }] });
  } catch (err) {
    const code = (err as { code?: number }).code;
    if (code !== 4902 && code !== -32603) throw err;
    await eth.request({
      method: 'wallet_addEthereumChain',
      params: [
        {
          chainId,
          chainName: chain.name,
          nativeCurrency: chain.nativeCurrency,
          rpcUrls: chain.rpcUrls.default.http as string[],
          blockExplorerUrls: chain.blockExplorers ? [chain.blockExplorers.default.url] : undefined,
        },
      ],
    });
  }
}

export function shortHex(h?: string | null, n = 6) {
  if (!h) return '';
  return h.length <= 2 * n + 2 ? h : `${h.slice(0, n + 2)}…${h.slice(-n)}`;
}

import { createClient, chains } from 'genlayer-js';
import { TransactionHashVariant, TransactionStatus } from 'genlayer-js/types';
import { parseGenToWei, formatWeiToGen, sanitizeGenInput, WEI_PER_GEN } from './money.js';
import {
  unwrapViewResult,
  normalizeOrderList,
  normalizeOrderRow,
  parseCount,
  resolveReadAccount,
  studioRpcUrl,
  formatWalletError,
} from './orderPoll.js';

export { formatWalletError } from './orderPoll.js';
export { parseGenToWei, formatWeiToGen, sanitizeGenInput, WEI_PER_GEN };
export { unwrapViewResult, normalizeOrderList, parseCount } from './orderPoll.js';

const ZERO = '0x0000000000000000000000000000000000000000';
const rawAddress = (import.meta.env.VITE_CONTRACT_ADDRESS || '').trim();

export const CONTRACT_ADDRESS = rawAddress || ZERO;
export const EXPLORER_BASE = 'https://explorer-studio.genlayer.com';

export const hasContractAddress = Boolean(
  rawAddress &&
  rawAddress !== ZERO &&
  /^0x[0-9a-fA-F]{40}$/.test(rawAddress)
);

export const studionet = chains.studionet;

const LATEST_VISIBLE = TransactionHashVariant.LATEST_NONFINAL;

export const txExplorerUrl = (hash) => {
  if (!hash) return EXPLORER_BASE;
  return `${EXPLORER_BASE}/tx/${hash}`;
};

export const addressExplorerUrl = (addr) => {
  if (!addr) return EXPLORER_BASE;
  return `${EXPLORER_BASE}/address/${addr}`;
};

function studioChain() {
  const origin = typeof window !== 'undefined' ? window.location.origin : '';
  const endpoint = studioRpcUrl(origin);
  return {
    ...studionet,
    rpcUrls: {
      default: {
        http: [endpoint],
      },
    },
  };
}

function makeClient(extra = {}) {
  return createClient({
    chain: studioChain(),
    ...extra,
  });
}

export const getReadClient = () => {
  try {
    return makeClient({
      account: resolveReadAccount(null).address,
    });
  } catch (err) {
    console.warn('Read client init failed:', err);
    return null;
  }
};

export const getWriteClient = (account) => {
  if (typeof window === 'undefined' || !window.ethereum) {
    throw new Error('MetaMask is required to sign CargoVerdict transactions.');
  }
  const resolved = resolveReadAccount(account);
  return makeClient({
    account: resolved.address,
    provider: window.ethereum,
  });
};

export async function ensureStudioNetwork() {
  if (typeof window === 'undefined' || !window.ethereum) {
    throw new Error('MetaMask is required to sign CargoVerdict transactions.');
  }
  const chainIdHex = `0x${studionet.id.toString(16)}`;
  const current = await window.ethereum.request({ method: 'eth_chainId' });
  if (String(current).toLowerCase() === chainIdHex.toLowerCase()) return;

  try {
    await window.ethereum.request({
      method: 'wallet_switchEthereumChain',
      params: [{ chainId: chainIdHex }],
    });
    return;
  } catch (err) {
    const missing = err?.code === 4902 || String(err?.message || '').toLowerCase().includes('unrecognized chain');
    if (!missing) throw err;
  }

  await window.ethereum.request({
    method: 'wallet_addEthereumChain',
    params: [{
      chainId: chainIdHex,
      chainName: studionet.name || 'Genlayer Studio Network',
      nativeCurrency: studionet.nativeCurrency || { name: 'GEN Token', symbol: 'GEN', decimals: 18 },
      rpcUrls: [studioRpcUrl(window.location.origin)],
      blockExplorerUrls: studionet.blockExplorers?.default?.url
        ? [studionet.blockExplorers.default.url]
        : [EXPLORER_BASE],
    }],
  });
}

export const getListClient = (account) => {
  if (account && typeof window !== 'undefined' && window.ethereum) {
    try {
      return getWriteClient(account);
    } catch (err) {
      console.warn('Write client unavailable for reads:', err);
    }
  }
  return getReadClient();
};

export async function readView(client, functionName, args = [], fromAddress) {
  if (!client) throw new Error('No GenLayer client');
  const res = await client.readContract({
    address: CONTRACT_ADDRESS,
    functionName,
    args,
    account: resolveReadAccount(fromAddress || client.account),
    transactionHashVariant: LATEST_VISIBLE,
  });
  return unwrapViewResult(res);
}

export async function loadOrders(client, fromAddress) {
  let rows = [];
  let listError = null;
  try {
    rows = normalizeOrderList(await readView(client, 'list_orders', [], fromAddress));
  } catch (err) {
    listError = err;
  }

  if (rows.length) {
    return { rows, count: rows.length, listError: null };
  }

  let count = 0;
  try {
    const parsed = parseCount(await readView(client, 'get_order_count', [], fromAddress));
    if (parsed !== null) count = parsed;
  } catch (err) {
    console.warn('get_order_count failed:', err);
    return { rows, count: 0, listError: listError || err };
  }

  if (count > 0) {
    const filled = [];
    for (let i = 0; i < count; i += 1) {
      try {
        const row = normalizeOrderRow(
          await readView(client, 'get_order', [String(i)], fromAddress),
          String(i)
        );
        if (row) filled.push(row);
      } catch (err) {
        console.warn(`get_order(${i}) failed:`, err);
      }
    }
    if (filled.length) rows = filled;
  }

  return { rows, count, listError: rows.length ? null : listError };
}

export const waitForTx = async (client, hash) => {
  if (!hash) return null;
  if (client && typeof client.waitForTransactionReceipt === 'function') {
    try {
      return await client.waitForTransactionReceipt({
        hash,
        status: TransactionStatus.ACCEPTED,
        retries: 40,
        interval: 2000,
      });
    } catch (err) {
      console.warn('wait ACCEPTED note:', err);
    }
    try {
      return await client.waitForTransactionReceipt({
        hash,
        status: TransactionStatus.FINALIZED,
        retries: 20,
        interval: 2000,
      });
    } catch (err) {
      console.warn('wait FINALIZED note:', err);
    }
  }
  return hash;
};

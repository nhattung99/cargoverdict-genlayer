export const STUDIO_RPC = 'https://studio.genlayer.com/api';
export const VIEW_FROM = '0x0000000000000000000000000000000000000001';

export function studioRpcUrl(origin) {
  if (!origin || typeof origin !== 'string') return STUDIO_RPC;
  return `${origin.replace(/\/$/, '')}/api/genlayer`;
}

export function formatWalletError(err, fallback = 'Wallet request failed') {
  const raw = `${err?.shortMessage || ''} ${err?.details || ''} ${err?.message || ''}`.toLowerCase();
  if (raw.includes('user rejected') || raw.includes('user denied') || raw.includes('user cancel')) {
    return 'MetaMask cancelled the request. Switch to Genlayer Studio Network, then click Confirm — do not Reject.';
  }
  if (raw.includes('no address provided') || raw.includes('no account')) {
    return 'Connect a wallet first, then try again.';
  }
  if (raw.includes('unrecognized chain') || raw.includes('chain disconnected') || raw.includes('4902')) {
    return 'Approve adding Genlayer Studio Network in MetaMask, then retry the transaction.';
  }
  return err?.shortMessage || err?.message || fallback;
}

export function sameAddress(a, b) {
  if (!a || !b) return false;
  return String(a).trim().toLowerCase() === String(b).trim().toLowerCase();
}

export function resolveReadAccount(account) {
  if (typeof account === 'string' && /^0x[0-9a-fA-F]{40}$/.test(account)) {
    return { address: account };
  }
  if (account && typeof account === 'object' && typeof account.address === 'string') {
    return { address: account.address };
  }
  return { address: VIEW_FROM };
}

export function unwrapViewResult(res) {
  if (res === null || res === undefined) return res;
  if (typeof res === 'bigint') return Number(res);
  if (typeof res === 'number' || typeof res === 'boolean') return res;
  if (res instanceof Uint8Array) {
    return unwrapViewResult(new TextDecoder().decode(res));
  }
  if (res instanceof Map) {
    return unwrapViewResult(Object.fromEntries(res));
  }
  if (typeof res === 'object') {
    if (Array.isArray(res)) return res.map((item) => unwrapViewResult(item));
    if ('result' in res) return unwrapViewResult(res.result);
    if ('data' in res && (typeof res.data === 'string' || Array.isArray(res.data))) {
      return unwrapViewResult(res.data);
    }
    return res;
  }
  if (typeof res !== 'string') return res;

  const trimmed = res.trim();
  if (/^0x[0-9a-fA-F]+$/.test(trimmed) && trimmed.length > 4 && trimmed.length % 2 === 0) {
    try {
      const hex = trimmed.slice(2);
      const bytes = new Uint8Array(hex.length / 2);
      for (let i = 0; i < bytes.length; i += 1) {
        bytes[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
      }
      const text = new TextDecoder().decode(bytes).trim();
      if (text.startsWith('[') || text.startsWith('{') || /^\d+$/.test(text)) {
        return unwrapViewResult(text);
      }
    } catch {
      // keep original string
    }
  }
  if (
    (trimmed.startsWith('{') && trimmed.endsWith('}')) ||
    (trimmed.startsWith('[') && trimmed.endsWith(']')) ||
    (trimmed.startsWith('"') && trimmed.endsWith('"'))
  ) {
    try {
      return unwrapViewResult(JSON.parse(trimmed));
    } catch {
      return trimmed;
    }
  }
  return trimmed;
}

export function normalizeOrderRow(row, fallbackId) {
  if (row === null || row === undefined) return null;
  const unwrapped = unwrapViewResult(row);
  if (!unwrapped || typeof unwrapped !== 'object' || Array.isArray(unwrapped)) return null;
  const id = unwrapped.order_id ?? unwrapped.id ?? fallbackId;
  if (id === null || id === undefined || id === '') return null;
  return { ...unwrapped, order_id: String(id) };
}

export function normalizeOrderList(raw) {
  const unwrapped = unwrapViewResult(raw);
  if (Array.isArray(unwrapped)) {
    return unwrapped
      .map((row, index) => normalizeOrderRow(row, String(index)))
      .filter(Boolean);
  }
  if (unwrapped && typeof unwrapped === 'object' && Array.isArray(unwrapped.orders)) {
    return normalizeOrderList(unwrapped.orders);
  }
  const single = normalizeOrderRow(unwrapped);
  return single ? [single] : [];
}

export function parseCount(raw) {
  const unwrapped = unwrapViewResult(raw);
  if (typeof unwrapped === 'number' && Number.isFinite(unwrapped)) return unwrapped;
  if (typeof unwrapped === 'string' && /^\d+$/.test(unwrapped)) return Number(unwrapped);
  if (unwrapped && typeof unwrapped === 'object' && unwrapped.count != null) {
    return parseCount(unwrapped.count);
  }
  return null;
}

export function extractCreatedId(writeResult) {
  const unwrapped = unwrapViewResult(writeResult);
  if (unwrapped == null) return null;
  if (typeof unwrapped === 'number' && Number.isInteger(unwrapped) && unwrapped >= 0) {
    return String(unwrapped);
  }
  if (typeof unwrapped === 'string') {
    const trimmed = unwrapped.trim();
    if (/^\d+$/.test(trimmed)) return trimmed;
    return null;
  }
  if (typeof unwrapped === 'object') {
    const id = unwrapped.order_id ?? unwrapped.id;
    if (id != null && /^\d+$/.test(String(id))) return String(id);
  }
  return null;
}

export function shouldKeepPolling({ previousCount = 0, currentCount, rows } = {}) {
  const listed = Array.isArray(rows) ? rows.length : 0;
  if (listed > previousCount) return false;
  if (typeof currentCount === 'number' && currentCount > previousCount && listed > 0) return false;
  return true;
}

export async function pollUntilListed({
  load,
  previousCount = 0,
  attempts = 12,
  intervalMs = 2000,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
}) {
  let last = { rows: [], count: previousCount };
  for (let i = 0; i < attempts; i += 1) {
    last = await load();
    if (!shouldKeepPolling({ previousCount, currentCount: last.count, rows: last.rows })) {
      return last;
    }
    if (i < attempts - 1) await sleep(intervalMs);
  }
  return last;
}

export async function pollUntilOrderLeavesStatus({
  loadOrder,
  fromStatus,
  attempts = 36,
  intervalMs = 5000,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
}) {
  let last = null;
  for (let i = 0; i < attempts; i += 1) {
    last = await loadOrder();
    const status = String(last?.status || '');
    if (status && status !== fromStatus) return last;
    if (i < attempts - 1) await sleep(intervalMs);
  }
  return last;
}

export function deadlineUnixFromDays(days) {
  const nowSec = BigInt(Date.now()) / 1000n;
  return nowSec + BigInt(days) * 86400n;
}

export function formatDeadline(unixStr) {
  const raw = String(unixStr || '').trim();
  if (!/^\d+$/.test(raw)) return '—';
  const ms = Number(raw + '000');
  if (!Number.isFinite(ms)) return raw;
  try {
    return new Date(ms).toUTCString();
  } catch {
    return raw;
  }
}

export const FLOW_STEPS = [
  { id: 'create', label: '1. Create' },
  { id: 'ship', label: '2. Seller ships' },
  { id: 'report', label: '3. Buyer reports' },
  { id: 'ai', label: '4. AI verdict' },
];

export function flowCurrentStep(status) {
  const s = String(status || '');
  if (s === 'AWAITING_SHIPMENT') return 'ship';
  if (s === 'SHIPPED' || s === 'DISPUTED') return 'report';
  if (s === 'DELIVERY_REPORTED') return 'ai';
  if (s === 'RESOLVED' || s === 'PAYOUT_FAILED' || s === 'EXPIRED_REFUNDED') return 'done';
  return 'create';
}

export function nextActionHint({ status, isBuyer, isSeller, seller = '', buyer = '' } = {}) {
  const s = String(status || '');
  if (s === 'AWAITING_SHIPMENT') {
    if (isSeller) {
      return {
        title: 'Your turn — confirm shipment',
        body: 'Paste at least 1 origin-condition URL (click Example), then Confirm shipment. The buyer wallet cannot do this step.',
      };
    }
    return {
      title: 'Next: seller confirms shipment',
      body: `This wallet is the buyer. In MetaMask switch to the seller ${seller || 'wallet'}, then click Refresh. Origin URL fields and Confirm shipment appear only for the seller.`,
    };
  }
  if (s === 'SHIPPED' || s === 'DISPUTED') {
    if (isBuyer) {
      return {
        title: s === 'DISPUTED' ? 'Your turn — report stronger evidence' : 'Your turn — report delivery',
        body: 'Paste 1 delivery URL and 2 reference URLs (click Example on each), then Report delivery.',
      };
    }
    return {
      title: 'Next: buyer reports delivery',
      body: `Switch MetaMask to the buyer ${buyer || 'wallet'}, then click Refresh. Report delivery is buyer-only.`,
    };
  }
  if (s === 'DELIVERY_REPORTED') {
    return {
      title: 'Next: request AI adjudication',
      body: 'Keep this tab open for 2–5 minutes. Either party can start it. If it stays on DELIVERY_REPORTED, replace URLs with the Example chips and report again.',
    };
  }
  if (s === 'PAYOUT_FAILED') {
    return {
      title: 'Payout incomplete',
      body: 'Buyer or seller can retry the unpaid side. AI will not run again.',
    };
  }
  if (s === 'RESOLVED' || s === 'EXPIRED_REFUNDED') {
    return {
      title: 'Order finished',
      body: s === 'EXPIRED_REFUNDED' ? 'Seller never shipped. Full escrow returned to the buyer.' : 'Escrow followed the AI verdict.',
    };
  }
  return {
    title: 'Create an order',
    body: 'Buyer locks GEN, then the seller confirms shipment.',
  };
}

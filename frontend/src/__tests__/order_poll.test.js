import {
  VIEW_FROM,
  STUDIO_RPC,
  studioRpcUrl,
  formatWalletError,
  sameAddress,
  resolveReadAccount,
  unwrapViewResult,
  normalizeOrderList,
  normalizeOrderRow,
  parseCount,
  extractCreatedId,
  shouldKeepPolling,
  deadlineUnixFromDays,
  pollUntilOrderLeavesStatus,
  FLOW_STEPS,
  flowCurrentStep,
  nextActionHint,
} from '../orderPoll.js';
import {
  EXAMPLE_ORIGIN_URL,
  EXAMPLE_DELIVERY_URL,
  EXAMPLE_REFERENCE_URLS,
} from '../data/presets.js';

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

function assertEqual(actual, expected, msg) {
  const left = JSON.stringify(actual);
  const right = JSON.stringify(expected);
  if (left !== right) throw new Error(`${msg}: expected ${right}, got ${left}`);
}

const order = {
  order_id: '0',
  status: 'AWAITING_SHIPMENT',
  escrow_amount: '1000',
  damaged_payout_to_seller: '700',
};

async function runOrderPollTests() {
  console.log('Starting order poll / list tests...');

  assertEqual(studioRpcUrl(undefined), STUDIO_RPC, 'node uses Studio RPC');
  assertEqual(studioRpcUrl('https://cargoverdict.vercel.app'), 'https://cargoverdict.vercel.app/api/genlayer', 'browser uses same-origin proxy');
  assertEqual(studioRpcUrl('http://localhost:3000/'), 'http://localhost:3000/api/genlayer', 'local proxy');

  assert(
    formatWalletError({ message: 'User rejected the request. Details: user cancel Version: viem@2.55.19' }).includes('Confirm'),
    'rejected wallet request is explained'
  );
  assert(sameAddress('0xAbc', '0xabc') === true, 'same address ignores case');
  assert(sameAddress('0xabc', '0xdef') === false, 'different addresses');

  assertEqual(resolveReadAccount(undefined).address, VIEW_FROM, 'missing account uses view from');
  assertEqual(resolveReadAccount('0xabc').address, VIEW_FROM, 'short address rejected');
  assertEqual(
    resolveReadAccount('0x0000000000000000000000000000000000000002').address,
    '0x0000000000000000000000000000000000000002',
    'wallet address passed through'
  );

  assertEqual(unwrapViewResult('[]'), [], 'empty JSON array');
  assertEqual(unwrapViewResult(JSON.stringify([order]))[0].order_id, '0', 'JSON list string');
  assertEqual(unwrapViewResult({ result: JSON.stringify([order]) })[0].status, 'AWAITING_SHIPMENT', 'wrapped result');
  assertEqual(unwrapViewResult(2n), 2, 'bigint count');
  assertEqual(parseCount('3'), 3, 'count string');

  assertEqual(normalizeOrderList([order]).length, 1, 'native order array');
  assertEqual(normalizeOrderRow({ id: 7, status: 'SHIPPED' }).order_id, '7', 'fallback id field');

  assertEqual(extractCreatedId('0'), '0', 'create returns id string');
  assertEqual(extractCreatedId({ order_id: '1' }), '1', 'create returns object');
  assertEqual(extractCreatedId('0xabc123'), null, 'hash is not an id');

  assert(shouldKeepPolling({ previousCount: 0, currentCount: 0, rows: [] }) === true, 'keep polling while empty');
  assert(shouldKeepPolling({ previousCount: 0, currentCount: 1, rows: [order] }) === false, 'stop when list grows');

  let n = 0;
  const settled = await pollUntilOrderLeavesStatus({
    fromStatus: 'DELIVERY_REPORTED',
    attempts: 5,
    intervalMs: 1,
    sleep: async () => {},
    loadOrder: async () => {
      n += 1;
      return n < 3 ? { status: 'DELIVERY_REPORTED' } : { status: 'RESOLVED', verdict: 'DAMAGED' };
    },
  });
  assert(settled.verdict === 'DAMAGED', 'poll stops when status leaves DELIVERY_REPORTED');
  assert(n === 3, 'poll retries until status changes');

  const d7 = deadlineUnixFromDays(7);
  const d14 = deadlineUnixFromDays(14);
  assert(d14 - d7 === 7n * 86400n, 'deadline presets differ by exact whole days');

  const sampleUrls = [EXAMPLE_ORIGIN_URL, EXAMPLE_DELIVERY_URL, ...EXAMPLE_REFERENCE_URLS].join(' ').toLowerCase();
  assert(!sampleUrls.includes('wikipedia'), 'sample URLs must be tiny public pages, not Wikipedia');
  assert(EXAMPLE_REFERENCE_URLS.length >= 2, 'need two independent reference examples');
  assert(EXAMPLE_ORIGIN_URL.startsWith('https://'), 'origin example is https');
  assert(EXAMPLE_DELIVERY_URL.startsWith('https://'), 'delivery example is https');

  assertEqual(flowCurrentStep('AWAITING_SHIPMENT'), 'ship', 'created order waits on seller');
  assertEqual(flowCurrentStep('SHIPPED'), 'report', 'shipped waits on buyer report');
  assertEqual(flowCurrentStep('DELIVERY_REPORTED'), 'ai', 'reported waits on AI');
  assertEqual(flowCurrentStep('RESOLVED'), 'done', 'resolved is finished');
  assert(FLOW_STEPS.length === 4, 'four visible flow steps');

  const buyerWait = nextActionHint({
    status: 'AWAITING_SHIPMENT',
    isBuyer: true,
    isSeller: false,
    seller: '0x20bd000000000000000000000000000000005988',
  });
  assert(buyerWait.title.toLowerCase().includes('seller'), 'buyer sees seller is next');
  assert(buyerWait.body.includes('0x20bd'), 'buyer hint names the seller address');

  const sellerTurn = nextActionHint({
    status: 'AWAITING_SHIPMENT',
    isBuyer: false,
    isSeller: true,
  });
  assert(sellerTurn.title.toLowerCase().includes('confirm shipment'), 'seller sees confirm shipment');

  console.log('All order poll / list tests passed.');
}

runOrderPollTests().catch((err) => {
  console.error(err);
  process.exit(1);
});

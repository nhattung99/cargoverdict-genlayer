import {
  parseGenToWei,
  formatWeiToGen,
  sanitizeGenInput,
  percentOfWei,
  damagedPayoutValid,
  settlementPreview,
} from '../money.js';

function assert(cond, msg) {
  if (!cond) {
    throw new Error(msg);
  }
}

function runUnitConversionTests() {
  console.log('Starting Precision Unit Conversion Tests...');

  const smallestWei = parseGenToWei('0.000000000000000001');
  assert(smallestWei === 1n, `Test 1 Failed: expected 1n, got ${smallestWei}`);
  assert(formatWeiToGen(1n) === '0.000000000000000001', `Test 1 Format Failed: got ${formatWeiToGen(1n)}`);

  const pointOneWei = parseGenToWei('0.1');
  assert(pointOneWei === 100000000000000000n, `Test 2 Failed: got ${pointOneWei}`);
  assert(formatWeiToGen(100000000000000000n) === '0.1', `Test 2 Format Failed`);

  const millionWei = parseGenToWei('1000000');
  assert(millionWei === 1000000000000000000000000n, `Test 3 Failed: got ${millionWei}`);
  assert(formatWeiToGen(1000000000000000000000000n) === '1000000', `Test 3 Format Failed`);

  const testValues = ['1', '0.5', '100.25', '0.000001', '30000'];
  for (const val of testValues) {
    const wei = parseGenToWei(val);
    const formatted = formatWeiToGen(wei);
    assert(formatted === val, `Round-trip Failed for ${val}: got ${formatted}`);
  }

  assert(parseGenToWei('') === 0n, 'empty should be 0n');
  assert(parseGenToWei('abc') === 0n, 'invalid should be 0n');
  assert(formatWeiToGen(0n) === '0', 'zero format');
  assert(sanitizeGenInput('12.3abc4') === '12.34', 'sanitize strips letters');

  const escrow = parseGenToWei('10');
  const half = percentOfWei(escrow, 50);
  assert(half === parseGenToWei('5'), `50% of 10 GEN should be 5 GEN, got ${formatWeiToGen(half)}`);
  const seventy = percentOfWei(escrow, 70);
  assert(seventy === (escrow * 70n) / 100n, '70% must be integer BigInt division');
  assert(damagedPayoutValid(escrow, half) === true, 'half of escrow is a valid damaged payout');
  assert(damagedPayoutValid(escrow, 0n) === false, 'zero damaged blocked');
  assert(damagedPayoutValid(escrow, escrow) === false, 'equal to escrow blocked');
  assert(percentOfWei(1n, 50) === 0n, 'tiny escrow cannot hint a valid damaged payout');
  assert(percentOfWei(escrow, 100) === escrow - 1n, '100% hint is clamped strictly below escrow');

  const damagedOrder = {
    escrow_amount: '1000',
    damaged_payout_to_seller: '700',
    verdict: 'DAMAGED',
  };
  const split = settlementPreview(damagedOrder);
  assert(split.seller === 700n, 'DAMAGED seller gets the stored fixed payout');
  assert(split.buyer === 300n, 'DAMAGED buyer refund is escrow minus fixed payout');

  const intact = settlementPreview({ ...damagedOrder, verdict: 'DELIVERED_INTACT' });
  assert(intact.seller === 1000n && intact.buyer === 0n, 'intact pays full escrow to seller');

  const missing = settlementPreview({ ...damagedOrder, verdict: 'NOT_DELIVERED' });
  assert(missing.seller === 0n && missing.buyer === 1000n, 'not delivered refunds buyer in full');

  console.log('All precision unit conversion tests passed.');
}

runUnitConversionTests();

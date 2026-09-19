export const ESCROW_PRESETS = ['0.1', '0.5', '1', '2', '5', '10'];
export const DAMAGED_PCT_PRESETS = [50, 70, 80];
export const DEADLINE_PRESETS = [
  { days: 7, label: '7 days', reportDays: 14 },
  { days: 14, label: '14 days', reportDays: 21 },
  { days: 30, label: '30 days', reportDays: 45 },
];

/** Seller pins these at Confirm shipment — buyer cannot replace them. */
export const EXAMPLE_ORIGIN_URL = 'https://example.com';
export const EXAMPLE_REFERENCE_URLS = [
  'https://example.net',
  'https://www.rfc-editor.org/rfc/rfc2606.txt',
];
/** Buyer only attaches delivery evidence after shipment. */
export const EXAMPLE_DELIVERY_URL = 'https://example.org';

export const GOODS_HINT = 'Factory-new industrial sewing machines, 4 units, packed in sealed wooden crates.';

/** Ready-to-submit demo order. Seller address is left blank so buyer pastes a second wallet. */
export const SAMPLE_ORDER = {
  goods: 'Factory-new Juki industrial sewing machines, 4 units, packed in sealed wooden crates with foam corners. Serial tags visible on crate photos. Destination: Ho Chi Minh City warehouse.',
  escrow: '1',
  damaged: '0.7',
  deadlineDays: 14,
  reportDays: 21,
};

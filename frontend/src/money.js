const WEI_PER_GEN = 1000000000000000000n;

export const parseGenToWei = (genAmountStr) => {
  if (!genAmountStr) return 0n;
  const str = String(genAmountStr).trim();
  if (!/^\d+(\.\d+)?$/.test(str)) return 0n;
  const [intPart, fracPartRaw = ""] = str.split(".");
  const fracPart = (fracPartRaw + "0".repeat(18)).slice(0, 18);
  const wei = BigInt(intPart + fracPart);
  return wei > 0n ? wei : 0n;
};

export const formatWeiToGen = (val) => {
  if (val === null || val === undefined || val === '') return '0';
  let wei;
  try { wei = BigInt(val); } catch { return String(val); }
  if (wei === 0n) return '0';
  const intPart = wei / WEI_PER_GEN;
  const fracPart = wei % WEI_PER_GEN;
  if (fracPart === 0n) return intPart.toString();
  const fracStr = fracPart.toString().padStart(18, "0").replace(/0+$/, "");
  return fracStr.length > 0 ? `${intPart}.${fracStr}` : intPart.toString();
};

export const sanitizeGenInput = (raw) => {
  const str = String(raw ?? '');
  let out = '';
  let seenDot = false;
  let fracCount = 0;
  for (const ch of str) {
    if (ch >= '0' && ch <= '9') {
      if (seenDot) {
        if (fracCount >= 18) continue;
        fracCount += 1;
      }
      out += ch;
    } else if (ch === '.' && !seenDot) {
      seenDot = true;
      out += ch;
    }
  }
  return out;
};

export const toWeiString = (val) => {
  if (val === null || val === undefined || val === '') return '0';
  if (typeof val === 'bigint') return val.toString();
  if (typeof val === 'number') return '0';
  const str = String(val).trim();
  if (!/^\d+$/.test(str)) return '0';
  return str;
};

export const weiFromOrderField = (val) => {
  try {
    return BigInt(toWeiString(val));
  } catch {
    return 0n;
  }
};

/** Integer-only hint: (escrow * pct) / 100, clamped to 0 < x < escrow. */
export const percentOfWei = (escrowWei, pctInt) => {
  if (escrowWei <= 1n) return 0n;
  const hinted = (escrowWei * BigInt(pctInt)) / 100n;
  if (hinted <= 0n) return 0n;
  if (hinted >= escrowWei) return escrowWei - 1n;
  return hinted;
};

export const damagedPayoutValid = (escrowWei, damagedWei) => {
  return damagedWei > 0n && damagedWei < escrowWei;
};

export const settlementPreview = (order) => {
  const escrow = weiFromOrderField(order?.escrow_amount);
  const damaged = weiFromOrderField(order?.damaged_payout_to_seller);
  const verdict = String(order?.verdict || '').toUpperCase();
  if (verdict === 'DELIVERED_INTACT') {
    return { seller: escrow, buyer: 0n };
  }
  if (verdict === 'DAMAGED') {
    return { seller: damaged, buyer: escrow - damaged };
  }
  if (verdict === 'NOT_DELIVERED') {
    return { seller: 0n, buyer: escrow };
  }
  return { seller: 0n, buyer: 0n };
};

export const payoutSideLabel = (amountWei, alreadyPaid, paidWord) => {
  if (amountWei <= 0n) return '(none)';
  return alreadyPaid ? `(${paidWord})` : '(pending)';
};

export { WEI_PER_GEN };

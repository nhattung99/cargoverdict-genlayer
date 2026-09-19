# CargoVerdict — Neutral B2B shipment escrow on GenLayer

Small importers paying a new overseas seller before goods arrive face a classic trap: cargo never shows, arrives wrong, or arrives damaged, and no intermediary is cheap enough to referee each small order.

CargoVerdict holds **real GEN** in **one Intelligent Contract**. Buyer and seller lock two **fixed** amounts at create time:

- `escrow_amount` — paid in full to the seller if goods arrive intact
- `damaged_payout_to_seller` — the pre-agreed compensation if goods arrive damaged (not a %, a concrete wei integer both parties chose)

GenLayer AI then returns **exactly one of three discrete verdicts**:

`DELIVERED_INTACT` · `DAMAGED` · `NOT_DELIVERED`

There is no percentage, no multiplication, and no rounding on money in the contract.

> CargoVerdict dies without GenLayer: no EVM contract can read unstructured photos and shipment pages to compare origin vs delivery, and no third party is cheap enough to referee lots of small first-time B2B orders. Only GenLayer's decentralized AI consensus can do this at near-zero cost.

## Live App

https://cargoverdict-genlayer.vercel.app

## Deployed Contract

- **Network:** studionet (GenLayer Studio hosted)
- **Address:** _redeploy required_ — paste the new Studio address after deploying the neutral-evidence + seller-timeout bytecode
- **Explorer:** https://explorer-studio.genlayer.com/

Previous address `0xDf29CAA5e86918E31f05E20d4A26785c806Ef27f` is the pre-rejection bytecode (buyer-controlled references). Do not resubmit against it.

If `VITE_CONTRACT_ADDRESS` is unset locally, the frontend still boots in preview mode (banner, no white crash) and writes stay disabled.

---

## Why discrete verdicts + a fixed DAMAGED payout

JobVerdict was rejected because %-tolerance consensus let two validators “agree” while settling **two different amounts**. ClaimVerdict then burned many fix rounds on percentage math.

| Design | Validator check | Settlement |
|---|---|---|
| Continuous % ± tolerance | scores can pass while amounts differ | two different GEN numbers |
| **CargoVerdict** | `verdict == verdict` on 3 values | lookup of amounts frozen at `create_order` |

`DAMAGED` always pays the stored `damaged_payout_to_seller` and refunds `escrow_amount - damaged_payout_to_seller`. Validators also must agree on the **confidence branch** (`>= 60` settle vs `DISPUTED`). Still no numeric interpolation of money.

UI chips that say “50% / 70% / 80% of escrow” are **display-only BigInt integer division** (`(escrow * pct) / 100`). The value sent on-chain is the resulting wei integer via `parseGenToWei`.

---

## Why one contract

Multi-contract layouts previously trapped GEN when a cross-contract call did not forward `value`. CargoVerdict keeps funds here only:

1. Buyer sends GEN with `create_order` (`gl.message.value`).
2. On resolve / expiry the contract pays with `gl.get_contract_at(recipient).emit_transfer(value=u256(amount))`.

No treasury hop. No value-forward bug.

---

## Resolution flow

1. **Create order** — buyer sets goods description, seller, `damaged_payout_to_seller`, `shipment_deadline`, `delivery_report_deadline` (must be after ship deadline), and locks `escrow_amount` GEN.
2. **Submit shipment** — seller attaches ≥1 origin-condition URL **and ≥2 independent reference URLs** (carrier/customs). References are **locked** — the buyer cannot change them. Status → `SHIPPED`.
3. **Report delivery** — buyer attaches ≥1 delivery evidence URL only. Status → `DELIVERY_REPORTED`. Also allowed from `DISPUTED` and `DELIVERY_REPORTED` (replace delivery evidence only).
4. **Resolve** — `resolve_order` runs `gl.vm.run_nondet`:
   - Leader fetches seller-pinned references first, then origin and buyer delivery pages (`FETCH_FAILED` stays in the prompt — no rollback).
   - AI must prioritize seller-pinned references. Irrelevant / failed pages → confidence 0 → `DISPUTED` (not an automatic buyer refund).
   - Validator: absolute `verdict ==` and the same `confidence >= 60` branch.
5. `confidence < 60` (or unparseable JSON) → `DISPUTED`. Buyer may re-report delivery evidence only.
6. Valid verdict → `_execute_settlement`:
   - `DELIVERED_INTACT` → seller gets `escrow_amount`
   - `DAMAGED` → seller gets `damaged_payout_to_seller`, buyer gets the remainder
   - `NOT_DELIVERED` → buyer gets `escrow_amount` (only when seller-pinned refs affirmatively show non-delivery)
7. Each side has its own flag (`seller_paid` / `buyer_refunded`). A transfer fail sets `PAYOUT_FAILED`. `retry_resolution` **only retries the unpaid side**.
8. If the seller never ships before `shipment_deadline`, buyer calls `claim_no_shipment_refund` (no AI).
9. If the buyer never reports before `delivery_report_deadline` while status is `SHIPPED`, seller calls `claim_unreported_delivery` → full escrow to seller (`SELLER_TIMEOUT_PAID`).

---

## Verified APIs

| Need | API used | Do not use |
|---|---|---|
| Caller | `gl.message.sender_address` | `gl.message.sender` |
| Pay GEN | `gl.get_contract_at(addr).emit_transfer(value=u256(amount))` | `gl.transfer(...)` |
| Receive GEN | `@gl.public.write.payable` + `gl.message.value` on `create_order` | `@gl.public.write` with non-zero value (current Studio raises `called non-payable method`) |
| Timestamp | `gl.message.datetime` → `datetime.fromisoformat` (helper `_current_unix_timestamp`) | `gl.block.timestamp` |
| TreeMap default | `map.get(key, default)` | — |

Header at time of writing (update if Studio ships a newer hash):

```python
# v0.2.16
# { "Depends": "py-genlayer:1jb45aa8ynh2a9c9xn3b7qqh8sm5q93hwfp7jqmwsfhh8jpz09h6" }
```

An older note that `.payable` “does not exist” is **wrong for the current Studio runner**. Functions that accept GEN must be `.payable`.

### Write methods

- `create_order(seller, goods_description, damaged_payout_to_seller, shipment_deadline, delivery_report_deadline) -> order_id` — attach GEN > 0; `0 < damaged_payout_to_seller < escrow`; buyer ≠ seller; report deadline > ship deadline
- `submit_shipment(order_id, origin_condition_urls, reference_urls)` — seller only, `AWAITING_SHIPMENT`, ≥1 origin + ≥2 independent references (locked)
- `claim_no_shipment_refund(order_id)` — buyer only, after ship deadline, if never shipped
- `claim_unreported_delivery(order_id)` — seller only, after report deadline, if still `SHIPPED`
- `report_delivery(order_id, delivery_evidence_urls)` — buyer only, `SHIPPED` / `DISPUTED` / `DELIVERY_REPORTED`, ≥1 delivery evidence (cannot change seller refs)
- `resolve_order(order_id)` — AI classification + settle
- `retry_resolution(order_id)` — buyer or seller, `PAYOUT_FAILED` only; does not re-run AI

### View methods

- `get_order` / `list_orders` / `get_order_count`
- `get_owner`

All money fields leave the contract as **decimal strings of wei**.

---

## Money handling itemize

Every money field is **wei / base units**, `bigint` on-chain and `BigInt` off-chain. No `float` / `parseFloat` / `Math.round` / `Math.floor` / `Math.ceil` near money variables.

| Field / path | WRITE | READ | Converter |
|---|---|---|---|
| `escrow_amount` | `bigint(gl.message.value)` in `create_order` | views return `str(int(escrow_amount))` | no % |
| `damaged_payout_to_seller` | create arg (`bigint` wei from `parseGenToWei`) | views return `str(int(...))` | must satisfy `0 < x < escrow` |
| UI % chips for damaged payout | `(escrowWei * BigInt(pct)) / 100n`, then `formatWeiToGen` into the input | display only | integer division; contract never sees a % |
| `DELIVERED_INTACT` seller payout | `emit_transfer(value=u256(escrow_amount))` | UI `formatWeiToGen(escrow)` | exact stored wei |
| `DAMAGED` seller payout | `emit_transfer(value=u256(damaged_payout_to_seller))` | UI `formatWeiToGen(damaged)` | lookup, never multiplied |
| `DAMAGED` buyer refund | `escrow_amount - damaged_payout_to_seller` then `emit_transfer` | UI `formatWeiToGen(escrow - damaged)` | `bigint` subtraction of two stored wei values |
| `NOT_DELIVERED` / expiry buyer refund | `emit_transfer(value=u256(escrow_amount))` | UI `formatWeiToGen(escrow)` | exact stored wei |
| `seller_paid` / `buyer_refunded` | set `True` only after that side's transfer succeeds | views return bool | retry skips a `True` flag |
| GEN input on UI | chips / `sanitizeGenInput` → `parseGenToWei` → `writeContract({ value })` + damaged arg | wei preview under fields | string-parse + `BigInt` |
| GEN display | — | `formatWeiToGen(...)` for escrow, damaged payout, and each side's result | `BigInt` divide `10^18n` |

`parseGenToWei` / `formatWeiToGen` live in [`frontend/src/money.js`](frontend/src/money.js). Float guard: [`scripts/check-no-float-money.js`](scripts/check-no-float-money.js) on `prebuild`.

---

## Frontend

- Preview mode if `VITE_CONTRACT_ADDRESS` is missing (banner, no white crash).
- Goods description is free text. Everything else is click / paste / type a number.
- Escrow GEN chips. Damaged-payout chips show a **computed GEN integer** for 50/70/80 (BigInt only).
- Shipment deadline dropdown: 7 / 14 / 30 days.
- Evidence URLs have a clipboard-paste button.
- **Request AI adjudication** loading state; verdict + reason + confidence + each side's GEN.
- `DISPUTED` → report delivery again. `PAYOUT_FAILED` → **Retry unpaid side only**, showing which flag is already paid.
- Sticky banner: *Free to use — you only pay GenLayer network gas when you sign a transaction. There is no other platform fee.*
- Wallet stays on **studionet**.

```bash
cd frontend
cp .env.example .env
npm install
npm run dev
```

---

## Tests

```bash
# contract (gltest fixtures: direct_vm / direct_deploy / direct_accounts)
gltest tests/test_cargo_verdict.py

# frontend money + list helpers + float guard
cd frontend
npm test
```

Covered: happy path `DELIVERED_INTACT`, happy path `DAMAGED` (both flags true), happy path `NOT_DELIVERED`, seller misses deadline → buyer refund, buyer never reports → seller timeout payout, report before ship blocked, low confidence → `DISPUTED` → re-report delivery only (seller refs locked), broken JSON, fetch fail → `DISPUTED` (not buyer refund), missing evidence/refs, invalid `damaged_payout_to_seller` / report deadline, buyer==seller, double-ship / double-resolve, **transfer fail paths → `PAYOUT_FAILED` → `retry_resolution` pays only the missing side**.

---

## Deploy on studionet

The operator deploys by hand in Studio Run & Debug. See [`scripts/deploy/studionet.md`](scripts/deploy/studionet.md). After `Result: SUCCESS`, set `VITE_CONTRACT_ADDRESS`, rebuild, then (handoff) push GitHub + Vercel.

Do not change the network to testnet or any other chain.

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

_Pending Vercel production URL after deploy verification._

## Deployed Contract

- **Network:** studionet (GenLayer Studio hosted)
- **Address:** `0x2D2A351b6F0b3bf4339d9b51D9f8750C41c1CEf4`
- **Explorer:** https://genlayer-explorer.vercel.app/address/0x2D2A351b6F0b3bf4339d9b51D9f8750C41c1CEf4

Until an address is set, the frontend runs in preview mode (banner, no white crash). Writes stay disabled.

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

1. **Create order** — buyer sets goods description, seller, `damaged_payout_to_seller`, shipment deadline, and locks `escrow_amount` GEN.
2. **Submit shipment** — seller attaches ≥1 origin-condition URL. Status → `SHIPPED`.
3. **Report delivery** — buyer attaches ≥1 delivery evidence URL and ≥2 independent reference URLs (carrier tracking, customs, …). Status → `DELIVERY_REPORTED`. Also allowed from `DISPUTED`.
4. **Resolve** — `resolve_order` runs `gl.vm.run_nondet`:
   - Leader fetches every URL with `gl.nondet.web.render`, prompts the model, parses `{verdict, confidence, reason}`.
   - Validator: absolute `verdict ==` and the same `confidence >= 60` branch.
5. `confidence < 60` (or unparseable JSON) → `DISPUTED`. Buyer may `report_delivery` again.
6. Valid verdict → `_execute_settlement`:
   - `DELIVERED_INTACT` → seller gets `escrow_amount`
   - `DAMAGED` → seller gets `damaged_payout_to_seller`, buyer gets the remainder
   - `NOT_DELIVERED` → buyer gets `escrow_amount`
7. Each side has its own flag (`seller_paid` / `buyer_refunded`). A transfer fail sets `PAYOUT_FAILED`. `retry_resolution` **only retries the unpaid side** and never pays a side that already succeeded.
8. If the seller never ships before `shipment_deadline`, buyer calls `claim_no_shipment_refund` (no AI). Failed expiry refunds also use `retry_resolution`.

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

- `create_order(seller, goods_description, damaged_payout_to_seller, shipment_deadline) -> order_id` — attach GEN > 0; `0 < damaged_payout_to_seller < escrow`; buyer ≠ seller
- `submit_shipment(order_id, origin_condition_urls)` — seller only, `AWAITING_SHIPMENT`, ≥1 http(s) URL
- `claim_no_shipment_refund(order_id)` — buyer only, after deadline, if never shipped
- `report_delivery(order_id, delivery_evidence_urls, reference_urls)` — buyer only, `SHIPPED` or `DISPUTED`, ≥1 evidence + ≥2 references
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

Covered: happy path `DELIVERED_INTACT`, happy path `DAMAGED` (both flags true), happy path `NOT_DELIVERED`, seller misses deadline → buyer refund, report before ship blocked, low confidence → `DISPUTED` → report again → resolve, broken JSON, missing web mocks, missing evidence/refs, invalid `damaged_payout_to_seller`, buyer==seller, double-ship / double-resolve, **transfer fail on DELIVERED_INTACT / DAMAGED seller-only / DAMAGED buyer-only / DAMAGED both / NOT_DELIVERED / expiry refund → `PAYOUT_FAILED` → `retry_resolution` pays only the missing side**.

---

## Deploy on studionet

The operator deploys by hand in Studio Run & Debug. See [`scripts/deploy/studionet.md`](scripts/deploy/studionet.md). After `Result: SUCCESS`, set `VITE_CONTRACT_ADDRESS`, rebuild, then (handoff) push GitHub + Vercel.

Do not change the network to testnet or any other chain.

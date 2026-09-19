# v0.2.16
# { "Depends": "py-genlayer:1jb45aa8ynh2a9c9xn3b7qqh8sm5q93hwfp7jqmwsfhh8jpz09h6" }
from genlayer import *
from dataclasses import dataclass
from datetime import datetime, timezone
import json

UserError = gl.vm.UserError

VALID_VERDICTS = ("DELIVERED_INTACT", "DAMAGED", "NOT_DELIVERED")
MIN_CONFIDENCE = 60
RENDER_CHAR_CAP = 2000
ZERO_ADDR = Address("0x0000000000000000000000000000000000000000")


def _addr_str(a) -> str:
    try:
        return a.as_hex.lower()
    except Exception:
        s = str(a).lower()
        if not s.startswith("0x") and len(s) == 40:
            return "0x" + s
        return s


def _to_address(val) -> Address:
    if isinstance(val, Address):
        return val
    if isinstance(val, bytes):
        return Address("0x" + val.hex())
    if isinstance(val, str):
        val_str = val.strip()
        if not val_str.startswith("0x"):
            val_str = "0x" + val_str
        return Address(val_str)
    if hasattr(val, "as_hex"):
        return val
    try:
        return Address(val)
    except Exception:
        return Address("0x" + bytes(val).hex())


def _same_addr(a, b) -> bool:
    return _addr_str(a) == _addr_str(b)


def _is_zero(a) -> bool:
    return _same_addr(a, ZERO_ADDR)


def _empty_urls():
    try:
        return DynArray[str]()
    except Exception:
        return []


def _urls_to_list(urls) -> list:
    out = []
    try:
        n = len(urls)
    except Exception:
        return out
    for i in range(n):
        out.append(str(urls[i]))
    return out


def _clean_http_urls(urls, kind: str, minimum: int) -> list:
    cleaned = []
    for u in urls:
        url = str(u).strip()
        if not url:
            continue
        if not (url.startswith("http://") or url.startswith("https://")):
            raise UserError("Invalid " + kind + " URL: must start with http:// or https://")
        cleaned.append(url)
    if len(cleaned) < minimum:
        raise UserError("At least " + str(minimum) + " " + kind + " URL(s) required")
    return cleaned


def _current_unix_timestamp() -> u256:
    """
    Verified GenVM timestamp API.
    gl.message.datetime is an ISO 8601 string. Parse with datetime.fromisoformat
    to Unix seconds. Do not use gl.block.timestamp.
    """
    raw = None
    try:
        raw = getattr(gl.message, "datetime", None)
    except Exception:
        raw = None
    if raw is None or str(raw).strip() == "":
        try:
            raw = gl.message_raw.get("datetime")
        except Exception:
            raw = None
    if raw is not None and str(raw).strip() != "":
        dt_str = str(raw).strip().replace("Z", "+00:00")
        try:
            dt = datetime.fromisoformat(dt_str)
            if dt.tzinfo is None:
                dt = dt.replace(tzinfo=timezone.utc)
            return u256(int(dt.timestamp()))
        except Exception as err:
            raise UserError("Invalid execution timestamp format from GenVM message: " + str(err))
    return u256(int(datetime.now(timezone.utc).timestamp()))


def _leader_payload(leader_res):
    if hasattr(leader_res, "value") and isinstance(leader_res.value, dict):
        return leader_res.value
    if hasattr(leader_res, "calldata") and isinstance(leader_res.calldata, dict):
        return leader_res.calldata
    if isinstance(leader_res, dict):
        return leader_res
    return None


def _extract_result(result) -> dict:
    payload = _leader_payload(result)
    if payload is None:
        raise UserError("Invalid nondet consensus result")
    return payload


def _parse_verdict(raw) -> dict:
    if isinstance(raw, dict):
        data = raw
    else:
        cleaned = str(raw).strip()
        if cleaned.startswith("```"):
            lines = cleaned.splitlines()
            if len(lines) >= 2 and lines[0].startswith("```"):
                lines = lines[1:]
            if len(lines) >= 1 and lines[-1].startswith("```"):
                lines = lines[:-1]
            cleaned = "\n".join(lines).strip()
        try:
            data = json.loads(cleaned)
        except Exception as e:
            return {
                "verdict": "",
                "confidence": 0,
                "reason": "Failed to parse LLM response. Error: " + str(e),
            }

    if not isinstance(data, dict):
        return {
            "verdict": "",
            "confidence": 0,
            "reason": "AI verdict response must be a JSON object",
        }

    verdict = str(data.get("verdict", "")).strip().upper().replace(" ", "_")
    if verdict not in VALID_VERDICTS:
        return {
            "verdict": "",
            "confidence": 0,
            "reason": "verdict must be DELIVERED_INTACT, DAMAGED, or NOT_DELIVERED — got: " + verdict,
        }

    try:
        conf = int(data.get("confidence", 0))
    except Exception:
        conf = 0
    if conf < 0 or conf > 100:
        conf = 0

    return {
        "verdict": verdict,
        "confidence": conf,
        "reason": str(data.get("reason", "")),
    }


def _bound_page_text(text) -> str:
    s = str(text or "")
    s = s.replace("<<<", "[").replace(">>>", "]").replace("```", "'''")
    if len(s) > RENDER_CHAR_CAP:
        s = s[:RENDER_CHAR_CAP]
    return s


def _fetch_url(url: str, kind: str) -> str:
    """Fetch is non-fatal: a missing page must not roll back the whole resolve tx."""
    body = ""
    try:
        res = gl.nondet.web.render(url, mode="text")
        raw = res.body if hasattr(res, "body") else res
        body = _bound_page_text(raw)
    except Exception as e:
        body = "FETCH_FAILED: " + str(e)
    if len(body.strip()) == 0:
        body = "FETCH_FAILED: empty page"
    return "[" + kind + " " + url + "]: " + body


def _pay(recipient, amount) -> None:
    if amount <= bigint(0):
        return
    gl.get_contract_at(_to_address(recipient)).emit_transfer(value=u256(amount))


@allow_storage
@dataclass
class Order:
    buyer: Address
    seller: Address
    goods_description: str
    escrow_amount: bigint
    damaged_payout_to_seller: bigint
    shipment_deadline: u256
    delivery_report_deadline: u256
    origin_condition_urls: DynArray[str]
    delivery_evidence_urls: DynArray[str]
    reference_urls: DynArray[str]
    status: str
    verdict: str
    verdict_reason: str
    confidence: u256
    seller_paid: bool
    buyer_refunded: bool


class Contract(gl.Contract):
    owner: Address
    order_counter: bigint
    orders: TreeMap[str, Order]

    def __init__(self):
        self.owner = _to_address(gl.message.sender_address)
        self.order_counter = bigint(0)

    @gl.public.write.payable
    def create_order(
        self,
        seller: Address,
        goods_description: str,
        damaged_payout_to_seller: bigint,
        shipment_deadline: u256,
        delivery_report_deadline: u256,
    ) -> str:
        escrow = bigint(gl.message.value)
        if escrow <= bigint(0):
            raise UserError("Must send GEN as escrow (amount must be > 0)")
        if not goods_description or len(goods_description.strip()) == 0:
            raise UserError("Goods description cannot be empty")

        buyer = _to_address(gl.message.sender_address)
        seller_addr = _to_address(seller)
        if _is_zero(seller_addr):
            raise UserError("Seller address cannot be zero")
        if _same_addr(buyer, seller_addr):
            raise UserError("Buyer and seller cannot be the same address")
        if damaged_payout_to_seller <= bigint(0) or damaged_payout_to_seller >= escrow:
            raise UserError("damaged_payout_to_seller must be > 0 and strictly less than escrow_amount")
        if u256(delivery_report_deadline) <= u256(shipment_deadline):
            raise UserError("delivery_report_deadline must be strictly after shipment_deadline")

        order_id = str(self.order_counter)
        self.order_counter = self.order_counter + bigint(1)

        self.orders[order_id] = Order(
            buyer=buyer,
            seller=seller_addr,
            goods_description=goods_description.strip(),
            escrow_amount=escrow,
            damaged_payout_to_seller=bigint(damaged_payout_to_seller),
            shipment_deadline=u256(shipment_deadline),
            delivery_report_deadline=u256(delivery_report_deadline),
            origin_condition_urls=_empty_urls(),
            delivery_evidence_urls=_empty_urls(),
            reference_urls=_empty_urls(),
            status="AWAITING_SHIPMENT",
            verdict="",
            verdict_reason="",
            confidence=u256(0),
            seller_paid=False,
            buyer_refunded=False,
        )
        return order_id

    @gl.public.write
    def submit_shipment(
        self,
        order_id: str,
        origin_condition_urls: DynArray[str],
        reference_urls: DynArray[str],
    ) -> None:
        """Seller pins origin photos AND neutral references. Buyer cannot change references later."""
        if order_id not in self.orders:
            raise UserError("Order does not exist")
        o = self.orders[order_id]
        if not _same_addr(gl.message.sender_address, o.seller):
            raise UserError("Only seller can submit shipment")
        if o.status != "AWAITING_SHIPMENT":
            raise UserError("Cannot submit shipment in status: " + o.status)

        o.origin_condition_urls = _clean_http_urls(origin_condition_urls, "origin condition", 1)
        o.reference_urls = _clean_http_urls(reference_urls, "independent reference", 2)
        o.status = "SHIPPED"
        self.orders[order_id] = o

    @gl.public.write
    def claim_no_shipment_refund(self, order_id: str) -> None:
        """Buyer takes back the full escrow if the seller never confirmed shipment before the deadline."""
        if order_id not in self.orders:
            raise UserError("Order does not exist")
        o = self.orders[order_id]
        if not _same_addr(gl.message.sender_address, o.buyer):
            raise UserError("Only buyer can claim this refund")
        if o.status != "AWAITING_SHIPMENT":
            raise UserError("Can only claim if seller never confirmed shipment")
        if _current_unix_timestamp() <= o.shipment_deadline:
            raise UserError("Shipment deadline has not passed yet")

        o.status = "EXPIRED_REFUNDED"
        self.orders[order_id] = o
        self._refund_buyer_full(order_id)

    @gl.public.write
    def claim_unreported_delivery(self, order_id: str) -> None:
        """Seller claims full escrow if buyer never reports delivery before the report deadline."""
        if order_id not in self.orders:
            raise UserError("Order does not exist")
        o = self.orders[order_id]
        if not _same_addr(gl.message.sender_address, o.seller):
            raise UserError("Only seller can claim unreported delivery")
        if o.status != "SHIPPED":
            raise UserError("Can only claim if buyer never reported delivery (status: " + o.status + ")")
        if _current_unix_timestamp() <= o.delivery_report_deadline:
            raise UserError("Delivery report deadline has not passed yet")

        o.verdict = ""
        o.confidence = u256(0)
        o.verdict_reason = "Buyer did not report delivery before delivery_report_deadline"
        o.status = "SELLER_TIMEOUT_PAID"
        self.orders[order_id] = o
        self._pay_seller_full(order_id)

    @gl.public.write
    def report_delivery(
        self,
        order_id: str,
        delivery_evidence_urls: DynArray[str],
    ) -> None:
        """Buyer may only attach delivery evidence. Seller-pinned references stay locked."""
        if order_id not in self.orders:
            raise UserError("Order does not exist")
        o = self.orders[order_id]
        if not _same_addr(gl.message.sender_address, o.buyer):
            raise UserError("Only buyer can report delivery")
        if o.status not in ["SHIPPED", "DISPUTED", "DELIVERY_REPORTED"]:
            raise UserError("Cannot report delivery in status: " + o.status)

        o.delivery_evidence_urls = _clean_http_urls(delivery_evidence_urls, "delivery evidence", 1)
        o.status = "DELIVERY_REPORTED"
        self.orders[order_id] = o

    @gl.public.write
    def resolve_order(self, order_id: str) -> None:
        if order_id not in self.orders:
            raise UserError("Order does not exist")
        o = self.orders[order_id]
        if o.status != "DELIVERY_REPORTED":
            raise UserError("Order not ready for resolution (status: " + o.status + ")")

        goods_desc = o.goods_description
        origin_urls_list = _urls_to_list(o.origin_condition_urls)
        delivery_urls_list = _urls_to_list(o.delivery_evidence_urls)
        reference_urls_list = _urls_to_list(o.reference_urls)

        def leader_fn() -> dict:
            origin_contents = []
            for url in origin_urls_list:
                origin_contents.append(_fetch_url(url, "origin"))

            delivery_contents = []
            for url in delivery_urls_list:
                delivery_contents.append(_fetch_url(url, "delivery evidence"))

            reference_contents = []
            for url in reference_urls_list:
                reference_contents.append(_fetch_url(url, "seller-pinned reference"))

            prompt = "You are a neutral B2B shipment dispute adjudicator.\n"
            prompt += "Goods description: \"" + goods_desc + "\"\n"
            prompt += "Condition at origin (seller-submitted): " + str(origin_contents) + "\n"
            prompt += "Independent references (SELLER-PINNED at shipment — primary source of truth; "
            prompt += "buyer cannot choose or replace these): " + str(reference_contents) + "\n"
            prompt += "Condition at delivery (buyer-submitted photos/notes — secondary only): " + str(delivery_contents) + "\n\n"
            prompt += "Decide strictly one of three outcomes:\n"
            prompt += "- \"DELIVERED_INTACT\": seller-pinned references confirm delivery and goods match origin condition.\n"
            prompt += "- \"DAMAGED\": seller-pinned references and/or delivery evidence show significant damage versus origin.\n"
            prompt += "- \"NOT_DELIVERED\": seller-pinned references clearly show the shipment was never delivered.\n\n"
            prompt += "CRITICAL neutral-evidence rules:\n"
            prompt += "1. Prioritize seller-pinned independent references over buyer delivery URLs.\n"
            prompt += "2. Buyer delivery URLs alone must NEVER decide NOT_DELIVERED or force a refund.\n"
            prompt += "3. If any seller-pinned reference is FETCH_FAILED, empty, a generic parking page "
            prompt += "(Example Domain), or does not describe this shipment, you MUST return "
            prompt += "confidence 0 with an empty verdict so the order stays disputed — do NOT invent "
            prompt += "NOT_DELIVERED from missing/irrelevant pages.\n"
            prompt += "4. NOT_DELIVERED requires affirmative non-delivery evidence in the seller-pinned references.\n\n"
            prompt += "Return ONLY raw JSON, no markdown:\n"
            prompt += "{\"verdict\": \"DELIVERED_INTACT\" | \"DAMAGED\" | \"NOT_DELIVERED\", \"confidence\": <0-100>, \"reason\": \"<short justification>\"}"

            raw = gl.nondet.exec_prompt(prompt, response_format="json")
            return _parse_verdict(raw)

        def validator_fn(leader_res) -> bool:
            if not isinstance(leader_res, gl.vm.Return):
                return False

            leader_payload = _leader_payload(leader_res)
            if not isinstance(leader_payload, dict):
                return False

            leader_verdict = str(leader_payload.get("verdict", "")).strip().upper().replace(" ", "_")
            if leader_verdict not in VALID_VERDICTS:
                return False

            try:
                leader_conf = int(leader_payload.get("confidence", -1))
                if not (0 <= leader_conf <= 100):
                    return False
            except Exception:
                return False

            try:
                my_res = leader_fn()
            except Exception:
                return False

            my_verdict = str(my_res.get("verdict", "")).strip().upper().replace(" ", "_")
            try:
                my_conf = int(my_res.get("confidence", -1))
                if not (0 <= my_conf <= 100):
                    return False
            except Exception:
                return False

            # Absolute equality on the 3 discrete verdicts — no % tolerance.
            # Confidence branch must also match (>=60 settle vs DISPUTED).
            if my_verdict != leader_verdict:
                return False
            return (my_conf >= MIN_CONFIDENCE) == (leader_conf >= MIN_CONFIDENCE)

        result = _parse_verdict(_extract_result(gl.vm.run_nondet(leader_fn, validator_fn)))

        o.verdict = result["verdict"]
        o.confidence = u256(int(result["confidence"]))
        o.verdict_reason = result["reason"]

        if int(result["confidence"]) < MIN_CONFIDENCE or result["verdict"] not in VALID_VERDICTS:
            o.status = "DISPUTED"
            self.orders[order_id] = o
            return

        # Persist verdict and leave DELIVERY_REPORTED before any transfer so a
        # reentrant resolve cannot re-run AI. _execute_settlement then locks
        # and pays using seller_paid / buyer_refunded independently.
        self.orders[order_id] = o
        self._execute_settlement(order_id)

    def _refund_buyer_full(self, order_id: str) -> None:
        o = self.orders[order_id]
        if o.buyer_refunded:
            o.status = "EXPIRED_REFUNDED"
            self.orders[order_id] = o
            return
        try:
            _pay(o.buyer, o.escrow_amount)
            o.buyer_refunded = True
            o.status = "EXPIRED_REFUNDED"
        except Exception as e:
            o.status = "PAYOUT_FAILED"
            extra = "No-shipment refund failed: " + str(e)
            if o.verdict_reason:
                o.verdict_reason = o.verdict_reason + " (" + extra + ")"
            else:
                o.verdict_reason = extra
        self.orders[order_id] = o

    def _pay_seller_full(self, order_id: str) -> None:
        o = self.orders[order_id]
        if o.seller_paid:
            o.status = "SELLER_TIMEOUT_PAID"
            self.orders[order_id] = o
            return
        try:
            _pay(o.seller, o.escrow_amount)
            o.seller_paid = True
            o.status = "SELLER_TIMEOUT_PAID"
        except Exception as e:
            o.status = "PAYOUT_FAILED"
            extra = "Seller timeout payout failed: " + str(e)
            if o.verdict_reason:
                o.verdict_reason = o.verdict_reason + " (" + extra + ")"
            else:
                o.verdict_reason = extra
        self.orders[order_id] = o

    def _execute_settlement(self, order_id: str) -> None:
        """Pay the stored discrete verdict. Retry only the unpaid side — never double-pay."""
        o = self.orders[order_id]
        # Leave DELIVERY_REPORTED immediately so a reentrant resolve_order cannot re-run AI.
        o.status = "PAYOUT_FAILED"
        self.orders[order_id] = o
        any_failure = False

        if o.verdict == "DELIVERED_INTACT":
            if not o.seller_paid:
                try:
                    _pay(o.seller, o.escrow_amount)
                    o.seller_paid = True
                    self.orders[order_id] = o
                except Exception as e:
                    any_failure = True
                    o.verdict_reason = o.verdict_reason + " (Seller payout failed: " + str(e) + ")"

        elif o.verdict == "DAMAGED":
            refund_to_buyer = o.escrow_amount - o.damaged_payout_to_seller
            if not o.seller_paid:
                try:
                    _pay(o.seller, o.damaged_payout_to_seller)
                    o.seller_paid = True
                    self.orders[order_id] = o
                except Exception as e:
                    any_failure = True
                    o.verdict_reason = o.verdict_reason + " (Seller partial payout failed: " + str(e) + ")"
            if not o.buyer_refunded:
                try:
                    _pay(o.buyer, refund_to_buyer)
                    o.buyer_refunded = True
                    self.orders[order_id] = o
                except Exception as e:
                    any_failure = True
                    o.verdict_reason = o.verdict_reason + " (Buyer refund failed: " + str(e) + ")"

        elif o.verdict == "NOT_DELIVERED":
            if not o.buyer_refunded:
                try:
                    _pay(o.buyer, o.escrow_amount)
                    o.buyer_refunded = True
                    self.orders[order_id] = o
                except Exception as e:
                    any_failure = True
                    o.verdict_reason = o.verdict_reason + " (Buyer full refund failed: " + str(e) + ")"

        else:
            raise UserError("Cannot settle an order without a discrete verdict")

        o.status = "PAYOUT_FAILED" if any_failure else "RESOLVED"
        self.orders[order_id] = o

    @gl.public.write
    def retry_resolution(self, order_id: str) -> None:
        """Retry only the unpaid transfer(s). Never re-runs AI. Never pays a side that already succeeded."""
        if order_id not in self.orders:
            raise UserError("Order does not exist")
        o = self.orders[order_id]
        sender = gl.message.sender_address
        if (not _same_addr(sender, o.buyer)) and (not _same_addr(sender, o.seller)):
            raise UserError("Only buyer or seller can retry")
        if o.status != "PAYOUT_FAILED":
            raise UserError("Can only retry PAYOUT_FAILED orders")

        if o.verdict in VALID_VERDICTS:
            self._execute_settlement(order_id)
            return
        if "Buyer did not report delivery" in str(o.verdict_reason):
            self._pay_seller_full(order_id)
            return
        self._refund_buyer_full(order_id)

    def _order_dict(self, order_id: str, o, full: bool) -> dict:
        row = {
            "order_id": order_id,
            "buyer": _addr_str(o.buyer),
            "seller": _addr_str(o.seller),
            "goods_description": o.goods_description,
            "escrow_amount": str(int(o.escrow_amount)),
            "damaged_payout_to_seller": str(int(o.damaged_payout_to_seller)),
            "shipment_deadline": str(int(o.shipment_deadline)),
            "delivery_report_deadline": str(int(o.delivery_report_deadline)),
            "status": o.status,
            "verdict": o.verdict,
            "verdict_reason": o.verdict_reason,
            "confidence": int(o.confidence),
            "seller_paid": bool(o.seller_paid),
            "buyer_refunded": bool(o.buyer_refunded),
        }
        if full:
            row["origin_condition_urls"] = _urls_to_list(o.origin_condition_urls)
            row["delivery_evidence_urls"] = _urls_to_list(o.delivery_evidence_urls)
            row["reference_urls"] = _urls_to_list(o.reference_urls)
        return row

    @gl.public.view
    def get_order(self, order_id: str) -> str:
        if order_id not in self.orders:
            raise UserError("Order does not exist")
        return json.dumps(self._order_dict(order_id, self.orders[order_id], True))

    @gl.public.view
    def list_orders(self) -> str:
        results = []
        n = int(self.order_counter)
        for i in range(n):
            oid = str(i)
            if oid in self.orders:
                results.append(self._order_dict(oid, self.orders[oid], False))
        return json.dumps(results)

    @gl.public.view
    def get_order_count(self) -> int:
        return int(self.order_counter)

    @gl.public.view
    def get_owner(self) -> str:
        return _addr_str(self.owner)

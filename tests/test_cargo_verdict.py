import json
import pytest

CONTRACT_PATH = "contracts/cargo_verdict.py"

ORIGIN = "https://example.com/origin-pack.jpg"
DELIVERY = "https://example.com/delivery-unbox.jpg"
REF1 = "https://tracking.carrier.example/shipment/ABC123"
REF2 = "https://customs.example.gov/lookup/ABC123"

ESCROW = 1000
DAMAGED_PAYOUT = 700
BUYER_REFUND_ON_DAMAGE = ESCROW - DAMAGED_PAYOUT  # 300 — integer only
FUTURE_DEADLINE = 2_000_000_000
REPORT_DEADLINE = FUTURE_DEADLINE + 86400
PAST_DEADLINE = 1


def _set_value(vm, amount):
    if hasattr(vm, "value"):
        try:
            vm.value = amount
        except Exception:
            pass
    if hasattr(vm, "_value"):
        vm._value = amount
    if hasattr(vm, "_refresh_gl_message"):
        vm._refresh_gl_message()


def _clear_value(vm):
    _set_value(vm, 0)


def _active_vm(direct_vm):
    try:
        from gltest.direct.loader import _get_active_vm
        return _get_active_vm() or direct_vm
    except Exception:
        return direct_vm


def sim_installMocks(vm, web=None, llm=None):
    """Install nondet mocks before every AI tx. Prefer sim_installMocks if present."""
    web = web or {}
    llm_payload = llm if isinstance(llm, str) or llm is None else json.dumps(llm)

    if hasattr(vm, "sim_installMocks"):
        vm.sim_installMocks({"web": web, "llm": llm_payload})
        return
    if hasattr(vm, "sim_install_mocks"):
        vm.sim_install_mocks({"web": web, "llm": llm_payload})
        return

    if hasattr(vm, "clear_mocks"):
        try:
            vm.clear_mocks()
        except Exception:
            pass
    for url, body in web.items():
        payload = body if isinstance(body, dict) else {"status": 200, "body": body}
        vm.mock_web(url, payload)
    if llm_payload is not None:
        vm.mock_llm(".*", llm_payload)


def _parse(raw):
    if isinstance(raw, str):
        return json.loads(raw or "{}")
    return raw or {}


def _parse_list(raw):
    if isinstance(raw, str):
        return json.loads(raw or "[]")
    return raw or []


def _order(contract, order_id):
    return _parse(contract.get_order(order_id))


def _addr(account):
    if hasattr(account, "address"):
        return account.address
    if hasattr(account, "as_hex"):
        return account.as_hex
    return account


def _create_order(
    contract,
    vm,
    buyer,
    seller,
    desc="Industrial sewing machines, 4 units, factory-new in crates",
    damaged=DAMAGED_PAYOUT,
    deadline=FUTURE_DEADLINE,
    report_deadline=REPORT_DEADLINE,
    escrow=ESCROW,
):
    vm.sender = buyer
    _set_value(vm, escrow)
    order_id = contract.create_order(_addr(seller), desc, damaged, deadline, report_deadline)
    _clear_value(vm)
    return order_id


def _ship(contract, vm, seller, order_id, urls=None, refs=None):
    vm.sender = seller
    contract.submit_shipment(order_id, urls or [ORIGIN], refs or [REF1, REF2])


def _report(contract, vm, buyer, order_id, evidence=None):
    vm.sender = buyer
    contract.report_delivery(order_id, evidence or [DELIVERY])


def _default_web():
    return {
        ORIGIN: "Packed intact: 4 new sewing machines, crates sealed, no dents",
        DELIVERY: "Arrived intact: 4 new sewing machines, crates sealed, no dents",
        REF1: "Carrier tracking: delivered, POD signed, no exception codes",
        REF2: "Customs release: cleared, quantity 4, no damage remarks",
    }


def _damaged_web():
    return {
        ORIGIN: "Packed intact: 4 new sewing machines, crates sealed",
        DELIVERY: "Arrived with two crushed crates and bent frames",
        REF1: "Carrier tracking: delivered with exception DAMAGE noted at destination",
        REF2: "Customs release: cleared, inspection photo shows crushed packaging",
    }


def _not_delivered_web():
    return {
        ORIGIN: "Packed intact at origin warehouse",
        DELIVERY: "Buyer: package never arrived",
        REF1: "Carrier tracking: still in transit, no delivery scan",
        REF2: "Customs: no import declaration found for this shipment",
    }


def _resolve(contract, vm, order_id, verdict, confidence=90, reason="Matches evidence", web=None):
    sim_installMocks(
        vm,
        web=web or _default_web(),
        llm={"verdict": verdict, "confidence": confidence, "reason": reason},
    )
    contract.resolve_order(order_id)


def _proxy_addr(proxy):
    for attr in ("address", "addr", "_address", "account"):
        if hasattr(proxy, attr):
            val = getattr(proxy, attr)
            if val is not None:
                try:
                    return str(val.as_hex if hasattr(val, "as_hex") else val).lower()
                except Exception:
                    return str(val).lower()
    return str(proxy).lower()


def _patch_clock(contract, monkeypatch, ts):
    def fake_now():
        return int(ts)

    import sys
    for _name, mod in list(sys.modules.items()):
        if mod is None:
            continue
        if callable(getattr(mod, "_current_unix_timestamp", None)) and hasattr(mod, "Order"):
            monkeypatch.setattr(mod, "_current_unix_timestamp", fake_now)
            return True

    inner = getattr(contract, "_contract", None) or getattr(contract, "__wrapped__", None)
    target = inner or contract
    meth = getattr(target, "claim_no_shipment_refund", None)
    func = getattr(meth, "__func__", meth) if meth is not None else None
    g = getattr(func, "__globals__", None) if func is not None else None
    if g is not None and "_current_unix_timestamp" in g:
        monkeypatch.setitem(g, "_current_unix_timestamp", fake_now)
        return True
    return False


def _loaded_contract_mod(contract=None):
    """Return the loaded cargo_verdict module after direct_deploy (exposes helpers)."""
    import sys
    for _name, mod in list(sys.modules.items()):
        if mod is None:
            continue
        if callable(getattr(mod, "_consensus_accepts", None)) and hasattr(mod, "Order"):
            return mod
    if contract is not None:
        inner = getattr(contract, "_contract", None) or getattr(contract, "__wrapped__", None)
        target = inner or contract
        meth = getattr(target, "resolve_order", None)
        func = getattr(meth, "__func__", meth) if meth is not None else None
        g = getattr(func, "__globals__", None) if func is not None else None
        if g is not None and callable(g.get("_consensus_accepts")):
            class _NS:
                pass
            ns = _NS()
            ns._consensus_accepts = g["_consensus_accepts"]
            ns._parse_verdict = g.get("_parse_verdict")
            return ns
    return None


def test_consensus_accepts_failed_reference_empty_verdict(direct_vm, direct_deploy, direct_accounts):
    """Empty verdict + conf 0 must be validator-valid (dispute), not rejected before DISPUTED."""
    contract = direct_deploy(CONTRACT_PATH)
    mod = _loaded_contract_mod(contract)
    assert mod is not None, "cargo_verdict helpers not loaded"
    accept = mod._consensus_accepts

    # Corrected failed-reference consensus path: both votes empty + conf 0.
    assert accept("", 0, "", 0) is True
    assert accept("", 0, "", 41) is True  # both still below settle threshold
    assert accept("", 0, "NOT_DELIVERED", 0) is False  # labels must match
    assert accept("", 80, "", 80) is False  # empty cannot settle
    assert accept("NOT_DELIVERED", 0, "NOT_DELIVERED", 0) is True  # low-conf matching settle labels → dispute
    assert accept("DELIVERED_INTACT", 95, "DELIVERED_INTACT", 90) is True
    assert accept("DELIVERED_INTACT", 95, "DAMAGED", 90) is False
    assert accept("DELIVERED_INTACT", 95, "DELIVERED_INTACT", 40) is False  # conf branch mismatch


def test_failed_reference_empty_verdict_consensus_reaches_disputed(direct_vm, direct_deploy, direct_accounts):
    """End-to-end: seller-pinned fetch failure → empty/conf0 consensus → DISPUTED, no refund."""
    buyer = direct_accounts[1]
    seller = direct_accounts[2]
    contract = direct_deploy(CONTRACT_PATH)
    vm = _active_vm(direct_vm)

    order_id = _create_order(contract, vm, buyer, seller)
    _ship(contract, vm, seller, order_id)
    _report(contract, vm, buyer, order_id)

    sim_installMocks(
        vm,
        web={},  # every seller-pinned URL renders as FETCH_FAILED
        llm={
            "verdict": "",
            "confidence": 0,
            "reason": "seller-pinned references were FETCH_FAILED or irrelevant parking pages",
        },
    )
    vm.sender = buyer
    contract.resolve_order(order_id)

    row = _order(contract, order_id)
    assert row["status"] == "DISPUTED"
    assert row["verdict"] == ""
    assert int(row["confidence"]) == 0
    assert row["buyer_refunded"] is False
    assert row["seller_paid"] is False
    # Buyer may re-report delivery evidence only; seller refs stay locked.
    clearer = "https://example.org/clearer-unbox.jpg"
    vm.sender = buyer
    contract.report_delivery(order_id, [clearer])
    assert _order(contract, order_id)["status"] == "DELIVERY_REPORTED"
    assert REF1 in _order(contract, order_id)["reference_urls"]
    assert REF2 in _order(contract, order_id)["reference_urls"]


def test_happy_path_delivered_intact(direct_vm, direct_deploy, direct_accounts):
    buyer = direct_accounts[1]
    seller = direct_accounts[2]
    contract = direct_deploy(CONTRACT_PATH)
    vm = _active_vm(direct_vm)

    order_id = _create_order(contract, vm, buyer, seller)
    assert order_id == "0"
    row = _order(contract, order_id)
    assert row["status"] == "AWAITING_SHIPMENT"
    assert row["escrow_amount"] == str(ESCROW)
    assert row["damaged_payout_to_seller"] == str(DAMAGED_PAYOUT)

    _ship(contract, vm, seller, order_id)
    assert _order(contract, order_id)["status"] == "SHIPPED"

    _report(contract, vm, buyer, order_id)
    assert _order(contract, order_id)["status"] == "DELIVERY_REPORTED"

    vm.sender = buyer
    _resolve(contract, vm, order_id, "DELIVERED_INTACT", 95, "Arrived matching origin condition")

    row = _order(contract, order_id)
    assert row["status"] == "RESOLVED"
    assert row["verdict"] == "DELIVERED_INTACT"
    assert row["seller_paid"] is True
    assert row["buyer_refunded"] is False
    assert row["confidence"] == 95


def test_happy_path_damaged_splits_fixed_amounts(direct_vm, direct_deploy, direct_accounts):
    buyer = direct_accounts[1]
    seller = direct_accounts[2]
    contract = direct_deploy(CONTRACT_PATH)
    vm = _active_vm(direct_vm)

    order_id = _create_order(contract, vm, buyer, seller)
    _ship(contract, vm, seller, order_id)
    _report(contract, vm, buyer, order_id)

    vm.sender = buyer
    _resolve(
        contract,
        vm,
        order_id,
        "DAMAGED",
        88,
        "Crushed crates vs intact origin",
        web=_damaged_web(),
    )

    row = _order(contract, order_id)
    assert row["status"] == "RESOLVED"
    assert row["verdict"] == "DAMAGED"
    assert row["seller_paid"] is True
    assert row["buyer_refunded"] is True
    assert int(row["damaged_payout_to_seller"]) == DAMAGED_PAYOUT
    assert int(row["escrow_amount"]) - int(row["damaged_payout_to_seller"]) == BUYER_REFUND_ON_DAMAGE


def test_happy_path_not_delivered(direct_vm, direct_deploy, direct_accounts):
    buyer = direct_accounts[1]
    seller = direct_accounts[2]
    contract = direct_deploy(CONTRACT_PATH)
    vm = _active_vm(direct_vm)

    order_id = _create_order(contract, vm, buyer, seller)
    _ship(contract, vm, seller, order_id)
    _report(contract, vm, buyer, order_id)

    vm.sender = buyer
    _resolve(
        contract,
        vm,
        order_id,
        "NOT_DELIVERED",
        91,
        "Tracking never shows delivery",
        web=_not_delivered_web(),
    )

    row = _order(contract, order_id)
    assert row["status"] == "RESOLVED"
    assert row["verdict"] == "NOT_DELIVERED"
    assert row["seller_paid"] is False
    assert row["buyer_refunded"] is True


def test_no_shipment_past_deadline_refunds_buyer(direct_vm, direct_deploy, direct_accounts, monkeypatch):
    buyer = direct_accounts[1]
    seller = direct_accounts[2]
    other = direct_accounts[3]
    contract = direct_deploy(CONTRACT_PATH)
    vm = _active_vm(direct_vm)

    order_id = _create_order(contract, vm, buyer, seller, deadline=FUTURE_DEADLINE)

    vm.sender = buyer
    with pytest.raises(Exception):
        contract.claim_no_shipment_refund(order_id)

    patched = _patch_clock(contract, monkeypatch, FUTURE_DEADLINE + 10)
    assert patched is True

    vm.sender = other
    with pytest.raises(Exception):
        contract.claim_no_shipment_refund(order_id)

    vm.sender = buyer
    contract.claim_no_shipment_refund(order_id)
    row = _order(contract, order_id)
    assert row["status"] == "EXPIRED_REFUNDED"
    assert row["buyer_refunded"] is True
    assert row["seller_paid"] is False


def test_report_delivery_before_ship_blocked(direct_vm, direct_deploy, direct_accounts):
    buyer = direct_accounts[1]
    seller = direct_accounts[2]
    contract = direct_deploy(CONTRACT_PATH)
    vm = _active_vm(direct_vm)

    order_id = _create_order(contract, vm, buyer, seller)
    vm.sender = buyer
    with pytest.raises(Exception):
        contract.report_delivery(order_id, [DELIVERY])
    assert _order(contract, order_id)["status"] == "AWAITING_SHIPMENT"


def test_low_confidence_disputed_then_report_again(direct_vm, direct_deploy, direct_accounts):
    buyer = direct_accounts[1]
    seller = direct_accounts[2]
    contract = direct_deploy(CONTRACT_PATH)
    vm = _active_vm(direct_vm)

    order_id = _create_order(contract, vm, buyer, seller)
    _ship(contract, vm, seller, order_id)
    _report(contract, vm, buyer, order_id)

    vm.sender = buyer
    _resolve(contract, vm, order_id, "DAMAGED", 41, "Photos are inconclusive")

    row = _order(contract, order_id)
    assert row["status"] == "DISPUTED"
    assert row["seller_paid"] is False
    assert row["buyer_refunded"] is False
    assert row["confidence"] == 41

    extra_ev = "https://example.com/clearer-unbox.jpg"
    vm.sender = buyer
    contract.report_delivery(order_id, [extra_ev])
    assert _order(contract, order_id)["status"] == "DELIVERY_REPORTED"
    # Buyer cannot replace seller-pinned references.
    assert REF1 in _order(contract, order_id)["reference_urls"]
    assert REF2 in _order(contract, order_id)["reference_urls"]

    sim_installMocks(
        vm,
        web={
            ORIGIN: "Packed intact: 4 new sewing machines, crates sealed",
            extra_ev: "Clear damage to two machines versus intact origin photos",
            REF1: "Carrier exception DAMAGE",
            REF2: "Independent surveyor confirms impact damage",
        },
        llm={"verdict": "DAMAGED", "confidence": 92, "reason": "Updated delivery evidence confirms damage"},
    )
    contract.resolve_order(order_id)

    row = _order(contract, order_id)
    assert row["status"] == "RESOLVED"
    assert row["verdict"] == "DAMAGED"
    assert row["seller_paid"] is True
    assert row["buyer_refunded"] is True


def test_rereport_replaces_delivery_only_keeps_seller_refs(direct_vm, direct_deploy, direct_accounts):
    buyer = direct_accounts[1]
    seller = direct_accounts[2]
    contract = direct_deploy(CONTRACT_PATH)
    vm = _active_vm(direct_vm)

    order_id = _create_order(contract, vm, buyer, seller)
    _ship(contract, vm, seller, order_id)
    _report(contract, vm, buyer, order_id)
    assert _order(contract, order_id)["status"] == "DELIVERY_REPORTED"

    new_ev = "https://example.org/unbox.jpg"
    vm.sender = buyer
    contract.report_delivery(order_id, [new_ev])
    row = _order(contract, order_id)
    assert row["status"] == "DELIVERY_REPORTED"
    assert new_ev in row["delivery_evidence_urls"]
    assert REF1 in row["reference_urls"]
    assert REF2 in row["reference_urls"]

    sim_installMocks(
        vm,
        web={
            ORIGIN: "Packed intact: 4 new sewing machines, crates sealed, no dents",
            new_ev: "Arrived intact: 4 new sewing machines, crates sealed, no dents",
            REF1: "Carrier tracking: delivered, POD signed, no exception codes",
            REF2: "Customs release: cleared, quantity 4, no damage remarks",
        },
        llm={"verdict": "DELIVERED_INTACT", "confidence": 90, "reason": "Seller refs confirm intact delivery"},
    )
    contract.resolve_order(order_id)
    row = _order(contract, order_id)
    assert row["status"] == "RESOLVED"
    assert row["verdict"] == "DELIVERED_INTACT"


def test_web_fail_and_invalid_json(direct_vm, direct_deploy, direct_accounts):
    buyer = direct_accounts[1]
    seller = direct_accounts[2]
    contract = direct_deploy(CONTRACT_PATH)
    vm = _active_vm(direct_vm)

    order_id = _create_order(contract, vm, buyer, seller)
    _ship(contract, vm, seller, order_id)
    _report(contract, vm, buyer, order_id)

    sim_installMocks(
        vm,
        web=_default_web(),
        llm="this is not json at all",
    )
    vm.sender = buyer
    contract.resolve_order(order_id)
    row = _order(contract, order_id)
    assert row["status"] == "DISPUTED"
    assert row["seller_paid"] is False
    assert row["confidence"] == 0

    order_id_2 = _create_order(contract, vm, buyer, seller)
    _ship(contract, vm, seller, order_id_2)
    _report(contract, vm, buyer, order_id_2)
    # Irrelevant / failed seller-pinned pages must become DISPUTED, not a buyer refund.
    sim_installMocks(
        vm,
        web={},
        llm={"verdict": "", "confidence": 0, "reason": "seller-pinned references were FETCH_FAILED"},
    )
    vm.sender = buyer
    contract.resolve_order(order_id_2)
    row2 = _order(contract, order_id_2)
    assert row2["status"] == "DISPUTED"
    assert row2["buyer_refunded"] is False
    assert row2["seller_paid"] is False


def test_missing_evidence_and_reference_urls(direct_vm, direct_deploy, direct_accounts):
    buyer = direct_accounts[1]
    seller = direct_accounts[2]
    contract = direct_deploy(CONTRACT_PATH)
    vm = _active_vm(direct_vm)

    order_id = _create_order(contract, vm, buyer, seller)
    vm.sender = seller
    with pytest.raises(Exception):
        contract.submit_shipment(order_id, [], [REF1, REF2])
    with pytest.raises(Exception):
        contract.submit_shipment(order_id, [ORIGIN], [REF1])
    with pytest.raises(Exception):
        contract.submit_shipment(order_id, ["ftp://not-http"], [REF1, REF2])
    _ship(contract, vm, seller, order_id)

    vm.sender = buyer
    with pytest.raises(Exception):
        contract.report_delivery(order_id, [])
    assert _order(contract, order_id)["status"] == "SHIPPED"
    assert REF1 in _order(contract, order_id)["reference_urls"]


def test_bad_damaged_payout_and_same_party_blocked(direct_vm, direct_deploy, direct_accounts):
    buyer = direct_accounts[1]
    seller = direct_accounts[2]
    contract = direct_deploy(CONTRACT_PATH)
    vm = _active_vm(direct_vm)

    vm.sender = buyer
    _set_value(vm, ESCROW)
    with pytest.raises(Exception):
        contract.create_order(_addr(buyer), "same party", DAMAGED_PAYOUT, FUTURE_DEADLINE, REPORT_DEADLINE)
    _clear_value(vm)

    vm.sender = buyer
    _set_value(vm, ESCROW)
    with pytest.raises(Exception):
        contract.create_order(_addr(seller), "zero damaged", 0, FUTURE_DEADLINE, REPORT_DEADLINE)
    _clear_value(vm)

    vm.sender = buyer
    _set_value(vm, ESCROW)
    with pytest.raises(Exception):
        contract.create_order(_addr(seller), "equal to escrow", ESCROW, FUTURE_DEADLINE, REPORT_DEADLINE)
    _clear_value(vm)

    vm.sender = buyer
    _set_value(vm, ESCROW)
    with pytest.raises(Exception):
        contract.create_order(_addr(seller), "greater than escrow", ESCROW + 1, FUTURE_DEADLINE, REPORT_DEADLINE)
    _clear_value(vm)

    vm.sender = buyer
    _set_value(vm, 0)
    with pytest.raises(Exception):
        contract.create_order(_addr(seller), "no escrow", DAMAGED_PAYOUT, FUTURE_DEADLINE, REPORT_DEADLINE)
    _clear_value(vm)

    vm.sender = buyer
    _set_value(vm, ESCROW)
    with pytest.raises(Exception):
        contract.create_order(_addr(seller), "   ", DAMAGED_PAYOUT, FUTURE_DEADLINE, REPORT_DEADLINE)
    _clear_value(vm)

    vm.sender = buyer
    _set_value(vm, ESCROW)
    with pytest.raises(Exception):
        contract.create_order(_addr(seller), "report deadline too early", DAMAGED_PAYOUT, FUTURE_DEADLINE, FUTURE_DEADLINE)
    _clear_value(vm)

    assert contract.get_order_count() == 0


def test_double_ship_double_resolve_blocked(direct_vm, direct_deploy, direct_accounts):
    buyer = direct_accounts[1]
    seller = direct_accounts[2]
    contract = direct_deploy(CONTRACT_PATH)
    vm = _active_vm(direct_vm)

    order_id = _create_order(contract, vm, buyer, seller)
    _ship(contract, vm, seller, order_id)
    vm.sender = seller
    with pytest.raises(Exception):
        contract.submit_shipment(order_id, [ORIGIN], [REF1, REF2])

    _report(contract, vm, buyer, order_id)
    vm.sender = buyer
    _resolve(contract, vm, order_id, "DELIVERED_INTACT", 90, "ok")
    assert _order(contract, order_id)["status"] == "RESOLVED"

    with pytest.raises(Exception):
        contract.resolve_order(order_id)
    with pytest.raises(Exception):
        contract.report_delivery(order_id, [DELIVERY])


def test_seller_timeout_when_buyer_never_reports(direct_vm, direct_deploy, direct_accounts, monkeypatch):
    buyer = direct_accounts[1]
    seller = direct_accounts[2]
    other = direct_accounts[3]
    contract = direct_deploy(CONTRACT_PATH)
    vm = _active_vm(direct_vm)

    order_id = _create_order(contract, vm, buyer, seller)
    _ship(contract, vm, seller, order_id)

    vm.sender = seller
    with pytest.raises(Exception):
        contract.claim_unreported_delivery(order_id)

    patched = _patch_clock(contract, monkeypatch, REPORT_DEADLINE + 10)
    assert patched is True

    vm.sender = buyer
    with pytest.raises(Exception):
        contract.claim_unreported_delivery(order_id)
    vm.sender = other
    with pytest.raises(Exception):
        contract.claim_unreported_delivery(order_id)

    vm.sender = seller
    contract.claim_unreported_delivery(order_id)
    row = _order(contract, order_id)
    assert row["status"] == "SELLER_TIMEOUT_PAID"
    assert row["seller_paid"] is True
    assert row["buyer_refunded"] is False
    assert "did not report delivery" in row["verdict_reason"].lower()


def test_seller_timeout_fail_then_retry(direct_vm, direct_deploy, direct_accounts, monkeypatch):
    buyer = direct_accounts[1]
    seller = direct_accounts[2]
    contract = direct_deploy(CONTRACT_PATH)
    vm = _active_vm(direct_vm)

    order_id = _create_order(contract, vm, buyer, seller)
    _ship(contract, vm, seller, order_id)
    assert _patch_clock(contract, monkeypatch, REPORT_DEADLINE + 5) is True

    payments = []
    _install_selective_fail(monkeypatch, lambda dest, amount, paid: True, payments)
    vm.sender = seller
    contract.claim_unreported_delivery(order_id)
    row = _order(contract, order_id)
    assert row["status"] == "PAYOUT_FAILED"
    assert row["seller_paid"] is False

    monkeypatch.undo()
    assert _patch_clock(contract, monkeypatch, REPORT_DEADLINE + 5) is True
    retry_payments = []
    _install_selective_fail(monkeypatch, lambda dest, amount, paid: False, retry_payments)
    vm.sender = seller
    contract.retry_resolution(order_id)
    row = _order(contract, order_id)
    assert row["status"] == "SELLER_TIMEOUT_PAID"
    assert row["seller_paid"] is True
    assert [p["amount"] for p in retry_payments] == [ESCROW]


def _install_selective_fail(monkeypatch, fail_when, payments):
    import gltest.direct.loader

    original_emit = gltest.direct.loader._EOAProxy.emit_transfer

    def wrapped(self, value=None, **kwargs):
        dest = _proxy_addr(self)
        amount = int(value or 0)
        if fail_when(dest, amount, payments):
            raise Exception("Simulated native transfer execution failure")
        payments.append({"to": dest, "amount": amount})
        return original_emit(self, value, **kwargs)

    monkeypatch.setattr(gltest.direct.loader._EOAProxy, "emit_transfer", wrapped)
    return original_emit


def test_transfer_fail_delivered_intact_then_retry(direct_vm, direct_deploy, direct_accounts, monkeypatch):
    buyer = direct_accounts[1]
    seller = direct_accounts[2]
    contract = direct_deploy(CONTRACT_PATH)
    vm = _active_vm(direct_vm)

    order_id = _create_order(contract, vm, buyer, seller)
    _ship(contract, vm, seller, order_id)
    _report(contract, vm, buyer, order_id)

    payments = []
    _install_selective_fail(monkeypatch, lambda dest, amount, paid: True, payments)

    vm.sender = buyer
    _resolve(contract, vm, order_id, "DELIVERED_INTACT", 97, "Intact")

    row = _order(contract, order_id)
    assert row["status"] == "PAYOUT_FAILED"
    assert row["seller_paid"] is False
    assert row["buyer_refunded"] is False
    assert "Seller payout failed" in row["verdict_reason"]
    assert payments == []

    monkeypatch.undo()
    payments.clear()
    _install_selective_fail(monkeypatch, lambda dest, amount, paid: False, payments)
    vm.sender = seller
    contract.retry_resolution(order_id)

    row = _order(contract, order_id)
    assert row["status"] == "RESOLVED"
    assert row["seller_paid"] is True
    assert row["buyer_refunded"] is False
    assert [p["amount"] for p in payments] == [ESCROW]


def test_damaged_fail_seller_only_then_retry_no_double_pay(direct_vm, direct_deploy, direct_accounts, monkeypatch):
    buyer = direct_accounts[1]
    seller = direct_accounts[2]
    contract = direct_deploy(CONTRACT_PATH)
    vm = _active_vm(direct_vm)

    order_id = _create_order(contract, vm, buyer, seller)
    _ship(contract, vm, seller, order_id)
    _report(contract, vm, buyer, order_id)

    payments = []
    attempts = {"n": 0}

    def fail_first_transfer(_dest, _amount, paid):
        # DAMAGED pays seller first, then buyer. Fail only the first hop.
        attempts["n"] += 1
        return attempts["n"] == 1

    _install_selective_fail(monkeypatch, fail_first_transfer, payments)

    vm.sender = buyer
    _resolve(contract, vm, order_id, "DAMAGED", 93, "Damaged crates", web=_damaged_web())

    row = _order(contract, order_id)
    assert row["status"] == "PAYOUT_FAILED"
    assert row["seller_paid"] is False
    assert row["buyer_refunded"] is True
    assert "Seller partial payout failed" in row["verdict_reason"]
    assert [p["amount"] for p in payments] == [BUYER_REFUND_ON_DAMAGE]

    monkeypatch.undo()
    retry_payments = []
    _install_selective_fail(monkeypatch, lambda dest, amount, paid: False, retry_payments)
    vm.sender = buyer
    contract.retry_resolution(order_id)

    row = _order(contract, order_id)
    assert row["status"] == "RESOLVED"
    assert row["seller_paid"] is True
    assert row["buyer_refunded"] is True
    # Retry must pay ONLY the missing seller side — buyer already received 300.
    assert [p["amount"] for p in retry_payments] == [DAMAGED_PAYOUT]


def test_damaged_fail_buyer_only_then_retry_no_double_pay(direct_vm, direct_deploy, direct_accounts, monkeypatch):
    buyer = direct_accounts[1]
    seller = direct_accounts[2]
    contract = direct_deploy(CONTRACT_PATH)
    vm = _active_vm(direct_vm)

    order_id = _create_order(contract, vm, buyer, seller)
    _ship(contract, vm, seller, order_id)
    _report(contract, vm, buyer, order_id)

    payments = []

    def fail_second_transfer(_dest, _amount, paid):
        # First hop (seller) succeeds and is recorded; fail only the buyer refund.
        return len(paid) == 1

    _install_selective_fail(monkeypatch, fail_second_transfer, payments)

    vm.sender = buyer
    _resolve(contract, vm, order_id, "DAMAGED", 90, "Damaged", web=_damaged_web())

    row = _order(contract, order_id)
    assert row["status"] == "PAYOUT_FAILED"
    assert row["seller_paid"] is True
    assert row["buyer_refunded"] is False
    assert "Buyer refund failed" in row["verdict_reason"]
    assert [p["amount"] for p in payments] == [DAMAGED_PAYOUT]

    monkeypatch.undo()
    retry_payments = []
    _install_selective_fail(monkeypatch, lambda dest, amount, paid: False, retry_payments)
    vm.sender = seller
    contract.retry_resolution(order_id)

    row = _order(contract, order_id)
    assert row["status"] == "RESOLVED"
    assert row["seller_paid"] is True
    assert row["buyer_refunded"] is True
    assert [p["amount"] for p in retry_payments] == [BUYER_REFUND_ON_DAMAGE]


def test_damaged_fail_both_then_retry_pays_each_once(direct_vm, direct_deploy, direct_accounts, monkeypatch):
    buyer = direct_accounts[1]
    seller = direct_accounts[2]
    contract = direct_deploy(CONTRACT_PATH)
    vm = _active_vm(direct_vm)

    order_id = _create_order(contract, vm, buyer, seller)
    _ship(contract, vm, seller, order_id)
    _report(contract, vm, buyer, order_id)

    payments = []
    _install_selective_fail(monkeypatch, lambda dest, amount, paid: True, payments)

    vm.sender = buyer
    _resolve(contract, vm, order_id, "DAMAGED", 90, "Damaged", web=_damaged_web())

    row = _order(contract, order_id)
    assert row["status"] == "PAYOUT_FAILED"
    assert row["seller_paid"] is False
    assert row["buyer_refunded"] is False
    assert payments == []

    monkeypatch.undo()
    retry_payments = []
    _install_selective_fail(monkeypatch, lambda dest, amount, paid: False, retry_payments)
    vm.sender = buyer
    contract.retry_resolution(order_id)

    row = _order(contract, order_id)
    assert row["status"] == "RESOLVED"
    assert row["seller_paid"] is True
    assert row["buyer_refunded"] is True
    assert sorted(p["amount"] for p in retry_payments) == sorted([DAMAGED_PAYOUT, BUYER_REFUND_ON_DAMAGE])


def test_not_delivered_fail_then_retry(direct_vm, direct_deploy, direct_accounts, monkeypatch):
    buyer = direct_accounts[1]
    seller = direct_accounts[2]
    contract = direct_deploy(CONTRACT_PATH)
    vm = _active_vm(direct_vm)

    order_id = _create_order(contract, vm, buyer, seller)
    _ship(contract, vm, seller, order_id)
    _report(contract, vm, buyer, order_id)

    payments = []
    _install_selective_fail(monkeypatch, lambda dest, amount, paid: True, payments)

    vm.sender = buyer
    _resolve(contract, vm, order_id, "NOT_DELIVERED", 90, "Never arrived", web=_not_delivered_web())

    row = _order(contract, order_id)
    assert row["status"] == "PAYOUT_FAILED"
    assert row["buyer_refunded"] is False
    assert row["seller_paid"] is False
    assert "Buyer full refund failed" in row["verdict_reason"]

    monkeypatch.undo()
    retry_payments = []
    _install_selective_fail(monkeypatch, lambda dest, amount, paid: False, retry_payments)
    vm.sender = buyer
    contract.retry_resolution(order_id)

    row = _order(contract, order_id)
    assert row["status"] == "RESOLVED"
    assert row["buyer_refunded"] is True
    assert row["seller_paid"] is False
    assert [p["amount"] for p in retry_payments] == [ESCROW]


def test_no_shipment_refund_fail_then_retry(direct_vm, direct_deploy, direct_accounts, monkeypatch):
    buyer = direct_accounts[1]
    seller = direct_accounts[2]
    contract = direct_deploy(CONTRACT_PATH)
    vm = _active_vm(direct_vm)

    order_id = _create_order(contract, vm, buyer, seller)
    assert _patch_clock(contract, monkeypatch, FUTURE_DEADLINE + 5) is True

    payments = []
    _install_selective_fail(monkeypatch, lambda dest, amount, paid: True, payments)
    vm.sender = buyer
    contract.claim_no_shipment_refund(order_id)
    row = _order(contract, order_id)
    assert row["status"] == "PAYOUT_FAILED"
    assert row["buyer_refunded"] is False

    monkeypatch.undo()
    assert _patch_clock(contract, monkeypatch, FUTURE_DEADLINE + 5) is True
    retry_payments = []
    _install_selective_fail(monkeypatch, lambda dest, amount, paid: False, retry_payments)
    vm.sender = buyer
    contract.retry_resolution(order_id)
    row = _order(contract, order_id)
    assert row["status"] == "EXPIRED_REFUNDED"
    assert row["buyer_refunded"] is True
    assert [p["amount"] for p in retry_payments] == [ESCROW]


def test_retry_blocked_when_not_failed(direct_vm, direct_deploy, direct_accounts):
    buyer = direct_accounts[1]
    seller = direct_accounts[2]
    other = direct_accounts[3]
    contract = direct_deploy(CONTRACT_PATH)
    vm = _active_vm(direct_vm)

    order_id = _create_order(contract, vm, buyer, seller)
    vm.sender = buyer
    with pytest.raises(Exception):
        contract.retry_resolution(order_id)

    _ship(contract, vm, seller, order_id)
    _report(contract, vm, buyer, order_id)
    vm.sender = buyer
    _resolve(contract, vm, order_id, "DELIVERED_INTACT", 90, "ok")
    vm.sender = other
    with pytest.raises(Exception):
        contract.retry_resolution(order_id)


def test_list_and_counts(direct_vm, direct_deploy, direct_accounts):
    buyer = direct_accounts[1]
    seller = direct_accounts[2]
    contract = direct_deploy(CONTRACT_PATH)
    vm = _active_vm(direct_vm)

    a = _create_order(contract, vm, buyer, seller, desc="Crates of coffee")
    b = _create_order(contract, vm, buyer, seller, desc="Steel coils")
    assert contract.get_order_count() == 2
    rows = _parse_list(contract.list_orders())
    assert len(rows) == 2
    assert rows[0]["order_id"] == a
    assert rows[1]["order_id"] == b
    assert rows[0]["escrow_amount"] == str(ESCROW)

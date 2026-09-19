import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Wallet,
  PlusCircle,
  List,
  RefreshCw,
  ClipboardPaste,
  Scale,
  RotateCcw,
  Plus,
  Trash2,
  Package,
  Ship,
  Copy,
  Clock,
} from 'lucide-react';
import {
  CONTRACT_ADDRESS,
  hasContractAddress,
  getWriteClient,
  getListClient,
  loadOrders,
  readView,
  waitForTx,
  ensureStudioNetwork,
  formatWalletError,
  parseGenToWei,
  formatWeiToGen,
  sanitizeGenInput,
  txExplorerUrl,
  receiptLooksFailed,
} from './genlayerClient.js';
import {
  extractCreatedId,
  pollUntilListed,
  pollUntilOrderLeavesStatus,
  sameAddress,
  resolveReadAccount,
  deadlineUnixFromDays,
  formatDeadline,
  FLOW_STEPS,
  flowCurrentStep,
  nextActionHint,
} from './orderPoll.js';
import {
  percentOfWei,
  damagedPayoutValid,
  settlementPreview,
  payoutSideLabel,
  weiFromOrderField,
} from './money.js';
import {
  ESCROW_PRESETS,
  DAMAGED_PCT_PRESETS,
  DEADLINE_PRESETS,
  EXAMPLE_ORIGIN_URL,
  EXAMPLE_DELIVERY_URL,
  EXAMPLE_REFERENCE_URLS,
  GOODS_HINT,
  SAMPLE_ORDER,
} from './data/presets.js';

const shortAddr = (a) => {
  if (!a) return '—';
  const s = String(a);
  if (s.length < 12) return s;
  return `${s.slice(0, 6)}...${s.slice(-4)}`;
};

const pasteClipboard = async () => {
  const text = await navigator.clipboard.readText();
  return (text || '').trim();
};

const verdictClass = (verdict) => {
  const v = String(verdict || '').toUpperCase();
  if (v === 'DELIVERED_INTACT') return 'verdict-intact';
  if (v === 'DAMAGED') return 'verdict-damaged';
  if (v === 'NOT_DELIVERED') return 'verdict-missing';
  return '';
};

const statusClass = (status) => `badge badge-${String(status || '').toLowerCase()}`;

const FlowStrip = ({ status }) => {
  const current = flowCurrentStep(status);
  const indexOf = { create: 0, ship: 1, report: 2, ai: 3, done: 4 };
  const currentIdx = indexOf[current] ?? 0;
  return (
    <ol className="flow-strip">
      {FLOW_STEPS.map((step, i) => {
        const done = currentIdx > i;
        const isCurrent = currentIdx === i || (current === 'done' && step.id === 'ai');
        return (
          <li
            key={step.id}
            className={`flow-step${isCurrent ? ' current' : ''}${done ? ' done' : ''}`}
          >
            {step.label}
          </li>
        );
      })}
    </ol>
  );
};

const formatUrlList = (arr) => {
  if (!Array.isArray(arr) || arr.length === 0) return '';
  return arr.map((u) => String(u)).filter(Boolean).join(' · ');
};

const UrlEditor = ({ label, values, setValues, min, placeholder, example }) => (
  <div className="field">
    <label className="label">{label} (min {min})</label>
    {values.map((u, i) => (
      <div className="url-row" key={`${label}-${i}`}>
        <input
          className="input mono"
          placeholder={placeholder}
          value={u}
          onChange={(e) => {
            const next = [...values];
            next[i] = e.target.value;
            setValues(next);
          }}
        />
        <button
          type="button"
          className="btn-ghost"
          onClick={async () => {
            const text = await pasteClipboard();
            const next = [...values];
            next[i] = text;
            setValues(next);
          }}
          title="Paste from clipboard"
        >
          <ClipboardPaste size={16} />
        </button>
        {values.length > min && (
          <button
            type="button"
            className="btn-ghost"
            onClick={() => setValues(values.filter((_, idx) => idx !== i))}
          >
            <Trash2 size={16} />
          </button>
        )}
      </div>
    ))}
    <div className="chips">
      <button type="button" className="chip" onClick={() => setValues([...values, ''])}>
        <Plus size={14} /> Add URL
      </button>
      {example && (
        <button
          type="button"
          className="chip"
          onClick={() => {
            if (Array.isArray(example)) {
              setValues(example.map((u) => String(u)));
              return;
            }
            const next = [...values];
            next[0] = example;
            setValues(next);
          }}
        >
          Example
        </button>
      )}
    </div>
  </div>
);

export default function App() {
  const [account, setAccount] = useState(null);
  const [tab, setTab] = useState('create');
  const [orders, setOrders] = useState([]);
  const [details, setDetails] = useState({});
  const [loading, setLoading] = useState(false);
  const [resolvingId, setResolvingId] = useState(null);
  const [txHash, setTxHash] = useState(null);
  const [errorMessage, setErrorMessage] = useState(null);
  const [copied, setCopied] = useState(null);

  const [goods, setGoods] = useState('');
  const [sellerAddr, setSellerAddr] = useState('');
  const [escrowStr, setEscrowStr] = useState('1');
  const [damagedStr, setDamagedStr] = useState('');
  const [deadlineDays, setDeadlineDays] = useState(14);
  const [reportDays, setReportDays] = useState(21);

  const [originUrls, setOriginUrls] = useState(['']);
  const [deliveryUrls, setDeliveryUrls] = useState(['']);
  const [refUrls, setRefUrls] = useState(['', '']);
  const [activeOrderId, setActiveOrderId] = useState(null);
  const [filter, setFilter] = useState('all');

  const escrowWei = parseGenToWei(escrowStr);
  const damagedWei = parseGenToWei(damagedStr);
  const damagedOk = damagedPayoutValid(escrowWei, damagedWei);

  const damagedHints = useMemo(
    () => DAMAGED_PCT_PRESETS.map((pct) => ({
      pct,
      wei: percentOfWei(escrowWei, pct),
    })),
    [escrowWei]
  );

  const requireReady = () => {
    if (!hasContractAddress) {
      throw new Error('No contract address is configured. Deploy on GenLayer Studio, then set VITE_CONTRACT_ADDRESS.');
    }
    if (!account) {
      throw new Error('Connect a wallet first.');
    }
  };

  const connectWallet = async () => {
    try {
      if (!window.ethereum) {
        setErrorMessage('MetaMask is required to use CargoVerdict.');
        return;
      }
      setErrorMessage(null);
      const accounts = await window.ethereum.request({ method: 'eth_requestAccounts' });
      const addr = accounts[0];
      try {
        await ensureStudioNetwork();
      } catch (err) {
        console.warn('studionet switch note:', err);
      }
      setAccount(addr);
    } catch (err) {
      setErrorMessage(formatWalletError(err, 'Wallet connection failed'));
    }
  };

  useEffect(() => {
    if (typeof window === 'undefined' || !window.ethereum?.on) return undefined;
    const onAccounts = (accs) => {
      const next = Array.isArray(accs) && accs[0] ? accs[0] : null;
      setAccount(next);
    };
    window.ethereum.on('accountsChanged', onAccounts);
    return () => {
      if (window.ethereum.removeListener) {
        window.ethereum.removeListener('accountsChanged', onAccounts);
      }
    };
  }, []);

  const fetchOrders = useCallback(async ({ silent = false } = {}) => {
    if (!hasContractAddress) {
      setOrders([]);
      return { rows: [], count: 0 };
    }
    try {
      if (!silent) setLoading(true);
      const client = getListClient(account);
      if (!client) return { rows: [], count: 0 };
      const loaded = await loadOrders(client, account);
      setOrders(loaded.rows);
      if (!silent && !loaded.rows.length && loaded.listError) {
        setErrorMessage(loaded.listError.message || 'Could not load orders');
      }
      return loaded;
    } catch (err) {
      console.warn('list_orders failed:', err);
      if (!silent) setErrorMessage(err?.message || 'Could not load orders');
      return { rows: [], count: 0 };
    } finally {
      if (!silent) setLoading(false);
    }
  }, [account]);

  const fetchDetail = async (orderId) => {
    if (!hasContractAddress || orderId == null || String(orderId).startsWith('0x')) return null;
    try {
      const client = getListClient(account);
      const row = await readView(client, 'get_order', [String(orderId)], account);
      if (row && typeof row === 'object') {
        setDetails((prev) => ({ ...prev, [String(orderId)]: row }));
        return row;
      }
      return null;
    } catch (err) {
      console.warn('get_order failed:', err);
      return null;
    }
  };

  useEffect(() => {
    fetchOrders();
    if (!hasContractAddress) return undefined;
    const timer = setInterval(() => {
      fetchOrders({ silent: true });
    }, 15000);
    return () => clearInterval(timer);
  }, [fetchOrders]);

  const runWrite = async (fnName, args, value, { resolving } = {}) => {
    requireReady();
    setErrorMessage(null);
    setTxHash(null);
    if (resolving) setResolvingId(resolving);
    setLoading(true);
    const isAi = fnName === 'resolve_order';
    try {
      await ensureStudioNetwork();
      const client = getWriteClient(account);
      const sender = resolveReadAccount(account);
      const hash = await client.writeContract({
        address: CONTRACT_ADDRESS,
        functionName: fnName,
        args,
        account: sender,
        value: value === undefined ? 0n : value,
      });
      setTxHash(hash);
      const receipt = await waitForTx(client, hash, isAi
        ? { retries: 90, interval: 5000 }
        : { retries: 40, interval: 2000 });

      if (isAi) {
        const fromStatus = 'DELIVERY_REPORTED';
        const settled = await pollUntilOrderLeavesStatus({
          fromStatus,
          attempts: 36,
          intervalMs: 5000,
          loadOrder: async () => {
            await fetchOrders({ silent: true });
            return fetchDetail(String(args[0]));
          },
        });
        const status = String(settled?.status || '');
        if (status && status !== fromStatus) {
          return hash;
        }
        const explorer = txExplorerUrl(hash);
        const stuck =
          `No verdict yet (order still ${fromStatus || 'DELIVERY_REPORTED'}). ` +
          `Click Refresh in a few minutes. Do not use Wikipedia or fake *.example hosts — GenVM has to fetch every URL. ` +
          `Create a new order and click Example on each URL field (example.com, example.org, example.net, rfc-editor). ` +
          `Explorer: ${explorer}`;
        if (receiptLooksFailed(receipt)) {
          throw new Error(
            `GenVM rolled this adjudication back. ${stuck}`
          );
        }
        setErrorMessage(stuck);
        return hash;
      }

      const previousCount = orders.length;
      const listed = await pollUntilListed({
        previousCount,
        attempts: 6,
        intervalMs: 3000,
        load: async () => fetchOrders({ silent: true }),
      });
      setOrders(listed.rows || []);
      const createdId =
        fnName === 'create_order'
          ? extractCreatedId(hash) || (listed.count > 0 ? String(listed.count - 1) : null)
          : args && args[0] && !String(args[0]).startsWith('0x')
            ? String(args[0])
            : null;
      if (createdId) {
        setActiveOrderId(createdId);
        await fetchDetail(createdId);
      }
      return hash;
    } catch (err) {
      setErrorMessage(formatWalletError(err, `${fnName} failed`));
      throw err;
    } finally {
      setLoading(false);
      setResolvingId(null);
    }
  };

  const handleCreate = async (e) => {
    e.preventDefault();
    try {
      if (!goods.trim()) throw new Error('Goods description cannot be empty.');
      if (!/^0x[0-9a-fA-F]{40}$/.test(sellerAddr.trim())) {
        throw new Error('Seller must be a 0x address.');
      }
      if (escrowWei <= 0n) throw new Error('Escrow must be greater than 0 GEN.');
      if (!damagedOk) throw new Error('Damaged payout must be greater than 0 and strictly less than escrow.');
      if (reportDays <= deadlineDays) {
        throw new Error('Buyer report deadline must be after the seller ship deadline.');
      }
      const deadline = deadlineUnixFromDays(deadlineDays);
      const reportDeadline = deadlineUnixFromDays(reportDays);
      await runWrite(
        'create_order',
        [sellerAddr.trim(), goods.trim(), damagedWei, deadline, reportDeadline],
        escrowWei
      );
      setTab('orders');
      setFilter('all');
    } catch (err) {
      setErrorMessage(formatWalletError(err, 'Create order failed'));
    }
  };

  const cleanUrls = (arr) => arr.map((u) => u.trim()).filter(Boolean);

  const handleShip = async (orderId) => {
    try {
      const urls = cleanUrls(originUrls);
      const refs = cleanUrls(refUrls);
      if (urls.length < 1) throw new Error('Paste at least 1 origin-condition URL.');
      if (refs.length < 2) throw new Error('Paste at least 2 independent reference URLs (locked after ship).');
      await runWrite('submit_shipment', [orderId, urls, refs]);
    } catch (err) {
      setErrorMessage(formatWalletError(err, 'Submit shipment failed'));
    }
  };

  const handleReport = async (orderId) => {
    try {
      const evidence = cleanUrls(deliveryUrls);
      if (evidence.length < 1) throw new Error('Paste at least 1 delivery evidence URL.');
      await runWrite('report_delivery', [orderId, evidence]);
    } catch (err) {
      setErrorMessage(formatWalletError(err, 'Report delivery failed'));
    }
  };

  const handleResolve = async (orderId) => {
    try {
      await runWrite('resolve_order', [orderId], undefined, { resolving: orderId });
      setActiveOrderId(orderId);
      await fetchDetail(orderId);
    } catch (err) {
      setErrorMessage(formatWalletError(err, 'AI adjudication failed'));
    }
  };

  const handleRetry = async (orderId) => {
    try {
      await runWrite('retry_resolution', [orderId]);
    } catch (err) {
      setErrorMessage(formatWalletError(err, 'Retry failed'));
    }
  };

  const handleExpiryRefund = async (orderId) => {
    try {
      await runWrite('claim_no_shipment_refund', [orderId]);
    } catch (err) {
      setErrorMessage(formatWalletError(err, 'Expiry refund failed'));
    }
  };

  const handleSellerTimeout = async (orderId) => {
    try {
      await runWrite('claim_unreported_delivery', [orderId]);
    } catch (err) {
      setErrorMessage(formatWalletError(err, 'Seller timeout claim failed'));
    }
  };

  const copyText = async (label, text) => {
    await navigator.clipboard.writeText(text);
    setCopied(label);
    setTimeout(() => setCopied(null), 1500);
  };

  const visibleOrders = orders.filter((o) => {
    if (filter === 'buyer') return sameAddress(o.buyer, account);
    if (filter === 'seller') return sameAddress(o.seller, account);
    return true;
  });

  const merged = (o) => details[o.order_id] ? { ...o, ...details[o.order_id] } : o;

  return (
    <div className="app">
      <div className="free-banner">
        Free to use — you only pay GenLayer network gas when you sign a transaction. There is no other platform fee.
      </div>

      {!hasContractAddress && (
        <div className="missing-banner">
          Contract address is not set yet. The app runs in preview mode: connect a wallet and browse the UI, but writes stay disabled until you deploy on GenLayer Studio and set <code>VITE_CONTRACT_ADDRESS</code>.
        </div>
      )}

      <header className="header">
        <div className="brand">
          <div className="brand-mark"><Package size={22} /></div>
          <div>
            <h1>CargoVerdict</h1>
            <p>Neutral B2B shipment escrow on GenLayer</p>
          </div>
        </div>
        <div className="header-right">
          <div className="network"><span className="dot" /> studionet</div>
          {account ? (
            <button className="btn-secondary" onClick={connectWallet}>
              <Wallet size={16} /> {shortAddr(account)}
            </button>
          ) : (
            <button className="btn-primary" onClick={connectWallet}>
              <Wallet size={16} /> Connect wallet
            </button>
          )}
        </div>
      </header>

      {errorMessage && <div className="err-banner">{errorMessage}</div>}
      {txHash && (
        <div className="ok-banner mono">
          Transaction submitted.{' '}
          <a href={txExplorerUrl(txHash)} target="_blank" rel="noreferrer">
            Open in Explorer
          </a>
        </div>
      )}

      <div className="tabs">
        <button className={`tab ${tab === 'create' ? 'active' : ''}`} onClick={() => setTab('create')}>
          <PlusCircle size={16} /> Create order
        </button>
        <button className={`tab ${tab === 'orders' ? 'active' : ''}`} onClick={() => setTab('orders')}>
          <List size={16} /> Orders
        </button>
        <button className="tab" onClick={() => fetchOrders()} disabled={loading}>
          <RefreshCw size={16} /> Refresh
        </button>
      </div>

      {tab === 'create' && (
        <form className="card" onSubmit={handleCreate}>
          <h2>Lock GEN against a shipment</h2>
          <p className="hint">Buyer funds escrow now. Two fixed amounts are agreed up front — full payment if intact, a smaller fixed payout if damaged. Independent references are pinned by the <strong>seller</strong> at shipment — the buyer cannot steer them.</p>
          <div className="chips" style={{ marginBottom: '1rem' }}>
            <button
              type="button"
              className="chip"
              onClick={() => {
                setGoods(SAMPLE_ORDER.goods);
                setEscrowStr(SAMPLE_ORDER.escrow);
                setDamagedStr(SAMPLE_ORDER.damaged);
                setDeadlineDays(SAMPLE_ORDER.deadlineDays);
                setReportDays(SAMPLE_ORDER.reportDays);
                setOriginUrls([EXAMPLE_ORIGIN_URL]);
                setDeliveryUrls([EXAMPLE_DELIVERY_URL]);
                setRefUrls([...EXAMPLE_REFERENCE_URLS]);
              }}
            >
              Fill sewing-machine sample
            </button>
          </div>
          <p className="hint">Sample fills description, 1 GEN escrow, 0.7 GEN damaged payout, ship-by 14 days, and buyer-report-by 21 days. Paste the seller&apos;s wallet yourself. Seller later pins reference URLs; buyer only adds delivery evidence.</p>

          <div className="field">
            <label className="label">Goods description</label>
            <textarea
              className="input textarea"
              rows={3}
              placeholder={GOODS_HINT}
              value={goods}
              onChange={(e) => setGoods(e.target.value)}
            />
          </div>

          <div className="field">
            <label className="label">Seller address</label>
            <div className="url-row">
              <input
                className="input mono"
                placeholder="0x…"
                value={sellerAddr}
                onChange={(e) => setSellerAddr(e.target.value.trim())}
              />
              <button
                type="button"
                className="btn-ghost"
                onClick={async () => setSellerAddr(await pasteClipboard())}
              >
                <ClipboardPaste size={16} />
              </button>
            </div>
          </div>

          <div className="field">
            <label className="label">Escrow (full payment if intact)</label>
            <input
              className="input"
              value={escrowStr}
              onChange={(e) => setEscrowStr(sanitizeGenInput(e.target.value))}
              inputMode="decimal"
            />
            <div className="chips" style={{ marginTop: '0.5rem' }}>
              {ESCROW_PRESETS.map((p) => (
                <button
                  type="button"
                  key={p}
                  className={`chip ${escrowStr === p ? 'active' : ''}`}
                  onClick={() => setEscrowStr(p)}
                >
                  {p} GEN
                </button>
              ))}
            </div>
            <p className="hint">{formatWeiToGen(escrowWei)} GEN → {escrowWei.toString()} wei</p>
          </div>

          <div className="field">
            <label className="label">Damaged payout to seller (fixed GEN, not %)</label>
            <input
              className="input"
              value={damagedStr}
              onChange={(e) => setDamagedStr(sanitizeGenInput(e.target.value))}
              inputMode="decimal"
              placeholder="Choose a preset or type a GEN amount"
            />
            <div className="chips" style={{ marginTop: '0.5rem' }}>
              {damagedHints.map(({ pct, wei }) => (
                <button
                  type="button"
                  key={pct}
                  className={`chip ${damagedWei === wei && wei > 0n ? 'active' : ''}`}
                  disabled={wei <= 0n}
                  onClick={() => setDamagedStr(formatWeiToGen(wei))}
                >
                  {pct}% hint = {formatWeiToGen(wei)} GEN
                </button>
              ))}
            </div>
            <p className="hint">
              Presets are display-only BigInt division. The contract stores the chosen wei integer.
              Buyer refund if DAMAGED = escrow − this amount = {damagedOk ? `${formatWeiToGen(escrowWei - damagedWei)} GEN` : '—'}.
            </p>
            {!damagedOk && escrowWei > 0n && (
              <p className="hint warn-text">Must be &gt; 0 and strictly less than escrow.</p>
            )}
          </div>

          <div className="field">
            <label className="label">Shipment deadline</label>
            <div className="chips">
              {DEADLINE_PRESETS.map((p) => (
                <button
                  type="button"
                  key={p.days}
                  className={`chip ${deadlineDays === p.days ? 'active' : ''}`}
                  onClick={() => {
                    setDeadlineDays(p.days);
                    setReportDays(p.reportDays);
                  }}
                >
                  <Clock size={14} /> Ship by {p.label}
                </button>
              ))}
            </div>
            <p className="hint">Seller must confirm shipment (and pin independent references) before this window. After that, buyer can reclaim the full escrow without AI.</p>
          </div>

          <div className="field">
            <label className="label">Buyer report deadline</label>
            <p className="hint">
              Buyer must report delivery evidence by day {reportDays} (strictly after ship-by day {deadlineDays}).
              If the buyer never reports, the seller can claim the full escrow after this deadline.
            </p>
          </div>

          <button className="btn-primary full" type="submit" disabled={loading || !hasContractAddress || !account}>
            Create order & lock escrow
          </button>
        </form>
      )}

      {tab === 'orders' && (
        <>
          <div className="chips" style={{ marginBottom: '1rem' }}>
            <button className={`chip ${filter === 'all' ? 'active' : ''}`} onClick={() => setFilter('all')}>All</button>
            <button className={`chip ${filter === 'buyer' ? 'active' : ''}`} onClick={() => setFilter('buyer')}>I am buyer</button>
            <button className={`chip ${filter === 'seller' ? 'active' : ''}`} onClick={() => setFilter('seller')}>I am seller</button>
          </div>
          {visibleOrders.length === 0 && (
            <div className="empty">No orders yet. Create one as buyer, then share the order id with the seller.</div>
          )}
          <div className="grid">
            {visibleOrders.map((raw) => {
              const o = merged(raw);
              const id = o.order_id;
              const isBuyer = sameAddress(o.buyer, account);
              const isSeller = sameAddress(o.seller, account);
              const preview = settlementPreview(o);
              const escrow = weiFromOrderField(o.escrow_amount);
              const damaged = weiFromOrderField(o.damaged_payout_to_seller);
              const hint = nextActionHint({
                status: o.status,
                isBuyer,
                isSeller,
                seller: o.seller,
                buyer: o.buyer,
              });
              return (
                <article className="card" key={id}>
                  <div className="row-between">
                    <div>
                      <h3>Order #{id}</h3>
                      <p className="hint">{o.goods_description || '—'}</p>
                    </div>
                    <span className={statusClass(o.status)}>{o.status}</span>
                  </div>

                  <FlowStrip status={o.status} />

                  <div className="next-box">
                    <strong>{hint.title}</strong>
                    <p className="hint">{hint.body}</p>
                  </div>

                  <div className="tier-grid" style={{ marginTop: '0.8rem' }}>
                    <div><span>Escrow</span><b>{formatWeiToGen(escrow)} GEN</b></div>
                    <div><span>If damaged, seller gets</span><b>{formatWeiToGen(damaged)} GEN</b></div>
                    <div><span>Buyer</span><b className="mono">{shortAddr(o.buyer)}</b></div>
                    <div><span>Seller</span><b className="mono">{shortAddr(o.seller)}</b></div>
                  </div>
                  <p className="hint"><Clock size={12} /> Ship by {formatDeadline(o.shipment_deadline)}</p>
                  <p className="hint"><Clock size={12} /> Buyer report by {formatDeadline(o.delivery_report_deadline)}</p>
                  {formatUrlList(o.origin_condition_urls) && (
                    <p className="hint mono">Origin: {formatUrlList(o.origin_condition_urls)}</p>
                  )}
                  {formatUrlList(o.reference_urls) && (
                    <p className="hint mono">Seller-pinned refs: {formatUrlList(o.reference_urls)}</p>
                  )}
                  {formatUrlList(o.delivery_evidence_urls) && (
                    <p className="hint mono">Delivery: {formatUrlList(o.delivery_evidence_urls)}</p>
                  )}

                  <div className="chips" style={{ marginTop: '0.6rem' }}>
                    <button type="button" className="chip" onClick={() => copyText(id, id)}>
                      <Copy size={14} /> {copied === id ? 'Copied id' : 'Share order id'}
                    </button>
                    <button type="button" className="chip" onClick={() => copyText(`seller-${id}`, o.seller)}>
                      <Copy size={14} /> {copied === `seller-${id}` ? 'Copied seller' : 'Copy seller address'}
                    </button>
                    {activeOrderId === id ? null : (
                      <button type="button" className="chip" onClick={() => { setActiveOrderId(id); fetchDetail(id); }}>
                        Details
                      </button>
                    )}
                  </div>

                  {o.verdict && (
                    <div className={`verdict-box ${verdictClass(o.verdict)}`}>
                      <strong>{o.verdict}</strong>
                      <p className="hint">Confidence {o.confidence}/100 — {o.verdict_reason || '—'}</p>
                      <p className="hint">
                        Seller {formatWeiToGen(preview.seller)} GEN {payoutSideLabel(preview.seller, o.seller_paid, 'paid')}
                        {' · '}
                        Buyer {formatWeiToGen(preview.buyer)} GEN {payoutSideLabel(preview.buyer, o.buyer_refunded, 'refunded')}
                      </p>
                    </div>
                  )}

                  {o.status === 'SELLER_TIMEOUT_PAID' && (
                    <div className={`verdict-box ${verdictClass('DELIVERED_INTACT')}`}>
                      <strong>Seller timeout paid</strong>
                      <p className="hint">{o.verdict_reason || 'Buyer never reported delivery.'}</p>
                      <p className="hint">Seller {formatWeiToGen(escrow)} GEN (paid)</p>
                    </div>
                  )}

                  {o.status === 'PAYOUT_FAILED' && (
                    <div className="verdict-box verdict-missing">
                      <strong>Payout incomplete</strong>
                      <p className="hint">
                        Seller: {o.seller_paid ? 'paid' : 'needs retry'} · Buyer: {o.buyer_refunded ? 'refunded' : 'needs retry'}
                      </p>
                      {(isBuyer || isSeller) && (
                        <button className="btn-secondary" onClick={() => handleRetry(id)} disabled={loading}>
                          <RotateCcw size={16} /> Retry unpaid side only
                        </button>
                      )}
                    </div>
                  )}

                  <div className="actions">
                    {o.status === 'AWAITING_SHIPMENT' && isSeller && (
                      <>
                        <UrlEditor
                          label="Origin condition URLs"
                          values={originUrls}
                          setValues={setOriginUrls}
                          min={1}
                          placeholder="https://photo of packed goods…"
                          example={EXAMPLE_ORIGIN_URL}
                        />
                        <UrlEditor
                          label="Independent reference URLs (locked after confirm)"
                          values={refUrls}
                          setValues={setRefUrls}
                          min={2}
                          placeholder="https://carrier tracking or customs page…"
                          example={EXAMPLE_REFERENCE_URLS}
                        />
                        <p className="hint">These references become the primary AI source of truth. The buyer cannot replace them.</p>
                        <button className="btn-primary" type="button" onClick={() => handleShip(id)} disabled={loading}>
                          <Ship size={16} /> Confirm shipment
                        </button>
                      </>
                    )}

                    {o.status === 'AWAITING_SHIPMENT' && isBuyer && (
                      <>
                        <p className="hint">Claim no-shipment refund only after the ship-by time if the seller never confirms.</p>
                        <button className="btn-danger" type="button" onClick={() => handleExpiryRefund(id)} disabled={loading}>
                          Claim no-shipment refund
                        </button>
                      </>
                    )}

                    {o.status === 'SHIPPED' && isSeller && (
                      <>
                        <p className="hint">If the buyer never reports by the report deadline, claim the full escrow here.</p>
                        <button className="btn-secondary" type="button" onClick={() => handleSellerTimeout(id)} disabled={loading}>
                          Claim unreported-delivery payout
                        </button>
                      </>
                    )}

                    {(o.status === 'SHIPPED' || o.status === 'DISPUTED' || o.status === 'DELIVERY_REPORTED') && isBuyer && (
                      <>
                        {o.status === 'DISPUTED' && (
                          <p className="hint">AI was not confident (often weak seller-pinned refs). Submit clearer delivery evidence, then resolve again. References stay seller-pinned.</p>
                        )}
                        {o.status === 'DELIVERY_REPORTED' && (
                          <p className="hint">
                            You can replace delivery evidence only. Seller-pinned references stay locked. If Report delivery is rejected, redeploy the new contract and create a new order.
                          </p>
                        )}
                        <UrlEditor
                          label="Delivery evidence URLs"
                          values={deliveryUrls}
                          setValues={setDeliveryUrls}
                          min={1}
                          placeholder="https://unboxing / inspection photo…"
                          example={EXAMPLE_DELIVERY_URL}
                        />
                        <button className="btn-secondary" type="button" onClick={() => handleReport(id)} disabled={loading}>
                          Report delivery
                        </button>
                      </>
                    )}

                    {o.status === 'DELIVERY_REPORTED' && (
                      <>
                        <p className="hint">
                          AI prioritizes seller-pinned references. Failed or generic pages become DISPUTED — not an automatic buyer refund. Keep this tab open 2–5 minutes.
                        </p>
                        <button
                          className="btn-ai"
                          type="button"
                          onClick={() => handleResolve(id)}
                          disabled={loading || resolvingId === id}
                        >
                          {resolvingId === id ? <span className="spinner" /> : <Scale size={16} />}
                          {resolvingId === id ? 'AI is adjudicating — keep this tab open…' : 'Request AI adjudication'}
                        </button>
                      </>
                    )}
                  </div>
                </article>
              );
            })}
          </div>
        </>
      )}
    </div>
  );
}

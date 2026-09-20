import { useEffect, useMemo, useState } from 'react';
import { contractApi } from '../api.js';

const URGENCY_NAME = { 1: '普通', 2: '加急', 3: '特急' };
const OUTCOME_NAME = {
  'on-time': '准时送达',
  late: '逾时送达',
  wrong: '误投',
  'wrong-late': '误投且逾时',
  undelivered: '未送达'
};
const SETTLE_OPTIONS = ['on-time', 'late', 'wrong', 'wrong-late', 'undelivered'];
const RATE_FIELDS = [
  ['baseFee', '基础邮资'],
  ['perWeight', '每 kg 加价'],
  ['latePenalty', '逾时减/赔'],
  ['wrongPenalty', '误投赔付'],
  ['cancelBeforeCutoff', '出港前取消比例'],
  ['cancelAfterCutoff', '出港后取消比例']
];

function amountClass(amount) {
  return amount > 0 ? 'positive' : amount < 0 ? 'negative' : '';
}

function formatAmount(amount) {
  return `${amount > 0 ? '+' : ''}${Number(amount).toFixed(2)}`;
}

export default function ContractCenter({ game, open, onClose, onState, onError, busy, setBusy }) {
  const [data, setData] = useState(null);
  const [letterId, setLetterId] = useState('');
  const [customTitle, setCustomTitle] = useState('');
  const [customUrgency, setCustomUrgency] = useState(1);
  const [customWeight, setCustomWeight] = useState(2);
  const [quote, setQuote] = useState(null);
  const [rateDraft, setRateDraft] = useState({});
  const [actionContract, setActionContract] = useState(null);
  const [actionMode, setActionMode] = useState('');
  const [actionOutcome, setActionOutcome] = useState('on-time');
  const [actionStage, setActionStage] = useState('before-cutoff');
  const [actionReason, setActionReason] = useState('');

  useEffect(() => {
    if (!open) return;
    let active = true;
    contractApi.list()
      .then(({ contracts }) => active && setData(contracts))
      .catch((error) => onError?.(error.message));
    return () => { active = false; };
  }, [open, game.revision]);

  const openLetters = useMemo(() => (
    game.letters.filter((letter) => letter.status === 'inbox' || letter.status === 'backlog')
  ), [game.letters]);

  useEffect(() => {
    if (!open || !letterId) {
      setQuote(null);
      return;
    }
    let active = true;
    const letter = openLetters.find((item) => item.id === letterId);
    if (!letter) {
      setQuote(null);
      return undefined;
    }
    contractApi.quote({ urgency: letter.urgency, weight: letter.weight })
      .then(({ quote: nextQuote }) => active && setQuote(nextQuote))
      .catch(() => active && setQuote(null));
    return () => { active = false; };
  }, [open, letterId, openLetters]);

  useEffect(() => {
    if (open && letterId === '' && openLetters.length > 0) {
      setLetterId(openLetters[0].id);
    }
  }, [open, letterId, openLetters]);

  if (!open) return null;

  async function refresh(result) {
    if (result?.state) onState?.(result.state);
    const { contracts } = await contractApi.list();
    setData(contracts);
  }

  async function run(action) {
    setBusy(true);
    try {
      const result = await action();
      await refresh(result);
      setActionContract(null);
      setActionMode('');
      setActionReason('');
      setRateDraft({});
      setCustomTitle('');
    } catch (error) {
      onError?.(error.message);
    } finally {
      setBusy(false);
    }
  }

  function createFromLetter() {
    if (!letterId) return;
    return run(() => contractApi.create({ letterId }, game.revision));
  }

  function createCustom() {
    return run(() => contractApi.create({
      title: customTitle,
      urgency: customUrgency,
      weight: Number(customWeight)
    }, game.revision));
  }

  function saveRates() {
    return run(() => contractApi.adjustRates(rateDraft, game.revision));
  }

  function submitAction() {
    if (!actionContract) return;
    if (actionMode === 'settle') {
      return run(() => contractApi.settle(actionContract.id, actionOutcome, game.revision, actionReason));
    }
    if (actionMode === 'recalculate') {
      return run(() => contractApi.recalculate(actionContract.id, actionOutcome, game.revision, actionReason));
    }
    return run(() => contractApi.cancel(actionContract.id, actionStage, game.revision, actionReason));
  }

  const summary = data?.summary;
  const contracts = [...(data?.contracts || [])].reverse();
  const ledger = [...(data?.ledger || [])].reverse();
  const tiers = data?.rateCard?.tiers;

  return (
    <div className="dialog-backdrop" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <section className="report-dialog contract-dialog" role="dialog" aria-modal="true" aria-labelledby="contracts-title">
        <div className="report-header">
          <div>
            <p className="eyebrow">委托对账台账</p>
            <h2 id="contracts-title">邮资委托合约中心</h2>
          </div>
          <button type="button" className="contract-close" onClick={onClose}>关闭</button>
        </div>

        <div className="report-stats">
          <div><b>{summary?.activeCount ?? 0}</b><span>履约中</span></div>
          <div><b>{summary?.settledCount ?? 0}</b><span>已结算</span></div>
          <div><b>{summary?.cancelledCount ?? 0}</b><span>已取消</span></div>
          <div>
            <b className={amountClass(summary?.ledgerBalance ?? 0)}>{formatAmount(summary?.ledgerBalance ?? 0)}</b>
            <span>委托金净额（费率 v{data?.rateCard?.version ?? 1}）</span>
          </div>
        </div>

        <div className="report-scroll contract-scroll">
          <div className="report-section">
            <h3>新签委托（按当前费率卡快照）</h3>
            <div className="contract-create-row">
              <select value={letterId} onChange={(event) => setLetterId(event.target.value)}>
                {openLetters.length === 0 && <option value="">今日无待投递邮件</option>}
                {openLetters.map((letter) => (
                  <option key={letter.id} value={letter.id}>
                    {letter.id} · {URGENCY_NAME[letter.urgency]} · {letter.weight}kg
                  </option>
                ))}
              </select>
              {quote && (
                <span className="contract-quote">
                  预计应付 <b className="positive">{quote.expectedPayable.toFixed(2)}</b>（快照 v{quote.rateVersion}）
                </span>
              )}
              <button type="button" disabled={busy || !letterId} onClick={createFromLetter}>为邮件签约</button>
            </div>
            <div className="contract-create-row custom-contract">
              <input
                value={customTitle}
                onChange={(event) => setCustomTitle(event.target.value)}
                placeholder="或签订自定义委托标题"
                maxLength={40}
              />
              <select value={customUrgency} onChange={(event) => setCustomUrgency(Number(event.target.value))}>
                <option value={1}>普通</option>
                <option value={2}>加急</option>
                <option value={3}>特急</option>
              </select>
              <input
                type="number"
                min="0.1"
                max="50"
                step="0.1"
                value={customWeight}
                onChange={(event) => setCustomWeight(event.target.value)}
                title="重量 kg"
              />
              <button type="button" disabled={busy || customTitle.trim().length === 0} onClick={createCustom}>自定义签约</button>
            </div>
          </div>

          <div className="report-section">
            <h3>费率卡（调整只影响新单）</h3>
            <div className="rate-grid">
              {[1, 2, 3].map((urgency) => (
                <div className="rate-tier" key={urgency}>
                  <h4>{URGENCY_NAME[urgency]}</h4>
                  {RATE_FIELDS.map(([field, label]) => (
                    <label key={field}>
                      <span>{label}</span>
                      <input
                        type="number"
                        step={field.startsWith('cancel') ? '0.05' : '0.5'}
                        defaultValue={tiers?.[urgency]?.[field] ?? ''}
                        onChange={(event) => {
                          const value = Number(event.target.value);
                          setRateDraft((current) => ({
                            ...current,
                            [urgency]: { ...current[urgency], [field]: value }
                          }));
                        }}
                      />
                    </label>
                  ))}
                </div>
              ))}
            </div>
            <button
              type="button"
              className="rate-save"
              disabled={busy || Object.keys(rateDraft).length === 0}
              onClick={saveRates}
            >
              发布新费率（仅新合约生效）
            </button>
          </div>

          <div className="report-section">
            <h3>合约清单</h3>
            <div className="contract-list">
              {contracts.map((contract) => (
                <div className={`contract-card status-${contract.status}`} key={contract.id}>
                  <div className="contract-card-head">
                    <code>{contract.id}</code>
                    <span className={`contract-status ${contract.status}`}>
                      {contract.status === 'active' ? '履约中'
                        : contract.status === 'settled' ? '已结算'
                          : contract.status === 'recalculated' ? '已重算' : '已取消'}
                    </span>
                    {contract.letterId && <small>{contract.letterId}</small>}
                  </div>
                  <strong>{contract.title}</strong>
                  <div className="contract-meta">
                    <span>{URGENCY_NAME[contract.urgency]}</span>
                    <span>{contract.weight} kg</span>
                    <span>快照 v{contract.rateSnapshot.version}</span>
                    <span>第 {contract.createdAtDay} 日签约</span>
                    {contract.outcome && <span>{OUTCOME_NAME[contract.outcome]}</span>}
                  </div>
                  <div className="contract-amount">
                    <span>当前应付</span>
                    <b className={amountClass(contract.amount)}>{formatAmount(contract.amount)}</b>
                  </div>
                  <div className="contract-actions">
                    {contract.status === 'active' && (
                      <>
                        <button type="button" disabled={busy} onClick={() => { setActionContract(contract); setActionMode('settle'); setActionOutcome('on-time'); }}>
                          手动结算
                        </button>
                        <button type="button" disabled={busy} onClick={() => { setActionContract(contract); setActionMode('cancel'); setActionStage('before-cutoff'); }}>
                          取消
                        </button>
                      </>
                    )}
                    {(contract.status === 'settled' || contract.status === 'recalculated') && (
                      <button type="button" disabled={busy} onClick={() => { setActionContract(contract); setActionMode('recalculate'); setActionOutcome(contract.outcome || 'on-time'); }}>
                        争议重算
                      </button>
                    )}
                  </div>
                </div>
              ))}
            </div>
          </div>

          <div className="report-section">
            <h3>对账轨迹（只追加，永不覆盖）</h3>
            <div className="ledger-list">
              {ledger.map((event) => (
                <div className="ledger-row" key={event.id}>
                  <code>{event.id}</code>
                  <span className="ledger-type">
                    {event.type === 'created' ? '签约'
                      : event.type === 'settled' ? '结算'
                        : event.type === 'recalculated' ? '重算'
                          : event.type === 'cancelled' ? '取消' : '调价'}
                  </span>
                  {event.contractId && <span className="ledger-contract">{event.contractId}</span>}
                  <b className={amountClass(event.delta)}>{formatAmount(event.delta)}</b>
                  <small>
                    第 {event.day} 日
                    {event.outcome ? ` · ${OUTCOME_NAME[event.outcome] || event.outcome}` : ''}
                    {event.stage === 'before-cutoff' ? ' · 出港前' : event.stage === 'after-cutoff' ? ' · 出港后' : ''}
                    {event.previousAmount !== undefined && event.previousAmount !== null
                      ? `（原 ${Number(event.previousAmount).toFixed(2)} → ${Number(event.amount).toFixed(2)}）`
                      : ''}
                    {event.rateVersion ? ` · v${event.rateVersion}` : ''}
                    {event.reason ? ` · ${event.reason}` : ''}
                  </small>
                </div>
              ))}
            </div>
          </div>
        </div>

        {actionContract && (
          <div className="contract-action-bar">
            <div>
              <strong>{actionContract.id} · {actionMode === 'cancel' ? '取消合约' : actionMode === 'recalculate' ? '争议重算' : '手动结算'}</strong>
              {actionMode !== 'cancel' ? (
                <select value={actionOutcome} onChange={(event) => setActionOutcome(event.target.value)}>
                  {SETTLE_OPTIONS.map((option) => <option key={option} value={option}>{OUTCOME_NAME[option]}</option>)}
                </select>
              ) : (
                <select value={actionStage} onChange={(event) => setActionStage(event.target.value)}>
                  <option value="before-cutoff">出港前取消</option>
                  <option value="after-cutoff">出港后取消</option>
                </select>
              )}
            </div>
            <input
              value={actionReason}
              onChange={(event) => setActionReason(event.target.value)}
              placeholder={actionMode === 'settle' ? '备注（可留空，自动结算会注明）' : '必须填写原因，写入对账轨迹'}
              maxLength={200}
            />
            <div>
              <button type="button" onClick={() => { setActionContract(null); setActionReason(''); }}>返回</button>
              <button type="button" className="confirm" disabled={busy || (actionMode !== 'settle' && actionReason.trim().length === 0)} onClick={submitAction}>
                确认{actionMode === 'cancel' ? '取消' : actionMode === 'recalculate' ? '重算' : '结算'}
              </button>
            </div>
          </div>
        )}
      </section>
    </div>
  );
}

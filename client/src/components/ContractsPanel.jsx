import { useMemo, useState } from 'react';
import { CONTRACT_OUTCOME_LABELS, LEDGER_TYPE_LABELS, formatCredits } from '../utils.js';

const URGENCY_LABELS = { 1: '常规', 2: '优先', 3: '加急' };
const RATE_GROUP_ROWS = [
  ['base', '准时应付'],
  ['late', '逾时应付'],
  ['wrongPenalty', '误投违约'],
  ['backlogPenalty', '积压违约/日'],
  ['cancelFee', '撤单手续费']
];

function payableFor(rates, outcome) {
  if (outcome === 'on-time') return rates.base;
  if (outcome === 'late') return rates.late;
  return -rates.wrongPenalty;
}

function cloneRates(rates) {
  return Object.fromEntries(
    Object.entries(rates).map(([group, groupRates]) => [group, { ...groupRates }])
  );
}

function PriceDialog({ currentTable, busy, onClose, onSubmit }) {
  const [rates, setRates] = useState(() => cloneRates(currentTable.rates));
  const [note, setNote] = useState('');

  function updateRate(group, urgency, value) {
    setRates((current) => ({
      ...current,
      [group]: { ...current[group], [urgency]: value }
    }));
  }

  function submit() {
    const normalized = {};
    for (const [group, groupRates] of Object.entries(rates)) {
      normalized[group] = {};
      for (const [urgency, value] of Object.entries(groupRates)) {
        normalized[group][urgency] = Number(value);
      }
    }
    onSubmit(normalized, note);
  }

  return (
    <div className="dialog-backdrop" role="presentation">
      <section className="contract-dialog" role="dialog" aria-modal="true" aria-labelledby="price-dialog-title">
        <div className="contract-dialog-header">
          <div>
            <p className="eyebrow">牌价调整</p>
            <h2 id="price-dialog-title">第 {currentTable.version + 1} 版牌价</h2>
          </div>
          <button type="button" className="dialog-close" onClick={onClose} aria-label="关闭">×</button>
        </div>

        <p className="dialog-hint">调价只影响之后生成的新合约；已锁定的合约仍按原牌价结算。本次调整会记入对账轨迹。</p>

        <div className="rate-grid editable">
          <span className="rate-grid-head" />
          {Object.values(URGENCY_LABELS).map((label) => <b key={label}>{label}</b>)}
          {RATE_GROUP_ROWS.map(([group, label]) => (
            <RateRowInputs
              key={group}
              group={group}
              label={label}
              rates={rates[group]}
              onChange={updateRate}
            />
          ))}
        </div>

        <label className="price-note">
          <span>调价事由</span>
          <input
            type="text"
            value={note}
            maxLength={80}
            placeholder="例如：风暴季加急件上浮"
            onChange={(event) => setNote(event.target.value)}
          />
        </label>

        <div className="dialog-actions">
          <button type="button" className="ghost-button" onClick={onClose} disabled={busy}>取消</button>
          <button type="button" className="primary-button" onClick={submit} disabled={busy}>
            {busy ? '提交中...' : '发布新牌价'}
          </button>
        </div>
      </section>
    </div>
  );
}

function RateRowInputs({ group, label, rates, onChange }) {
  return (
    <>
      <span className="rate-grid-label">{label}</span>
      {[1, 2, 3].map((urgency) => (
        <input
          key={urgency}
          type="number"
          min="0"
          max="999"
          step="0.5"
          value={rates[urgency]}
          aria-label={`${label} · ${URGENCY_LABELS[urgency]}`}
          onChange={(event) => onChange(group, urgency, event.target.value)}
        />
      ))}
    </>
  );
}

function RecalculateDialog({ contract, busy, onClose, onSubmit }) {
  const [outcome, setOutcome] = useState(contract.outcome);
  const nextAmount = payableFor(contract.rates, outcome);
  const delta = Math.round((nextAmount - contract.settledAmount) * 10) / 10;

  return (
    <div className="dialog-backdrop" role="presentation">
      <section className="contract-dialog" role="dialog" aria-modal="true" aria-labelledby="recalc-dialog-title">
        <div className="contract-dialog-header">
          <div>
            <p className="eyebrow">应付款重算</p>
            <h2 id="recalc-dialog-title">{contract.id} · 第 {contract.priceVersion} 版牌价</h2>
          </div>
          <button type="button" className="dialog-close" onClick={onClose} aria-label="关闭">×</button>
        </div>

        <p className="dialog-hint">
          重算按合约锁定的牌价重新核定应付款，差额会作为新记录追加到账本，原结算记录保留。
        </p>

        <div className="recalc-body">
          <label>
            <span>裁定情形</span>
            <select value={outcome} onChange={(event) => setOutcome(event.target.value)}>
              {Object.entries(CONTRACT_OUTCOME_LABELS).map(([value, label]) => (
                <option key={value} value={value}>{label}</option>
              ))}
            </select>
          </label>
          <div className="recalc-diff">
            <span>当前应付 <b>{formatCredits(contract.settledAmount)}</b> 枚</span>
            <i>→</i>
            <span>重算后 <b>{formatCredits(nextAmount)}</b> 枚</span>
            <em className={delta > 0 ? 'positive' : delta < 0 ? 'negative' : ''}>
              {delta === 0 ? '无差额' : `差额 ${formatCredits(delta, { signed: true })} 枚`}
            </em>
          </div>
        </div>

        <div className="dialog-actions">
          <button type="button" className="ghost-button" onClick={onClose} disabled={busy}>取消</button>
          <button type="button" className="primary-button" onClick={() => onSubmit(contract.id, outcome)} disabled={busy}>
            {busy ? '重算中...' : '确认重算'}
          </button>
        </div>
      </section>
    </div>
  );
}

export default function ContractsPanel({ game, busy, onAdjustPrices, onCancelContract, onRecalculate }) {
  const [priceDialogOpen, setPriceDialogOpen] = useState(false);
  const [recalcTargetId, setRecalcTargetId] = useState(null);

  const letterMap = useMemo(() => new Map(game.letters.map((letter) => [letter.id, letter])), [game.letters]);
  const contractMap = useMemo(() => new Map(game.contracts.map((contract) => [contract.id, contract])), [game.contracts]);
  const currentTable = game.priceTables[game.priceTables.length - 1];
  const openContracts = useMemo(() => (
    game.contracts
      .filter((contract) => contract.status === 'open')
      .sort((first, second) => second.urgency - first.urgency || first.id.localeCompare(second.id))
  ), [game.contracts]);
  const ledgerEntries = useMemo(() => [...game.ledger].reverse(), [game.ledger]);
  const recalcTarget = recalcTargetId ? contractMap.get(recalcTargetId) : null;
  const planning = game.phase === 'planning';

  async function submitPrices(rates, note) {
    const ok = await onAdjustPrices(rates, note);
    if (ok) setPriceDialogOpen(false);
  }

  async function submitRecalculate(contractId, outcome) {
    const ok = await onRecalculate(contractId, outcome);
    if (ok) setRecalcTargetId(null);
  }

  function confirmCancel(contract) {
    const letter = letterMap.get(contract.letterId);
    const subject = letter ? `「${letter.subject}」` : '';
    const message = `撤单 ${contract.id}${subject} 将收取 ${contract.rates.cancelFee} 枚手续费，邮件退出投递队列，记录保留在对账轨迹中。确定撤单吗？`;
    if (window.confirm(message)) onCancelContract(contract.id);
  }

  return (
    <section className="panel contracts-panel" aria-labelledby="contracts-title">
      <div className="panel-heading">
        <div>
          <p className="eyebrow">邮资委托合约</p>
          <h2 id="contracts-title">合约与对账 <b>第 {currentTable.version} 版牌价</b></h2>
        </div>
        <button
          type="button"
          className="ghost-button"
          disabled={busy || !planning}
          onClick={() => setPriceDialogOpen(true)}
          title={planning ? '发布新版牌价，仅影响新合约' : '本局已结束'}
        >
          调整牌价
        </button>
      </div>

      <div className="contracts-body">
        <div className="rate-grid" aria-label="当前牌价">
          <span className="rate-grid-head" />
          {Object.values(URGENCY_LABELS).map((label) => <b key={label}>{label}</b>)}
          {RATE_GROUP_ROWS.map(([group, label]) => (
            <RateRowDisplay key={group} label={label} groupRates={currentTable.rates[group]} negative={group !== 'base' && group !== 'late'} />
          ))}
        </div>
        <p className="rate-grid-note">第 {currentTable.effectiveDay} 日起生效 · {currentTable.note}</p>

        <div className="contract-columns">
          <div className="contract-list-block">
            <h3>履约中合约 <b>{openContracts.length}</b></h3>
            <div className="contract-list">
              {openContracts.length === 0 && <p className="contract-empty">当前没有待履约的合约。</p>}
              {openContracts.map((contract) => {
                const letter = letterMap.get(contract.letterId);
                return (
                  <div className="contract-row" key={contract.id}>
                    <div className="contract-row-main">
                      <code>{contract.id}</code>
                      <span className={`urgency-tag ${contract.urgency === 3 ? 'urgent' : contract.urgency === 2 ? 'priority' : 'routine'}`}>
                        {URGENCY_LABELS[contract.urgency]}
                      </span>
                      <span className="contract-subject">{letter?.subject || contract.letterId}</span>
                    </div>
                    <div className="contract-row-side">
                      <span className="contract-quote">应付 <b>{formatCredits(contract.quotedAmount)}</b> 枚</span>
                      <button
                        type="button"
                        className="cancel-contract-button"
                        disabled={busy || !planning}
                        onClick={() => confirmCancel(contract)}
                      >
                        撤单
                      </button>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>

          <div className="ledger-block">
            <h3>对账轨迹 <b>{game.ledger.length}</b></h3>
            <div className="ledger-list">
              {ledgerEntries.map((entry) => {
                const contract = entry.contractId ? contractMap.get(entry.contractId) : null;
                const canRecalculate = planning && entry.type === 'settlement' && contract?.status === 'settled';
                return (
                  <div className={`ledger-row type-${entry.type}`} key={entry.id}>
                    <div className="ledger-row-top">
                      <span className="ledger-day">第{entry.day}日</span>
                      <span className="ledger-tag">{LEDGER_TYPE_LABELS[entry.type] || entry.type}</span>
                      {entry.contractId && <code>{entry.contractId}</code>}
                      <b className={entry.amount > 0 ? 'positive' : entry.amount < 0 ? 'negative' : ''}>
                        {formatCredits(entry.amount, { signed: true })}
                      </b>
                      <span className="ledger-balance">余 {formatCredits(entry.balanceAfter)}</span>
                      {canRecalculate && (
                        <button
                          type="button"
                          className="recalc-button"
                          disabled={busy}
                          onClick={() => setRecalcTargetId(contract.id)}
                        >
                          重算
                        </button>
                      )}
                    </div>
                    <p className="ledger-note">
                      {entry.note}
                      {entry.requestedAmount !== undefined && entry.requestedAmount !== entry.amount
                        ? `（请求 ${formatCredits(entry.requestedAmount, { signed: true })}，余额不足按实际入账）`
                        : ''}
                    </p>
                  </div>
                );
              })}
            </div>
          </div>
        </div>
      </div>

      {priceDialogOpen && (
        <PriceDialog
          currentTable={currentTable}
          busy={busy}
          onClose={() => setPriceDialogOpen(false)}
          onSubmit={submitPrices}
        />
      )}
      {recalcTarget && (
        <RecalculateDialog
          contract={recalcTarget}
          busy={busy}
          onClose={() => setRecalcTargetId(null)}
          onSubmit={submitRecalculate}
        />
      )}
    </section>
  );
}

function RateRowDisplay({ label, groupRates, negative }) {
  return (
    <>
      <span className="rate-grid-label">{label}</span>
      {[1, 2, 3].map((urgency) => (
        <span key={urgency} className="rate-cell">
          {negative ? '−' : ''}{formatCredits(groupRates[urgency])}
        </span>
      ))}
    </>
  );
}

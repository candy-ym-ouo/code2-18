export function formatHour(value) {
  const numericValue = Number(value);
  if (!Number.isFinite(numericValue) || numericValue < 0) return '--:--';

  const totalMinutes = Math.round(numericValue * 60);
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}`;
}

export const LEDGER_TYPE_LABELS = {
  opening: '对账起点',
  quote: '报价',
  settlement: '结算',
  'backlog-penalty': '积压违约',
  cancellation: '撤单',
  recalculation: '重算',
  'price-change': '调价'
};

export const CONTRACT_OUTCOME_LABELS = {
  'on-time': '准时送达',
  late: '逾时送达',
  wrong: '误投',
  'wrong-late': '误投且逾时'
};

export function formatCredits(value, { signed = false } = {}) {
  const numericValue = Number(value);
  if (!Number.isFinite(numericValue)) return '0';
  const rounded = Math.round(numericValue * 10) / 10;
  return signed && rounded > 0 ? `+${rounded}` : `${rounded}`;
}

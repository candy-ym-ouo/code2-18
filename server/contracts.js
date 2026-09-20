import { GameRuleError } from './engine.js';

// 牌价分档组：应付款按紧急度（1/2/3）与违约情形计算。
export const RATE_GROUPS = ['base', 'late', 'wrongPenalty', 'backlogPenalty', 'cancelFee'];
export const URGENCY_LEVELS = [1, 2, 3];

export const LEDGER_TYPES = new Set([
  'opening',
  'quote',
  'settlement',
  'backlog-penalty',
  'cancellation',
  'recalculation',
  'price-change'
]);

export const CONTRACT_OUTCOMES = ['on-time', 'late', 'wrong', 'wrong-late'];

// 初始牌价：与既有经济数值完全一致（准时 6/12/18、逾时 3/2/1、误投赔付 2/4/6、积压 1/2/3）。
export const DEFAULT_PRICE_RATES = {
  base: { 1: 6, 2: 12, 3: 18 },
  late: { 1: 3, 2: 2, 3: 1 },
  wrongPenalty: { 1: 2, 2: 4, 3: 6 },
  backlogPenalty: { 1: 1, 2: 2, 3: 3 },
  cancelFee: { 1: 2, 2: 4, 3: 6 }
};

function round(value, precision = 1) {
  const scale = 10 ** precision;
  return Math.round(value * scale) / scale;
}

export function createInitialPriceTable() {
  return {
    version: 1,
    effectiveDay: 1,
    note: '初始牌价',
    rates: structuredClone(DEFAULT_PRICE_RATES)
  };
}

export function currentPriceTable(state) {
  return state.priceTables[state.priceTables.length - 1];
}

export function snapshotRates(rates, urgency) {
  return {
    base: rates.base[urgency],
    late: rates.late[urgency],
    wrongPenalty: rates.wrongPenalty[urgency],
    backlogPenalty: rates.backlogPenalty[urgency],
    cancelFee: rates.cancelFee[urgency]
  };
}

// 应付款核心规则：按违约情形从合约锁定的牌价中取数。
export function payableForOutcome(rates, outcome) {
  if (outcome === 'on-time') return rates.base;
  if (outcome === 'late') return rates.late;
  return -rates.wrongPenalty;
}

export function findContractByLetter(state, letterId) {
  return state.contracts.find((contract) => contract.letterId === letterId);
}

export function getContract(state, contractId) {
  return state.contracts.find((contract) => contract.id === contractId);
}

export function ratesForLetter(state, letter) {
  const contract = findContractByLetter(state, letter.id);
  if (contract) return contract.rates;
  return snapshotRates(currentPriceTable(state).rates, letter.urgency);
}

// 账本只追加不修改：每条记录结算后的余额，形成可逐条核对的链条。
// 金额触及 0 余额下限时按实际入账金额记录，并把请求金额留在 requestedAmount 中备查。
export function postLedgerEntry(state, { type, contractId = null, letterId = null, amount = 0, note, meta }) {
  const requestedAmount = round(amount, 1);
  const balanceAfter = Math.max(0, round(state.credits + requestedAmount, 1));
  const appliedAmount = round(balanceAfter - state.credits, 1);
  state.credits = balanceAfter;

  const entry = {
    id: state.ledgerSeq + 1,
    day: state.day,
    type,
    contractId,
    letterId,
    amount: appliedAmount,
    balanceAfter,
    note
  };
  if (appliedAmount !== requestedAmount) entry.requestedAmount = requestedAmount;
  if (meta && Object.keys(meta).length > 0) entry.meta = meta;

  state.ledgerSeq = entry.id;
  state.ledger.push(entry);
  return entry;
}

// 与 postLedgerEntry 相同的逐条兜底顺序，供预览算出与结算一致的邮资变化。
export function foldCreditBalance(startBalance, amounts) {
  let balance = startBalance;
  for (const amount of amounts) {
    balance = Math.max(0, round(balance + amount, 1));
  }
  return balance;
}

// 邮件生成时创建合约，并快照锁定当前版牌价；之后的调价只影响新合约。
export function ensureContractForLetter(state, letter) {
  const existing = findContractByLetter(state, letter.id);
  if (existing) return existing;

  const table = currentPriceTable(state);
  const rates = snapshotRates(table.rates, letter.urgency);
  const contract = {
    id: `C${String(letter.id).slice(1)}`,
    letterId: letter.id,
    day: letter.day,
    urgency: letter.urgency,
    priceVersion: table.version,
    rates,
    quotedAmount: rates.base,
    status: 'open',
    outcome: null,
    settledDay: null,
    settledAmount: null,
    cancelledDay: null
  };
  state.contracts.push(contract);
  postLedgerEntry(state, {
    type: 'quote',
    contractId: contract.id,
    letterId: letter.id,
    amount: 0,
    note: `按第 ${table.version} 版牌价报价 ${rates.base} 枚`,
    meta: { quotedAmount: rates.base, priceVersion: table.version }
  });
  return contract;
}

export function settleContractForLetter(state, letter, outcome) {
  const contract = findContractByLetter(state, letter.id);
  if (!contract) {
    throw new GameRuleError(`邮件 ${letter.id} 没有对应的委托合约。`);
  }
  if (contract.status !== 'open') {
    throw new GameRuleError(`合约 ${contract.id} 不在履约中，不能结算。`);
  }

  const amount = payableForOutcome(contract.rates, outcome);
  contract.status = 'settled';
  contract.outcome = outcome;
  contract.settledDay = state.day;
  contract.settledAmount = amount;

  const label = outcome === 'on-time' ? '准时送达' : outcome === 'late' ? '逾时送达' : '误投';
  return postLedgerEntry(state, {
    type: 'settlement',
    contractId: contract.id,
    letterId: letter.id,
    amount,
    note: `${label}，按第 ${contract.priceVersion} 版牌价结算`,
    meta: { outcome, priceVersion: contract.priceVersion }
  });
}

export function postBacklogPenalty(state, letter) {
  const contract = findContractByLetter(state, letter.id);
  if (!contract || contract.status !== 'open') return null;
  return postLedgerEntry(state, {
    type: 'backlog-penalty',
    contractId: contract.id,
    letterId: letter.id,
    amount: -contract.rates.backlogPenalty,
    note: `第 ${state.day} 日未出港，计积压违约金`,
    meta: { priceVersion: contract.priceVersion }
  });
}

export function cancelContract(state, contractId) {
  const contract = getContract(state, contractId);
  if (!contract) {
    throw new GameRuleError(`找不到合约 ${contractId}。`, [], 404);
  }
  if (contract.status !== 'open') {
    const label = contract.status === 'settled' ? '已结算' : '已撤单';
    throw new GameRuleError(`合约 ${contract.id} ${label}，不能撤单。`);
  }

  const letter = state.letters.find((item) => item.id === contract.letterId);
  if (letter && (letter.status === 'inbox' || letter.status === 'backlog')) {
    letter.status = 'cancelled';
  }
  contract.status = 'cancelled';
  contract.cancelledDay = state.day;

  const entry = postLedgerEntry(state, {
    type: 'cancellation',
    contractId: contract.id,
    letterId: contract.letterId,
    amount: -contract.rates.cancelFee,
    note: `撤单手续费，按第 ${contract.priceVersion} 版牌价计`,
    meta: { priceVersion: contract.priceVersion }
  });
  return { contract, entry };
}

// 重算只依据合约锁定的牌价（价格调整不影响已锁定合约），差额入账并保留原结算记录。
export function recalculateContract(state, contractId, { outcome } = {}) {
  const contract = getContract(state, contractId);
  if (!contract) {
    throw new GameRuleError(`找不到合约 ${contractId}。`, [], 404);
  }
  if (contract.status !== 'settled') {
    throw new GameRuleError(`合约 ${contract.id} 尚未结算，不能重算应付款。`);
  }

  const ratedOutcome = outcome === undefined || outcome === null ? contract.outcome : outcome;
  if (!CONTRACT_OUTCOMES.includes(ratedOutcome)) {
    throw new GameRuleError(`重算情形 ${ratedOutcome} 无效。`);
  }

  const previousAmount = contract.settledAmount;
  const previousOutcome = contract.outcome;
  const nextAmount = payableForOutcome(contract.rates, ratedOutcome);
  const delta = round(nextAmount - previousAmount, 1);

  contract.outcome = ratedOutcome;
  contract.settledAmount = nextAmount;

  const entry = postLedgerEntry(state, {
    type: 'recalculation',
    contractId: contract.id,
    letterId: contract.letterId,
    amount: delta,
    note: delta === 0 ? '重算应付款，无差额' : `重算应付款：${previousAmount} → ${nextAmount} 枚`,
    meta: {
      previousAmount,
      newAmount: nextAmount,
      previousOutcome,
      outcome: ratedOutcome,
      priceVersion: contract.priceVersion
    }
  });
  return { contract, entry };
}

export function normalizeRateGroups(input, { partial = false } = {}) {
  if (input === undefined || input === null) return {};
  if (typeof input !== 'object' || Array.isArray(input)) {
    throw new GameRuleError('牌价必须是按分档组组织的对象。');
  }

  const result = {};
  for (const group of RATE_GROUPS) {
    const value = input[group];
    if (value === undefined || value === null) {
      if (!partial) throw new GameRuleError(`牌价缺少 ${group} 分档组。`);
      continue;
    }
    if (typeof value !== 'object' || Array.isArray(value)) {
      throw new GameRuleError(`牌价 ${group} 必须是按紧急度分档的对象。`);
    }

    const groupRates = {};
    for (const urgency of URGENCY_LEVELS) {
      const raw = value[urgency];
      if (raw === undefined || raw === null) {
        if (!partial) throw new GameRuleError(`牌价 ${group} 缺少紧急度 ${urgency} 档位。`);
        continue;
      }
      const numeric = Number(raw);
      if (!Number.isFinite(numeric) || numeric < 0 || numeric > 999) {
        throw new GameRuleError(`牌价 ${group} 紧急度 ${urgency} 必须是 0-999 之间的数字。`);
      }
      groupRates[urgency] = round(numeric, 1);
    }
    if (Object.keys(groupRates).length > 0) result[group] = groupRates;
  }
  return result;
}

// 调价生成新版牌价，只影响之后创建的合约；已锁定合约仍按各自快照结算。
export function adjustPriceTable(state, partialRates = {}, note) {
  const current = currentPriceTable(state);
  const patch = normalizeRateGroups(partialRates, { partial: true });
  if (Object.keys(patch).length === 0) {
    throw new GameRuleError('调价至少要提供一个分档。');
  }

  const merged = {};
  for (const group of RATE_GROUPS) {
    merged[group] = { ...current.rates[group], ...(patch[group] || {}) };
  }

  const table = {
    version: current.version + 1,
    effectiveDay: state.day,
    note: typeof note === 'string' && note.trim() ? note.trim().slice(0, 80) : '人工调价',
    rates: merged
  };
  state.priceTables.push(table);

  const entry = postLedgerEntry(state, {
    type: 'price-change',
    amount: 0,
    note: `牌价调整至第 ${table.version} 版，仅影响新合约`,
    meta: { fromVersion: current.version, toVersion: table.version, rates: merged }
  });
  return { table, entry };
}

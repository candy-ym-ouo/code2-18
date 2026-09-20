export const CONTRACT_MODULE_VERSION = 1;

export const URGENCY_LABELS = {
  1: '普通',
  2: '加急',
  3: '特急'
};

export const CONTRACT_OUTCOMES = ['on-time', 'late', 'wrong', 'wrong-late', 'undelivered'];

export const CONTRACT_OUTCOME_LABELS = {
  'on-time': '准时送达',
  late: '逾时送达',
  wrong: '误投',
  'wrong-late': '误投且逾时',
  undelivered: '未送达'
};

export const CUTOFF_STAGES = ['before-cutoff', 'after-cutoff'];

export const CUTOFF_STAGE_LABELS = {
  'before-cutoff': '出港前取消',
  'after-cutoff': '出港后取消'
};

// 费率卡：价格调整只会写入这里，之后签订的新合约才拿到新费率；
// 已签订的合约把费率快照在自己身上，结算与重算都以快照为准。
export const DEFAULT_RATE_TIERS = {
  1: {
    baseFee: 6,
    perWeight: 1.2,
    latePenalty: 1,
    wrongPenalty: 8,
    cancelBeforeCutoff: 0.2,
    cancelAfterCutoff: 0.5
  },
  2: {
    baseFee: 10,
    perWeight: 1.8,
    latePenalty: 3,
    wrongPenalty: 14,
    cancelBeforeCutoff: 0.25,
    cancelAfterCutoff: 0.55
  },
  3: {
    baseFee: 18,
    perWeight: 2.6,
    latePenalty: 6,
    wrongPenalty: 24,
    cancelBeforeCutoff: 0.3,
    cancelAfterCutoff: 0.6
  }
};

const RATE_FIELDS = [
  'baseFee',
  'perWeight',
  'latePenalty',
  'wrongPenalty',
  'cancelBeforeCutoff',
  'cancelAfterCutoff'
];

const MAX_TITLE_LENGTH = 40;
const MAX_REASON_LENGTH = 200;
const MAX_WEIGHT = 50;

export class ContractRuleError extends Error {
  constructor(message, issues = [], statusCode = 400) {
    super(message);
    this.name = 'ContractRuleError';
    this.issues = issues;
    this.statusCode = statusCode;
  }
}

function roundMoney(value) {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

function cloneTier(tier) {
  return {
    baseFee: tier.baseFee,
    perWeight: tier.perWeight,
    latePenalty: tier.latePenalty,
    wrongPenalty: tier.wrongPenalty,
    cancelBeforeCutoff: tier.cancelBeforeCutoff,
    cancelAfterCutoff: tier.cancelAfterCutoff
  };
}

export function createInitialContracts() {
  return {
    moduleVersion: CONTRACT_MODULE_VERSION,
    rateCard: {
      version: 1,
      updatedAt: null,
      tiers: {
        1: cloneTier(DEFAULT_RATE_TIERS[1]),
        2: cloneTier(DEFAULT_RATE_TIERS[2]),
        3: cloneTier(DEFAULT_RATE_TIERS[3])
      }
    },
    contracts: [],
    ledger: [],
    ledgerBalance: 0,
    nextContractSeq: 1,
    nextEventSeq: 1
  };
}

function requireContractsSlice(slice) {
  if (!slice || typeof slice !== 'object') {
    throw new ContractRuleError('邮资委托合约模块尚未初始化。');
  }
  return slice;
}

function appendLedger(slice, entry) {
  const seq = slice.nextEventSeq;
  const event = {
    id: `EV-${String(seq).padStart(4, '0')}`,
    seq,
    at: new Date().toISOString(),
    ...entry
  };
  slice.ledger.push(event);
  slice.nextEventSeq = seq + 1;
  return event;
}

function findContract(slice, contractId) {
  return slice.contracts.find((contract) => contract.id === contractId) || null;
}

function getContractOrThrow(slice, contractId) {
  const contract = findContract(slice, contractId);
  if (!contract) {
    throw new ContractRuleError(`找不到邮资委托合约 ${contractId || '(空)'}。`, [], 404);
  }
  return contract;
}

export function getActiveContractByLetter(slice, letterId) {
  if (!slice || !letterId) return null;
  return slice.contracts.find((contract) => contract.letterId === letterId && contract.status === 'active') || null;
}

export function calculateBaseFee(rates, weight) {
  return roundMoney(rates.baseFee + rates.perWeight * weight);
}

// 应付款以邮政署收款方向记账：正数表示委托方应支付，负数表示邮政署赔付。
export function calculateOutcomePayable(rates, weight, outcome) {
  const base = calculateBaseFee(rates, weight);
  const adjustments = [];

  if (outcome === 'on-time') {
    return { outcome, base, payable: base, adjustments };
  }

  if (outcome === 'late') {
    const discount = Math.min(rates.latePenalty, base);
    adjustments.push({ code: 'LATE_DISCOUNT', label: '逾时减费', amount: roundMoney(-discount) });
    return { outcome, base, payable: roundMoney(base - discount), adjustments };
  }

  if (outcome === 'wrong') {
    adjustments.push({ code: 'WRONG_COMPENSATION', label: '误投赔付', amount: roundMoney(-rates.wrongPenalty) });
    return { outcome, base, payable: roundMoney(base - rates.wrongPenalty), adjustments };
  }

  if (outcome === 'wrong-late') {
    adjustments.push({ code: 'WRONG_COMPENSATION', label: '误投赔付', amount: roundMoney(-rates.wrongPenalty) });
    adjustments.push({ code: 'LATE_COMPENSATION', label: '逾时赔付', amount: roundMoney(-rates.latePenalty) });
    return {
      outcome,
      base,
      payable: roundMoney(base - rates.wrongPenalty - rates.latePenalty),
      adjustments
    };
  }

  if (outcome === 'undelivered') {
    adjustments.push({ code: 'UNDELIVERED_COMPENSATION', label: '未送达赔付', amount: roundMoney(-rates.latePenalty) });
    return { outcome, base, payable: roundMoney(-rates.latePenalty), adjustments };
  }

  throw new ContractRuleError(`未知的履约结果 ${outcome}。`);
}

export function calculateCancellationPayable(rates, weight, stage) {
  const base = calculateBaseFee(rates, weight);
  if (!CUTOFF_STAGES.includes(stage)) {
    throw new ContractRuleError('取消阶段必须是 before-cutoff 或 after-cutoff。');
  }
  const factor = stage === 'before-cutoff' ? rates.cancelBeforeCutoff : rates.cancelAfterCutoff;
  const payable = roundMoney(base * factor);
  return {
    stage,
    base,
    factor,
    payable,
    adjustments: [{
      code: 'CANCELLATION_FEE',
      label: stage === 'before-cutoff' ? '出港前取消费' : '出港后取消费',
      amount: payable
    }]
  };
}

export function quoteContract(slice, { urgency, weight } = {}) {
  requireContractsSlice(slice);
  if (!Number.isInteger(urgency) || !DEFAULT_RATE_TIERS[urgency]) {
    throw new ContractRuleError('紧急度必须是 1（普通）、2（加急）或 3（特急）。');
  }
  if (!Number.isFinite(weight) || weight <= 0 || weight > MAX_WEIGHT) {
    throw new ContractRuleError(`邮件重量必须是 0 到 ${MAX_WEIGHT} kg 之间的数字。`);
  }
  const rates = cloneTier(slice.rateCard.tiers[urgency]);
  const base = calculateBaseFee(rates, weight);
  return {
    urgency,
    weight: Math.round(weight * 10) / 10,
    rateVersion: slice.rateCard.version,
    rates,
    expectedPayable: base
  };
}

function resolveContractInput(slice, gameState, input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new ContractRuleError('合约参数必须是 JSON 对象。');
  }

  if (input.letterId) {
    const letter = gameState?.letters?.find((item) => item.id === input.letterId);
    if (!letter) {
      throw new ContractRuleError(`找不到邮件 ${input.letterId}，无法签订委托合约。`, [], 404);
    }
    if (letter.status !== 'inbox' && letter.status !== 'backlog') {
      throw new ContractRuleError(`${letter.id} 已不在待投递队列，不能再签订委托合约。`);
    }
    if (getActiveContractByLetter(slice, letter.id)) {
      throw new ContractRuleError(`${letter.id} 已存在履约中的委托合约。`, [{
        code: 'CONTRACT_ALREADY_ACTIVE',
        letterId: letter.id
      }], 409);
    }
    return {
      letterId: letter.id,
      title: `${letter.id} ${letter.subject}`,
      originIslandId: letter.originIslandId,
      recipientIslandId: letter.recipientIslandId,
      urgency: letter.urgency,
      weight: letter.weight
    };
  }

  const title = typeof input.title === 'string' ? input.title.trim() : '';
  if (title.length === 0 || title.length > MAX_TITLE_LENGTH) {
    throw new ContractRuleError(`自定义委托必须提供 1 到 ${MAX_TITLE_LENGTH} 个字的标题。`);
  }
  if (!Number.isInteger(input.urgency) || !DEFAULT_RATE_TIERS[input.urgency]) {
    throw new ContractRuleError('紧急度必须是 1（普通）、2（加急）或 3（特急）。');
  }
  if (!Number.isFinite(input.weight) || input.weight <= 0 || input.weight > MAX_WEIGHT) {
    throw new ContractRuleError(`邮件重量必须是 0 到 ${MAX_WEIGHT} kg 之间的数字。`);
  }
  return {
    letterId: null,
    title,
    originIslandId: typeof input.originIslandId === 'string' ? input.originIslandId : null,
    recipientIslandId: typeof input.recipientIslandId === 'string' ? input.recipientIslandId : null,
    urgency: input.urgency,
    weight: Math.round(input.weight * 10) / 10
  };
}

export function createContract(slice, gameState, input, { day } = {}) {
  requireContractsSlice(slice);
  if (!Number.isInteger(day) || day < 1) {
    throw new ContractRuleError('签订合约时必须提供有效的游戏日。');
  }
  const resolved = resolveContractInput(slice, gameState, input);
  const quote = quoteContract(slice, resolved);
  const contractId = `C-${String(slice.nextContractSeq).padStart(4, '0')}`;
  slice.nextContractSeq += 1;

  const contract = {
    id: contractId,
    letterId: resolved.letterId,
    title: resolved.title,
    originIslandId: resolved.originIslandId,
    recipientIslandId: resolved.recipientIslandId,
    urgency: resolved.urgency,
    weight: resolved.weight,
    status: 'active',
    createdAtDay: day,
    settledAtDay: null,
    outcome: null,
    expectedPayable: quote.expectedPayable,
    amount: quote.expectedPayable,
    adjustments: [],
    rateSnapshot: {
      version: quote.rateVersion,
      rates: quote.rates
    },
    history: [{
      type: 'created',
      day,
      at: new Date().toISOString(),
      amount: quote.expectedPayable,
      reason: null
    }]
  };
  slice.contracts.push(contract);

  appendLedger(slice, {
    type: 'created',
    day,
    contractId,
    contractTitle: contract.title,
    letterId: contract.letterId,
    outcome: null,
    amount: 0,
    expectedAmount: quote.expectedPayable,
    delta: 0,
    reason: null,
    rateVersion: quote.rateVersion,
    breakdown: { base: quote.expectedPayable, adjustments: [] }
  });

  return structuredClone(contract);
}

function requireReason(reason, label) {
  const normalized = typeof reason === 'string' ? reason.trim() : '';
  if (normalized.length === 0) {
    throw new ContractRuleError(`${label}必须填写原因，以便保留对账轨迹。`);
  }
  if (normalized.length > MAX_REASON_LENGTH) {
    throw new ContractRuleError(`${label}原因不能超过 ${MAX_REASON_LENGTH} 个字。`);
  }
  return normalized;
}

function assertActive(contract) {
  if (contract.status !== 'active') {
    throw new ContractRuleError(`${contract.id} 当前状态为 ${contract.status}，不能再结算。`, [{
      code: 'CONTRACT_NOT_ACTIVE',
      contractId: contract.id
    }], 409);
  }
}

export function settleContract(slice, contractId, { outcome, day, reason } = {}) {
  requireContractsSlice(slice);
  if (!Number.isInteger(day) || day < 1) {
    throw new ContractRuleError('结算合约时必须提供有效的游戏日。');
  }
  if (!CONTRACT_OUTCOMES.includes(outcome)) {
    throw new ContractRuleError(`履约结果必须是 ${CONTRACT_OUTCOMES.join('、')} 之一。`);
  }
  const contract = getContractOrThrow(slice, contractId);
  assertActive(contract);

  const fees = calculateOutcomePayable(contract.rateSnapshot.rates, contract.weight, outcome);
  contract.status = 'settled';
  contract.settledAtDay = day;
  contract.outcome = outcome;
  contract.amount = fees.payable;
  contract.adjustments = fees.adjustments;
  contract.history.push({
    type: 'settled',
    day,
    at: new Date().toISOString(),
    outcome,
    amount: fees.payable,
    reason: typeof reason === 'string' && reason.trim() ? reason.trim() : null
  });

  slice.ledgerBalance = roundMoney(slice.ledgerBalance + fees.payable);
  const event = appendLedger(slice, {
    type: 'settled',
    day,
    contractId,
    contractTitle: contract.title,
    letterId: contract.letterId,
    outcome,
    amount: fees.payable,
    previousAmount: null,
    delta: fees.payable,
    reason: contract.history.at(-1).reason,
    rateVersion: contract.rateSnapshot.version,
    breakdown: fees
  });

  return { contract: structuredClone(contract), event: structuredClone(event) };
}

export function recalculateContract(slice, contractId, { outcome, day, reason } = {}) {
  requireContractsSlice(slice);
  if (!Number.isInteger(day) || day < 1) {
    throw new ContractRuleError('重算合约时必须提供有效的游戏日。');
  }
  if (!CONTRACT_OUTCOMES.includes(outcome)) {
    throw new ContractRuleError(`履约结果必须是 ${CONTRACT_OUTCOMES.join('、')} 之一。`);
  }
  const normalizedReason = requireReason(reason, '重算');
  const contract = getContractOrThrow(slice, contractId);
  if (contract.status !== 'settled' && contract.status !== 'recalculated') {
    throw new ContractRuleError(`${contract.id} 尚未结算或已取消，不能重算。`, [{
      code: 'CONTRACT_NOT_RECALCULABLE',
      contractId: contract.id
    }], 409);
  }

  const fees = calculateOutcomePayable(contract.rateSnapshot.rates, contract.weight, outcome);
  const previousAmount = contract.amount;
  const delta = roundMoney(fees.payable - previousAmount);

  contract.status = 'recalculated';
  contract.settledAtDay = day;
  contract.outcome = outcome;
  contract.amount = fees.payable;
  contract.adjustments = fees.adjustments;
  contract.history.push({
    type: 'recalculated',
    day,
    at: new Date().toISOString(),
    outcome,
    previousAmount,
    amount: fees.payable,
    delta,
    reason: normalizedReason
  });

  slice.ledgerBalance = roundMoney(slice.ledgerBalance + delta);
  const event = appendLedger(slice, {
    type: 'recalculated',
    day,
    contractId,
    contractTitle: contract.title,
    letterId: contract.letterId,
    outcome,
    amount: fees.payable,
    previousAmount,
    delta,
    reason: normalizedReason,
    rateVersion: contract.rateSnapshot.version,
    breakdown: fees
  });

  return { contract: structuredClone(contract), event: structuredClone(event) };
}

export function cancelContract(slice, contractId, { stage, day, reason } = {}) {
  requireContractsSlice(slice);
  if (!Number.isInteger(day) || day < 1) {
    throw new ContractRuleError('取消合约时必须提供有效的游戏日。');
  }
  if (!CUTOFF_STAGES.includes(stage)) {
    throw new ContractRuleError('取消阶段必须是 before-cutoff（出港前）或 after-cutoff（出港后）。');
  }
  const normalizedReason = requireReason(reason, '取消');
  const contract = getContractOrThrow(slice, contractId);
  assertActive(contract);

  const fees = calculateCancellationPayable(contract.rateSnapshot.rates, contract.weight, stage);
  contract.status = 'cancelled';
  contract.settledAtDay = day;
  contract.outcome = null;
  contract.amount = fees.payable;
  contract.adjustments = fees.adjustments;
  contract.history.push({
    type: 'cancelled',
    day,
    at: new Date().toISOString(),
    stage,
    amount: fees.payable,
    reason: normalizedReason
  });

  slice.ledgerBalance = roundMoney(slice.ledgerBalance + fees.payable);
  const event = appendLedger(slice, {
    type: 'cancelled',
    day,
    contractId,
    contractTitle: contract.title,
    letterId: contract.letterId,
    outcome: null,
    stage,
    amount: fees.payable,
    previousAmount: null,
    delta: fees.payable,
    reason: normalizedReason,
    rateVersion: contract.rateSnapshot.version,
    breakdown: fees
  });

  return { contract: structuredClone(contract), event: structuredClone(event) };
}

// 每日调度结算后由引擎调用：当天实际出港的信件按真实结果自动结算对应合约。
// 未出港信件的合约保持 active，等后续投递或人工处理。
export function autoSettleContracts(slice, { day, outcomesByLetter } = {}) {
  requireContractsSlice(slice);
  const outcomes = outcomesByLetter instanceof Map
    ? outcomesByLetter
    : new Map(Object.entries(outcomesByLetter || {}));
  const events = [];

  for (const contract of slice.contracts) {
    if (contract.status !== 'active' || !contract.letterId) continue;
    const outcome = outcomes.get(contract.letterId);
    if (!CONTRACT_OUTCOMES.includes(outcome)) continue;
    const result = settleContract(slice, contract.id, {
      outcome,
      day,
      reason: `第 ${day} 日调度自动结算`
    });
    events.push(result.event);
  }

  return structuredClone(events);
}

// 调度预览时模拟将要发生的委托金收付，不落账。
export function previewContractSettlements(slice, outcomesByLetter) {
  if (!slice) return { settlements: [], payableDelta: 0 };
  const outcomes = outcomesByLetter instanceof Map
    ? outcomesByLetter
    : new Map(Object.entries(outcomesByLetter || {}));
  const settlements = [];

  for (const contract of slice.contracts) {
    if (contract.status !== 'active' || !contract.letterId) continue;
    const outcome = outcomes.get(contract.letterId);
    if (!CONTRACT_OUTCOMES.includes(outcome)) continue;
    const fees = calculateOutcomePayable(contract.rateSnapshot.rates, contract.weight, outcome);
    settlements.push({
      contractId: contract.id,
      letterId: contract.letterId,
      title: contract.title,
      outcome,
      base: fees.base,
      payable: fees.payable,
      adjustments: fees.adjustments
    });
  }

  return {
    settlements,
    payableDelta: roundMoney(settlements.reduce((sum, item) => sum + item.payable, 0))
  };
}

function assertRateField(urgency, field, value) {
  if (!Number.isFinite(value)) {
    throw new ContractRuleError(`紧急度 ${urgency} 的 ${field} 必须是数字。`);
  }
  if (field.startsWith('cancel')) {
    if (value < 0 || value > 1) {
      throw new ContractRuleError(`紧急度 ${urgency} 的 ${field} 必须是 0 到 1 之间的比例。`);
    }
  } else if (field === 'baseFee') {
    if (value <= 0 || value > 1000) {
      throw new ContractRuleError(`紧急度 ${urgency} 的 ${field} 必须是 0 到 1000 之间的正数。`);
    }
  } else if (value < 0 || value > 1000) {
    throw new ContractRuleError(`紧急度 ${urgency} 的 ${field} 必须是 0 到 1000 之间的非负数。`);
  }
}

// 价格调整只改费率卡并留下调整记录；不触碰任何已签订合约的快照。
export function adjustRateCard(slice, tiersInput = {}, { day } = {}) {
  requireContractsSlice(slice);
  if (!Number.isInteger(day) || day < 1) {
    throw new ContractRuleError('调整费率时必须提供有效的游戏日。');
  }
  if (!tiersInput || typeof tiersInput !== 'object' || Array.isArray(tiersInput)) {
    throw new ContractRuleError('费率调整必须按紧急度提供 tiers 对象。');
  }

  const changes = [];
  for (const urgencyKey of ['1', '2', '3']) {
    const patch = tiersInput[urgencyKey] ?? tiersInput[Number(urgencyKey)];
    if (patch === undefined) continue;
    if (!patch || typeof patch !== 'object' || Array.isArray(patch)) {
      throw new ContractRuleError(`紧急度 ${urgencyKey} 的费率必须是对象。`);
    }
    const urgency = Number(urgencyKey);
    const tier = slice.rateCard.tiers[urgency];
    for (const field of RATE_FIELDS) {
      if (!Object.prototype.hasOwnProperty.call(patch, field)) continue;
      assertRateField(urgency, field, patch[field]);
      const previous = tier[field];
      const next = roundMoney(patch[field]);
      if (next !== previous) {
        changes.push({ urgency, field, from: previous, to: next });
        tier[field] = next;
      }
    }
  }

  if (changes.length === 0) {
    throw new ContractRuleError('没有需要调整的费率字段，或新费率与当前费率完全相同。');
  }

  const fromVersion = slice.rateCard.version;
  slice.rateCard.version = fromVersion + 1;
  slice.rateCard.updatedAt = new Date().toISOString();

  const event = appendLedger(slice, {
    type: 'rate-adjust',
    day,
    contractId: null,
    contractTitle: null,
    letterId: null,
    outcome: null,
    amount: 0,
    previousAmount: null,
    delta: 0,
    reason: null,
    rateVersion: slice.rateCard.version,
    rateChanges: changes,
    fromVersion,
    toVersion: slice.rateCard.version,
    breakdown: null
  });

  return {
    rateCard: structuredClone(slice.rateCard),
    changes: structuredClone(changes),
    event: structuredClone(event)
  };
}

export function contractSummary(slice) {
  requireContractsSlice(slice);
  const active = slice.contracts.filter((contract) => contract.status === 'active');
  return {
    balance: slice.ledgerBalance,
    activeCount: active.length,
    settledCount: slice.contracts.filter((contract) => contract.status === 'settled' || contract.status === 'recalculated').length,
    cancelledCount: slice.contracts.filter((contract) => contract.status === 'cancelled').length,
    expectedActive: roundMoney(active.reduce((sum, contract) => sum + contract.expectedPayable, 0)),
    rateVersion: slice.rateCard.version,
    ledgerEntries: slice.ledger.length
  };
}

function isFiniteNumber(value) {
  return typeof value === 'number' && Number.isFinite(value);
}

// 存档加载时的结构校验：台账是只追加的对账轨迹，缺字段就视为损坏存档。
export function hasValidContractsShape(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  if (value.moduleVersion !== CONTRACT_MODULE_VERSION) return false;
  if (!isFiniteNumber(value.ledgerBalance) || !Number.isInteger(value.nextContractSeq) || !Number.isInteger(value.nextEventSeq)) return false;
  if (value.nextContractSeq < 1 || value.nextEventSeq < 1) return false;
  if (!Array.isArray(value.contracts) || !Array.isArray(value.ledger)) return false;
  const rateCard = value.rateCard;
  if (!rateCard || typeof rateCard !== 'object' || !Number.isInteger(rateCard.version) || rateCard.version < 1) return false;
  for (const urgency of [1, 2, 3]) {
    const tier = rateCard.tiers?.[urgency];
    if (!tier) return false;
    for (const field of RATE_FIELDS) {
      if (!isFiniteNumber(tier[field]) || tier[field] < 0) return false;
    }
  }

  const contractIds = new Set();
  for (const contract of value.contracts) {
    if (!contract || typeof contract !== 'object') return false;
    if (typeof contract.id !== 'string' || contractIds.has(contract.id)) return false;
    contractIds.add(contract.id);
    if (typeof contract.title !== 'string' || !Number.isInteger(contract.urgency) || contract.urgency < 1 || contract.urgency > 3) return false;
    if (!isFiniteNumber(contract.weight) || contract.weight <= 0) return false;
    if (!['active', 'settled', 'recalculated', 'cancelled'].includes(contract.status)) return false;
    if (!Number.isInteger(contract.createdAtDay) || !isFiniteNumber(contract.amount) || !isFiniteNumber(contract.expectedPayable)) return false;
    if (!contract.rateSnapshot || !Number.isInteger(contract.rateSnapshot.version) || !contract.rateSnapshot.rates) return false;
    if (!Array.isArray(contract.history) || contract.history.length === 0) return false;
    if (contract.letterId !== null && typeof contract.letterId !== 'string') return false;
  }

  let computedBalance = 0;
  const eventSeqs = new Set();
  for (const event of value.ledger) {
    if (!event || typeof event !== 'object') return false;
    if (typeof event.id !== 'string' || !Number.isInteger(event.seq) || eventSeqs.has(event.seq)) return false;
    eventSeqs.add(event.seq);
    if (!['created', 'settled', 'recalculated', 'cancelled', 'rate-adjust'].includes(event.type)) return false;
    if (!isFiniteNumber(event.amount) || !isFiniteNumber(event.delta)) return false;
    computedBalance += event.delta;
  }
  if (Math.abs(roundMoney(computedBalance) - value.ledgerBalance) > 0.011) return false;
  return true;
}

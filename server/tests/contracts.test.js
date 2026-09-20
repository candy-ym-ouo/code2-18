import test from 'node:test';
import assert from 'node:assert/strict';
import {
  adjustRateCard,
  cancelContract,
  calculateOutcomePayable,
  createContract,
  createInitialContracts,
  DEFAULT_RATE_TIERS,
  getActiveContractByLetter,
  quoteContract,
  recalculateContract,
  settleContract
} from '../contracts.js';

function letterFixture(overrides = {}) {
  return {
    id: 'L01-01',
    subject: '测试邮件',
    originIslandId: 'sun',
    recipientIslandId: 'gale',
    urgency: 2,
    weight: 3,
    status: 'inbox',
    ...overrides
  };
}

test('应付款按紧急度与违约情形分别计算', () => {
  const onTime = calculateOutcomePayable(DEFAULT_RATE_TIERS[1], 2, 'on-time');
  assert.equal(onTime.payable, 8.4);

  const late = calculateOutcomePayable(DEFAULT_RATE_TIERS[1], 2, 'late');
  assert.equal(late.payable, Math.round((6 + 1.2 * 2 - 1) * 100) / 100);

  const wrong = calculateOutcomePayable(DEFAULT_RATE_TIERS[2], 3, 'wrong');
  assert.equal(wrong.payable, Math.round((15.4 - 14) * 100) / 100);

  const wrongLate = calculateOutcomePayable(DEFAULT_RATE_TIERS[3], 1, 'wrong-late');
  assert.equal(wrongLate.payable, Math.round((18 + 2.6 - 24 - 6) * 100) / 100);
  assert.equal(wrongLate.adjustments.length, 2);

  const undelivered = calculateOutcomePayable(DEFAULT_RATE_TIERS[3], 1, 'undelivered');
  assert.equal(undelivered.payable, -6);
});

test('取消费按出港前后两个违约情形按比例收取', () => {
  const before = cancelContract; // 引用以确认导出
  assert.equal(typeof before, 'function');

  const slice = createInitialContracts();
  const game = { letters: [letterFixture()] };
  const contract = createContract(slice, game, { letterId: 'L01-01' }, { day: 1 });
  const result = cancelContract(slice, contract.id, {
    stage: 'before-cutoff',
    day: 1,
    reason: '委托方临时撤单'
  });
  // 加急基础费 10 + 1.8*3 = 15.4，出港前比例 0.25
  assert.equal(result.contract.amount, 3.85);
});

test('价格调整只影响新单，已签合约保留旧费率快照', () => {
  const slice = createInitialContracts();
  const game = { letters: [letterFixture()] };
  const first = createContract(slice, game, { letterId: 'L01-01' }, { day: 1 });
  assert.equal(first.rateSnapshot.version, 1);
  assert.equal(first.expectedPayable, 15.4);

  const adjustment = adjustRateCard(slice, { 2: { baseFee: 30 } }, { day: 2 });
  assert.equal(adjustment.rateCard.version, 2);
  assert.equal(slice.rateCard.tiers[2].baseFee, 30);

  // 旧合约按快照结算，仍是原邮资
  const settled = settleContract(slice, first.id, { outcome: 'on-time', day: 3 });
  assert.equal(settled.contract.amount, 15.4);
  assert.equal(settled.event.rateVersion, 1);

  // 新合约拿到新费率
  const gameTwo = { letters: [letterFixture({ id: 'L02-01', status: 'inbox' })] };
  const second = createContract(slice, gameTwo, { letterId: 'L02-01' }, { day: 3 });
  assert.equal(second.rateSnapshot.version, 2);
  assert.equal(second.expectedPayable, 30 + 5.4);
});

test('取消与重算都会向只追加的对账轨迹写入轨迹', () => {
  const slice = createInitialContracts();
  const game = { letters: [letterFixture()] };
  const contract = createContract(slice, game, { letterId: 'L01-01' }, { day: 1 });
  settleContract(slice, contract.id, { outcome: 'on-time', day: 2, reason: '首结' });

  const recalculated = recalculateContract(slice, contract.id, {
    outcome: 'wrong-late',
    day: 4,
    reason: '收件岛申诉误投，凭签收记录改判'
  });
  const originalAmount = 15.4;
  const expectedAmount = -1.6;
  assert.equal(recalculated.contract.amount, expectedAmount);
  assert.equal(recalculated.event.previousAmount, originalAmount);
  assert.equal(recalculated.event.delta, -17);
  assert.equal(recalculated.contract.status, 'recalculated');

  const types = slice.ledger.map((event) => event.type);
  assert.deepEqual(types, ['created', 'settled', 'recalculated']);
  // 台账只追加：原始结算事件没有被覆盖
  assert.equal(slice.ledger[1].amount, originalAmount);
  // 合约自身 history 也完整保留
  assert.deepEqual(
    recalculated.contract.history.map((item) => item.type),
    ['created', 'settled', 'recalculated']
  );
  // 余额等于全部 delta 之和
  const balance = slice.ledger.reduce((sum, event) => sum + event.delta, 0);
  assert.ok(Math.abs(balance - slice.ledgerBalance) < 1e-9);
});

test('一封待投递邮件最多只能有一份履约中的合约', () => {
  const slice = createInitialContracts();
  const game = { letters: [letterFixture()] };
  createContract(slice, game, { letterId: 'L01-01' }, { day: 1 });
  assert.throws(
    () => createContract(slice, game, { letterId: 'L01-01' }, { day: 1 }),
    /已存在履约中的委托合约/
  );
});

test('结算或取消后合约离开履约队列，旧邮件可以重新签约', () => {
  const slice = createInitialContracts();
  const game = { letters: [letterFixture()] };
  const contract = createContract(slice, game, { letterId: 'L01-01' }, { day: 1 });
  settleContract(slice, contract.id, { outcome: 'late', day: 1 });
  assert.equal(getActiveContractByLetter(slice, 'L01-01'), null);

  const second = createContract(slice, game, { letterId: 'L01-01' }, { day: 2 });
  assert.notEqual(second.id, contract.id);
});

test('重算与取消必须填写原因，防止无痕迹改账', () => {
  const slice = createInitialContracts();
  const game = { letters: [letterFixture()] };
  const contract = createContract(slice, game, { letterId: 'L01-01' }, { day: 1 });

  assert.throws(
    () => cancelContract(slice, contract.id, { stage: 'after-cutoff', day: 1 }),
    /取消必须填写原因/
  );

  settleContract(slice, contract.id, { outcome: 'on-time', day: 1 });
  assert.throws(
    () => recalculateContract(slice, contract.id, { outcome: 'late', day: 2 }),
    /重算必须填写原因/
  );
});

test('报价快照当前费率版本，调价事件写入台账但不改变余额', () => {
  const slice = createInitialContracts();
  const quote = quoteContract(slice, { urgency: 3, weight: 4.5 });
  assert.equal(quote.rateVersion, 1);
  assert.equal(quote.expectedPayable, Math.round((18 + 2.6 * 4.5) * 100) / 100);

  adjustRateCard(slice, { 1: { baseFee: 8 } }, { day: 1 });
  assert.equal(slice.ledgerBalance, 0);
  const rateEvent = slice.ledger.find((event) => event.type === 'rate-adjust');
  assert.equal(rateEvent.rateChanges[0].from, 6);
  assert.equal(rateEvent.rateChanges[0].to, 8);
});

test('无效费率调整会被拒绝', () => {
  const slice = createInitialContracts();
  assert.throws(() => adjustRateCard(slice, { 2: { baseFee: -5 } }, { day: 1 }), /必须是/);
  assert.throws(() => adjustRateCard(slice, { 1: { cancelAfterCutoff: 1.5 } }, { day: 1 }), /0 到 1/);
  assert.throws(() => adjustRateCard(slice, { 3: { baseFee: 18 } }, { day: 1 }), /没有需要调整/);
  assert.equal(slice.rateCard.version, 1);
});

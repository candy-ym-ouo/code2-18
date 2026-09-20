import test from 'node:test';
import assert from 'node:assert/strict';
import {
  advanceDay,
  createInitialState,
  previewPlan
} from '../engine.js';
import {
  autoSettleContracts,
  createContract,
  createInitialContracts
} from '../contracts.js';

function assignmentFor(letter, courierId = 'comet', targetIslandId = letter.recipientIslandId) {
  return { letterId: letter.id, courierId, targetIslandId, order: 0 };
}

test('新开局包含合约模块初始状态', () => {
  const state = createInitialState({ seed: 'contract-init' });
  assert.equal(state.contracts.rateCard.version, 1);
  assert.deepEqual(state.contracts.contracts, []);
  assert.deepEqual(state.contracts.ledger, []);
  assert.equal(state.contracts.ledgerBalance, 0);
});

test('每日结算自动按投递结果结清对应合约', () => {
  const state = createInitialState({ seed: 'contract-auto' });
  const letter = state.letters.find((item) => item.status === 'inbox');
  const contract = createContract(state.contracts, state, { letterId: letter.id }, { day: 1 });
  assert.equal(contract.status, 'active');

  const report = advanceDay(state, [assignmentFor(letter)]);
  const event = report.contractEvents.find((item) => item.contractId === contract.id);
  assert.ok(event);
  assert.equal(event.outcome, report.routes[0].letters[0].outcome);
  assert.equal(report.contractBalance, state.contracts.ledgerBalance);

  const stored = state.contracts.contracts.find((item) => item.id === contract.id);
  assert.equal(stored.status, 'settled');
  assert.equal(stored.outcome, report.routes[0].letters[0].outcome);
});

test('未出港信件的合约保持履约中，不会被自动结算', () => {
  const state = createInitialState({ seed: 'contract-pending' });
  const letter = state.letters.find((item) => item.status === 'inbox');
  const contract = createContract(state.contracts, state, { letterId: letter.id }, { day: 1 });

  advanceDay(state, []);
  const stored = state.contracts.contracts.find((item) => item.id === contract.id);
  assert.equal(stored.status, 'active');
  assert.equal(state.contracts.ledgerBalance, 0);

  // 次日该邮件已积压，仍可正常投递并自动结算
  const backlogLetter = state.letters.find((item) => item.id === letter.id);
  assert.equal(backlogLetter.status, 'backlog');
  const report = advanceDay(state, [assignmentFor(backlogLetter)]);
  assert.equal(report.contractEvents.length, 1);
  assert.equal(report.contractEvents[0].contractId, contract.id);
});

test('调度预览给出委托金收付预估但不落账', () => {
  const state = createInitialState({ seed: 'contract-preview' });
  const letter = state.letters.find((item) => item.status === 'inbox');
  createContract(state.contracts, state, { letterId: letter.id }, { day: 1 });

  const preview = previewPlan(state, [assignmentFor(letter)]);
  assert.equal(preview.contracts.settlements.length, 1);
  assert.ok(preview.warnings.some((warning) => warning.includes('委托合约')));
  // 预览不产生结算台账（签约事件保留）
  assert.equal(state.contracts.ledger.length, 1);
  assert.equal(state.contracts.contracts[0].status, 'active');
});

test('自动结算函数可独立处理信件结果映射', () => {
  const slice = createInitialContracts();
  const state = createInitialState({ seed: 'contract-manual-map' });
  const letter = state.letters[0];
  const contract = createContract(slice, state, { letterId: letter.id }, { day: 1 });
  const events = autoSettleContracts(slice, {
    day: 1,
    outcomesByLetter: new Map([[letter.id, 'wrong-late']])
  });
  assert.equal(events.length, 1);
  assert.equal(events[0].outcome, 'wrong-late');
  assert.ok(events[0].delta < 0);
  assert.equal(slice.contracts.find((item) => item.id === contract.id).status, 'settled');
});

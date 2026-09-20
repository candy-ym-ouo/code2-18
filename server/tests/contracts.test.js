import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  advanceDay,
  createInitialState,
  previewPlan
} from '../engine.js';
import {
  DEFAULT_PRICE_RATES,
  adjustPriceTable,
  cancelContract,
  currentPriceTable,
  findContractByLetter,
  payableForOutcome,
  recalculateContract,
  snapshotRates
} from '../contracts.js';
import { createApp } from '../app.js';
import { GameStore } from '../store.js';

function assignmentFor(state, letter, courierId = 'comet', targetIslandId = letter.recipientIslandId) {
  return { letterId: letter.id, courierId, targetIslandId, order: 0 };
}

function wrongTargetFor(state, letter) {
  return state.islands.find((island) => (
    island.id !== 'skyport' &&
    island.id !== letter.recipientIslandId &&
    island.id !== letter.originIslandId
  ));
}

function assertLedgerChain(state) {
  assert.ok(state.ledger.length > 0, '账本不应为空');
  let balance = state.ledger[0].balanceAfter - state.ledger[0].amount;
  for (const entry of state.ledger) {
    balance = Math.max(0, Math.round((balance + entry.amount) * 10) / 10);
    assert.equal(entry.balanceAfter, balance, `账本第 ${entry.id} 条余额断裂`);
  }
  assert.equal(state.credits, balance, '期末余额应与账本一致');
}

test('应付款按紧急度与违约情形从锁定牌价计算', () => {
  for (const urgency of [1, 2, 3]) {
    const rates = snapshotRates(DEFAULT_PRICE_RATES, urgency);
    assert.equal(payableForOutcome(rates, 'on-time'), DEFAULT_PRICE_RATES.base[urgency]);
    assert.equal(payableForOutcome(rates, 'late'), DEFAULT_PRICE_RATES.late[urgency]);
    assert.equal(payableForOutcome(rates, 'wrong'), -DEFAULT_PRICE_RATES.wrongPenalty[urgency]);
    assert.equal(payableForOutcome(rates, 'wrong-late'), -DEFAULT_PRICE_RATES.wrongPenalty[urgency]);
  }
});

test('邮件生成时创建合约并锁定当期牌价，报价写入对账轨迹', () => {
  const state = createInitialState({ seed: 'contract-create' });

  assert.equal(state.contracts.length, state.letters.length);
  assert.equal(state.priceTables.length, 1);
  for (const letter of state.letters) {
    const contract = findContractByLetter(state, letter.id);
    assert.equal(contract.status, 'open');
    assert.equal(contract.priceVersion, 1);
    assert.equal(contract.quotedAmount, DEFAULT_PRICE_RATES.base[letter.urgency]);
  }

  const quotes = state.ledger.filter((entry) => entry.type === 'quote');
  assert.equal(quotes.length, state.letters.length);
  assert.equal(state.credits, 80);
  assertLedgerChain(state);
});

test('日结按合约结算：准时全额、逾时减收、误投赔付、积压按日违约金', () => {
  const state = createInitialState({ seed: 'settle-outcomes' });
  const [onTime, late, wrong, ...rest] = state.letters;
  late.deadlineHour = 7;
  const assignments = [
    assignmentFor(state, onTime, 'comet'),
    assignmentFor(state, late, 'zephyr'),
    assignmentFor(state, wrong, 'atlas', wrongTargetFor(state, wrong).id)
  ];
  const creditsBefore = state.credits;
  const report = advanceDay(state, assignments);

  const onTimeContract = findContractByLetter(state, onTime.id);
  const lateContract = findContractByLetter(state, late.id);
  const wrongContract = findContractByLetter(state, wrong.id);
  assert.equal(onTimeContract.settledAmount, onTimeContract.rates.base);
  assert.equal(lateContract.settledAmount, lateContract.rates.late);
  assert.equal(wrongContract.settledAmount, -wrongContract.rates.wrongPenalty);

  const expectedBacklog = rest.reduce((sum, letter) => (
    sum + findContractByLetter(state, letter.id).rates.backlogPenalty
  ), 0);
  const expectedTotal = onTimeContract.settledAmount + lateContract.settledAmount
    + wrongContract.settledAmount - expectedBacklog;
  assert.equal(state.credits, Math.round((creditsBefore + expectedTotal) * 10) / 10);

  const types = report.ledgerEntries.map((entry) => entry.type);
  assert.equal(types.filter((type) => type === 'settlement').length, 3);
  assert.equal(types.filter((type) => type === 'backlog-penalty').length, rest.length);
  assert.equal(report.creditsDelta, Math.round((state.credits - creditsBefore) * 10) / 10);
  assertLedgerChain(state);
});

test('价格调整只影响新合约，已锁定合约仍按原牌价结算', () => {
  const state = createInitialState({ seed: 'price-lock' });
  const oldLetter = state.letters[0];
  const oldContract = findContractByLetter(state, oldLetter.id);
  const oldQuote = oldContract.quotedAmount;

  const { table } = adjustPriceTable(state, { base: { 1: 60, 2: 60, 3: 60 } }, '旺季调价');
  assert.equal(table.version, 2);
  assert.equal(currentPriceTable(state).version, 2);
  assert.equal(state.ledger.at(-1).type, 'price-change');

  advanceDay(state, [assignmentFor(state, oldLetter)]);
  assert.equal(oldContract.settledAmount, oldQuote, '旧合约应按锁定牌价结算');

  const newLetters = state.letters.filter((letter) => letter.day === 2);
  assert.ok(newLetters.length > 0);
  for (const letter of newLetters) {
    const contract = findContractByLetter(state, letter.id);
    assert.equal(contract.priceVersion, 2);
    assert.equal(contract.quotedAmount, 60);
    assert.equal(contract.rates.late, DEFAULT_PRICE_RATES.late[letter.urgency], '未调整的分档沿用上一版');
  }
  assertLedgerChain(state);
});

test('撤单收取手续费、邮件退出队列并保留对账轨迹', () => {
  const state = createInitialState({ seed: 'cancel-contract' });
  const letter = state.letters[0];
  const contract = findContractByLetter(state, letter.id);
  const creditsBefore = state.credits;

  const { entry } = cancelContract(state, contract.id);
  assert.equal(contract.status, 'cancelled');
  assert.equal(letter.status, 'cancelled');
  assert.equal(entry.type, 'cancellation');
  assert.equal(entry.amount, -contract.rates.cancelFee);
  assert.equal(state.credits, creditsBefore - contract.rates.cancelFee);

  assert.throws(() => cancelContract(state, contract.id), /不能撤单/);
  assert.throws(() => cancelContract(state, 'C99-99'), /找不到合约/);

  const report = advanceDay(state, []);
  assert.ok(!report.unassignedLetterIds.includes(letter.id), '已撤单邮件不应再记积压');
  assert.ok(!report.ledgerEntries.some((item) => item.letterId === letter.id), '已撤单合约不应再产生费用');
  assertLedgerChain(state);
});

test('重算按锁定牌价调整差额，原结算记录保留在账本中', () => {
  const state = createInitialState({ seed: 'recalculate' });
  const letter = state.letters[0];
  letter.deadlineHour = 7;
  advanceDay(state, [assignmentFor(state, letter)]);

  const contract = findContractByLetter(state, letter.id);
  assert.equal(contract.outcome, 'late');
  const settledAmount = contract.settledAmount;
  const creditsBefore = state.credits;
  const ledgerLengthBefore = state.ledger.length;

  const { entry } = recalculateContract(state, contract.id, { outcome: 'on-time' });
  const expectedDelta = contract.rates.base - settledAmount;
  assert.equal(entry.type, 'recalculation');
  assert.equal(entry.amount, expectedDelta);
  assert.equal(entry.meta.previousAmount, settledAmount);
  assert.equal(entry.meta.newAmount, contract.rates.base);
  assert.equal(entry.meta.previousOutcome, 'late');
  assert.equal(contract.settledAmount, contract.rates.base);
  assert.equal(state.credits, Math.round((creditsBefore + expectedDelta) * 10) / 10);

  const settlementEntries = state.ledger.filter((item) => item.type === 'settlement' && item.contractId === contract.id);
  assert.equal(settlementEntries.length, 1, '原结算记录必须保留');
  assert.equal(settlementEntries[0].amount, settledAmount);
  assert.ok(state.ledger.length > ledgerLengthBefore, '重算只能追加不能改账');

  const again = recalculateContract(state, contract.id, { outcome: 'on-time' });
  assert.equal(again.entry.amount, 0, '重复重算无差额也要留痕');
  assert.equal(again.entry.type, 'recalculation');
  assertLedgerChain(state);
});

test('未结算合约不能重算，重算情形必须合法', () => {
  const state = createInitialState({ seed: 'recalculate-guard' });
  const contract = findContractByLetter(state, state.letters[0].id);

  assert.throws(() => recalculateContract(state, contract.id), /尚未结算/);
  advanceDay(state, [assignmentFor(state, state.letters[0])]);
  assert.throws(() => recalculateContract(state, contract.id, { outcome: 'lost' }), /无效/);
});

test('混合经营多日后账本链条与余额始终一致', () => {
  const state = createInitialState({ seed: 'ledger-consistency' });
  adjustPriceTable(state, { base: { 3: 30 } }, '加急加价');

  for (let day = 0; day < 4 && state.phase === 'planning'; day += 1) {
    const openLetters = state.letters.filter((letter) => ['inbox', 'backlog'].includes(letter.status));
    const [first, second, ...rest] = openLetters;
    if (second) cancelContract(state, findContractByLetter(state, second.id).id);
    const assignments = rest.slice(0, 3).map((letter, index) => ({
      ...assignmentFor(state, letter, ['comet', 'zephyr', 'atlas'][index % 3]),
      order: index
    }));
    advanceDay(state, assignments);
    const settled = state.contracts.find((item) => item.status === 'settled');
    if (settled) recalculateContract(state, settled.id, { outcome: 'late' });
    assert.ok(first, '每天应有可处理的邮件');
  }

  assertLedgerChain(state);
  const totalAmount = state.ledger.reduce((sum, entry) => sum + entry.amount, 0);
  assert.equal(state.credits, Math.round((80 + totalAmount) * 10) / 10, '余额应等于初始邮资加全部入账金额');
});

test('邮资触及零下限时按实际入账并保留请求金额备查', () => {
  const state = createInitialState({ seed: 'credit-floor' });
  state.credits = 1;
  const letter = state.letters[0];
  const contract = findContractByLetter(state, letter.id);
  contract.rates.cancelFee = 5;

  const { entry } = cancelContract(state, contract.id);
  assert.equal(entry.amount, -1, '余额不足时只能入账可扣部分');
  assert.equal(entry.requestedAmount, -5);
  assert.equal(entry.balanceAfter, 0);
  assert.equal(state.credits, 0);
  assert.equal(state.ledger.at(-1).id, entry.id);
});

test('v1 旧存档迁移为合约版：补建合约并以 opening 记录锚定对账起点', () => {
  const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'sky-post-migrate-v1-'));
  const dataFile = path.join(temporaryDirectory, 'state.json');

  const fresh = createInitialState({ seed: 'migrate-v1' });
  const legacy = { ...fresh };
  delete legacy.priceTables;
  delete legacy.contracts;
  delete legacy.ledger;
  delete legacy.ledgerSeq;
  legacy.version = 1;
  legacy.day = 3;
  legacy.credits = 66;
  legacy.letters[0].status = 'delivered';
  legacy.letters[0].outcome = 'late';
  legacy.letters[0].deliveredDay = 1;
  legacy.letters[1].status = 'delivered';
  legacy.letters[1].outcome = 'wrong';
  legacy.letters[1].deliveredDay = 2;
  fs.writeFileSync(dataFile, JSON.stringify(legacy), 'utf8');

  const migrated = new GameStore(dataFile, { seed: 'ignored' }).load();
  assert.equal(migrated.version, 2);
  assert.equal(migrated.priceTables.length, 1);
  assert.equal(migrated.contracts.length, migrated.letters.length);

  const lateContract = migrated.contracts.find((contract) => contract.letterId === migrated.letters[0].id);
  assert.equal(lateContract.status, 'settled');
  assert.equal(lateContract.outcome, 'late');
  assert.equal(lateContract.settledAmount, lateContract.rates.late);
  const wrongContract = migrated.contracts.find((contract) => contract.letterId === migrated.letters[1].id);
  assert.equal(wrongContract.settledAmount, -wrongContract.rates.wrongPenalty);
  const openContract = migrated.contracts.find((contract) => contract.letterId === migrated.letters[2].id);
  assert.equal(openContract.status, 'open');

  assert.equal(migrated.ledger.length, 1);
  assert.equal(migrated.ledger[0].type, 'opening');
  assert.equal(migrated.ledger[0].balanceAfter, 66);
  assertLedgerChain(migrated);

  const persisted = JSON.parse(fs.readFileSync(dataFile, 'utf8'));
  assert.equal(persisted.version, 2, '迁移结果应写回存档');
  fs.rmSync(temporaryDirectory, { recursive: true, force: true });
});

test('合约 HTTP 接口覆盖调价、撤单、重算与版本冲突', async (context) => {
  const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'sky-post-contracts-api-'));
  const store = new GameStore(path.join(temporaryDirectory, 'state.json'), { seed: 'contracts-api' });
  store.load();
  const server = createApp({ store, clientDist: null }).listen(0);
  context.after(() => {
    server.close();
    fs.rmSync(temporaryDirectory, { recursive: true, force: true });
  });

  await new Promise((resolve) => server.once('listening', resolve));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const request = async (url, options) => {
    const response = await fetch(`${baseUrl}${url}`, {
      headers: { 'Content-Type': 'application/json' },
      ...options
    });
    return { status: response.status, body: await response.json() };
  };

  const initial = await request('/api/game');
  const game = initial.body.state;
  const revision = game.revision;
  const contract = game.contracts[0];

  const badRates = await request('/api/contracts/prices', {
    method: 'POST',
    body: JSON.stringify({ rates: { base: { 1: -5 } }, expectedRevision: revision })
  });
  assert.equal(badRates.status, 400);

  const noRevision = await request('/api/contracts/prices', {
    method: 'POST',
    body: JSON.stringify({ rates: { base: { 1: 9 } } })
  });
  assert.equal(noRevision.status, 400);

  const priced = await request('/api/contracts/prices', {
    method: 'POST',
    body: JSON.stringify({ rates: { base: { 1: 9, 2: 16, 3: 24 } }, note: '测试调价', expectedRevision: revision })
  });
  assert.equal(priced.status, 200);
  assert.equal(priced.body.table.version, 2);
  assert.equal(priced.body.state.priceTables.length, 2);
  assert.equal(priced.body.state.contracts.find((item) => item.id === contract.id).priceVersion, 1, '已有合约保持旧版牌价');
  assert.ok(priced.body.state.ledger.some((entry) => entry.type === 'price-change'));

  const staleRevision = await request('/api/contracts/prices', {
    method: 'POST',
    body: JSON.stringify({ rates: { base: { 1: 10 } }, expectedRevision: revision })
  });
  assert.equal(staleRevision.status, 409);

  const missing = await request('/api/contracts/C99-99/cancel', {
    method: 'POST',
    body: JSON.stringify({ expectedRevision: priced.body.state.revision })
  });
  assert.equal(missing.status, 404);

  const recalcOpen = await request(`/api/contracts/${contract.id}/recalculate`, {
    method: 'POST',
    body: JSON.stringify({ outcome: 'late', expectedRevision: priced.body.state.revision })
  });
  assert.equal(recalcOpen.status, 400);

  const cancelled = await request(`/api/contracts/${contract.id}/cancel`, {
    method: 'POST',
    body: JSON.stringify({ expectedRevision: priced.body.state.revision })
  });
  assert.equal(cancelled.status, 200);
  assert.equal(cancelled.body.contract.status, 'cancelled');
  assert.equal(cancelled.body.entry.type, 'cancellation');
  assert.ok(cancelled.body.state.letters.find((letter) => letter.id === contract.letterId).status === 'cancelled');

  const recalcCancelled = await request(`/api/contracts/${contract.id}/recalculate`, {
    method: 'POST',
    body: JSON.stringify({ outcome: 'late', expectedRevision: cancelled.body.state.revision })
  });
  assert.equal(recalcCancelled.status, 400);

  const openLetter = cancelled.body.state.letters.find((letter) => letter.status === 'inbox');
  const advance = await request('/api/game/day/advance', {
    method: 'POST',
    body: JSON.stringify({
      assignments: [{ letterId: openLetter.id, courierId: 'comet', targetIslandId: openLetter.recipientIslandId, order: 0 }],
      expectedRevision: cancelled.body.state.revision
    })
  });
  assert.equal(advance.status, 200);
  const settledContract = advance.body.state.contracts.find((item) => item.letterId === openLetter.id);
  assert.equal(settledContract.status, 'settled');

  const recalculated = await request(`/api/contracts/${settledContract.id}/recalculate`, {
    method: 'POST',
    body: JSON.stringify({ outcome: 'late', expectedRevision: advance.body.state.revision })
  });
  assert.equal(recalculated.status, 200);
  assert.equal(recalculated.body.entry.type, 'recalculation');
  assert.equal(recalculated.body.contract.settledAmount, recalculated.body.contract.rates.late);
  assert.ok(recalculated.body.state.ledger.some((entry) => entry.type === 'recalculation'));
});

test('预览的邮资预计与正式结算完全一致', () => {
  const state = createInitialState({ seed: 'preview-matches-settle' });
  const assignments = state.letters.slice(0, 3).map((letter, index) => ({
    ...assignmentFor(state, letter, ['comet', 'zephyr', 'atlas'][index]),
    order: 0
  }));
  const preview = previewPlan(state, assignments);
  assert.equal(preview.valid, true);

  const report = advanceDay(state, assignments);
  assert.equal(report.creditsDelta, preview.projection.creditsDelta);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createApp } from '../app.js';
import { GameStore } from '../store.js';

async function startServer(context, seed = 'contract-api') {
  const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'sky-post-contracts-api-'));
  const store = new GameStore(path.join(temporaryDirectory, 'state.json'), { seed });
  store.load();
  const server = createApp({ store, clientDist: null }).listen(0);
  context.after(() => {
    server.close();
    fs.rmSync(temporaryDirectory, { recursive: true, force: true });
  });
  await new Promise((resolve) => server.once('listening', resolve));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const request = (url, options = {}) => fetch(`${baseUrl}${url}`, {
    headers: { 'Content-Type': 'application/json' },
    ...options
  }).then(async (response) => ({ status: response.status, body: await response.json().catch(() => ({})) }));
  return { request, store };
}

test('合约 HTTP 闭环：签约、自动结算、重算、取消、调价', async (context) => {
  const { request } = await startServer(context);

  const gameResponse = await request('/api/game');
  const game = gameResponse.body.state;
  const letter = game.letters.find((item) => item.status === 'inbox');
  const revision = game.revision;

  const created = await request('/api/contracts', {
    method: 'POST',
    body: JSON.stringify({ letterId: letter.id, expectedRevision: revision })
  });
  assert.equal(created.status, 200);
  assert.equal(created.body.state.revision, revision + 1);
  const contractId = created.body.state.contracts.contracts[0].id;

  // 旧 revision 再签约必须冲突
  const staleCreate = await request('/api/contracts', {
    method: 'POST',
    body: JSON.stringify({ title: '过期请求', urgency: 1, weight: 1, expectedRevision: revision })
  });
  assert.equal(staleCreate.status, 409);

  // 重复为同一邮件签约返回 409
  const duplicate = await request('/api/contracts', {
    method: 'POST',
    body: JSON.stringify({ letterId: letter.id, expectedRevision: revision + 1 })
  });
  assert.equal(duplicate.status, 409);

  // 手动结算
  const settled = await request(`/api/contracts/${contractId}/settle`, {
    method: 'POST',
    body: JSON.stringify({ outcome: 'on-time', expectedRevision: revision + 1 })
  });
  assert.equal(settled.status, 200);
  assert.equal(settled.body.contract.status, 'settled');

  // 重算必须带原因
  const recalNoReason = await request(`/api/contracts/${contractId}/recalculate`, {
    method: 'POST',
    body: JSON.stringify({ outcome: 'late', expectedRevision: revision + 2 })
  });
  assert.equal(recalNoReason.status, 400);

  const recalculated = await request(`/api/contracts/${contractId}/recalculate`, {
    method: 'POST',
    body: JSON.stringify({
      outcome: 'wrong-late',
      reason: '收件岛提出申诉，凭签收记录改判',
      expectedRevision: revision + 2
    })
  });
  assert.equal(recalculated.status, 200);
  assert.equal(recalculated.body.contract.status, 'recalculated');
  assert.ok(recalculated.body.event.previousAmount !== undefined);

  // 自定义新合约并按出港后取消
  const custom = await request('/api/contracts', {
    method: 'POST',
    body: JSON.stringify({ title: '跨岛齿轮急件', urgency: 3, weight: 4, expectedRevision: revision + 3 })
  });
  assert.equal(custom.status, 200);
  const customId = custom.body.state.contracts.contracts.find((item) => item.title === '跨岛齿轮急件').id;

  const cancelled = await request(`/api/contracts/${customId}/cancel`, {
    method: 'POST',
    body: JSON.stringify({
      stage: 'after-cutoff',
      reason: '信使已离港，委托方撤回委托',
      expectedRevision: revision + 4
    })
  });
  assert.equal(cancelled.status, 200);
  assert.equal(cancelled.body.contract.status, 'cancelled');

  // 调整费率只影响之后的新合约
  const rateUpdate = await request('/api/contracts/rates', {
    method: 'POST',
    body: JSON.stringify({ tiers: { 1: { baseFee: 12 } }, expectedRevision: revision + 5 })
  });
  assert.equal(rateUpdate.status, 200);
  assert.equal(rateUpdate.body.rateCard.version, 2);
  assert.equal(rateUpdate.body.event.rateChanges[0].to, 12);

  const listing = await request('/api/contracts');
  assert.equal(listing.status, 200);
  assert.equal(listing.body.contracts.ledger.length, 6);
  assert.deepEqual(
    listing.body.contracts.ledger.map((event) => event.type),
    ['created', 'settled', 'recalculated', 'created', 'cancelled', 'rate-adjust']
  );
});

test('旧存档迁移后补齐合约模块，且已保存状态不会被重复迁移', async (context) => {
  const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'sky-post-contract-migration-'));
  const dataFile = path.join(temporaryDirectory, 'state.json');
  const store = new GameStore(dataFile, { seed: 'migration-contracts' });
  const state = store.load();
  delete state.contracts;
  fs.writeFileSync(dataFile, JSON.stringify(state), 'utf8');

  const reloadedStore = new GameStore(dataFile, { seed: 'ignored' });
  const migrated = reloadedStore.load();
  assert.ok(migrated.contracts);
  assert.equal(migrated.contracts.rateCard.version, 1);
  assert.deepEqual(migrated.contracts.ledger, []);

  // 再次加载不应再改写
  const again = new GameStore(dataFile, { seed: 'ignored' }).load();
  assert.deepEqual(again.contracts, migrated.contracts);
  fs.rmSync(temporaryDirectory, { recursive: true, force: true });
});

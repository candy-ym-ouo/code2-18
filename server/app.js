import fs from 'node:fs';
import path from 'node:path';
import express from 'express';
import { advanceDay, GameRuleError, previewPlan, publicGameState } from './engine.js';
import { assertPlanningPhase } from './store.js';
import {
  adjustRateCard,
  cancelContract,
  contractSummary,
  createContract,
  quoteContract,
  recalculateContract,
  settleContract
} from './contracts.js';

function getAssignments(body) {
  if (body === undefined || body === null) {
    throw new GameRuleError('请求体必须是 JSON 对象，并提供 assignments 数组。');
  }
  if (typeof body !== 'object' || Array.isArray(body)) {
    throw new GameRuleError('请求体必须是 JSON 对象。');
  }
  if (!Object.prototype.hasOwnProperty.call(body, 'assignments')) {
    throw new GameRuleError('请求体必须提供 assignments 数组。');
  }
  if (!Array.isArray(body.assignments)) {
    throw new GameRuleError('assignments 必须是数组。');
  }
  return body.assignments;
}

function assertExpectedRevision(state, expectedRevision) {
  if (!Number.isInteger(expectedRevision)) {
    throw new GameRuleError('提交游戏进度时必须提供整数 expectedRevision。');
  }
  if (state.revision !== expectedRevision) {
    throw new GameRuleError('游戏进度已在其他请求中更新，请刷新后再提交。', [], 409);
  }
}

export function createApp({ store, clientDist }) {
  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '100kb' }));

  app.get('/api/health', (request, response) => {
    const state = store.getState();
    response.json({
      ok: true,
      phase: state.phase,
      day: state.day,
      version: state.version
    });
  });

  app.get('/api/game', (request, response) => {
    const state = publicGameState(store.getState());
    const recovery = store.getRecovery?.();
    response.json({ state: recovery ? { ...state, recovery } : state });
  });

  app.post('/api/game/plan/preview', (request, response) => {
    const state = store.getState();
    assertPlanningPhase(state);
    response.json({ preview: previewPlan(state, getAssignments(request.body)) });
  });

  app.post('/api/game/day/advance', (request, response) => {
    const report = store.mutate((state) => {
      assertPlanningPhase(state);
      assertExpectedRevision(state, request.body?.expectedRevision);
      return advanceDay(state, getAssignments(request.body));
    });
    response.json({
      report,
      state: publicGameState(store.getState())
    });
  });

  app.post('/api/game/reset', (request, response) => {
    const requestedSeed = request.body?.seed;
    const seed = requestedSeed === undefined || requestedSeed === null || requestedSeed === ''
      ? Date.now()
      : String(requestedSeed);
    const state = store.reset(seed);
    response.json({ state: publicGameState(state) });
  });

  function getJsonObject(body) {
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      throw new GameRuleError('请求体必须是 JSON 对象。');
    }
    return body;
  }

  // 合约模块的所有写操作都与调度结算共用 revision，防止两笔业务互相覆盖。
  function mutateContracts(mutator, request) {
    const body = getJsonObject(request.body);
    if (!Number.isInteger(body.expectedRevision)) {
      throw new GameRuleError('提交合约变更时必须提供整数 expectedRevision。');
    }
    let result;
    const state = store.mutate((draft) => {
      assertExpectedRevision(draft, body.expectedRevision);
      result = mutator(draft, body);
      draft.revision = Number.isInteger(draft.revision) ? draft.revision + 1 : 1;
    });
    return { result, state: publicGameState(store.getState()) };
  }

  function publicContracts(state) {
    return {
      rateCard: state.contracts.rateCard,
      contracts: state.contracts.contracts,
      ledger: state.contracts.ledger,
      summary: contractSummary(state.contracts)
    };
  }

  app.get('/api/contracts', (request, response) => {
    response.json({ contracts: publicContracts(store.getState()) });
  });

  app.post('/api/contracts/quote', (request, response) => {
    const body = getJsonObject(request.body);
    const quote = quoteContract(store.getState().contracts, body);
    response.json({ quote });
  });

  app.post('/api/contracts', (request, response) => {
    const { state } = mutateContracts((draft, body) => ({
      contract: createContract(draft.contracts, draft, body, { day: draft.day })
    }), request);
    response.json({ state });
  });

  app.post('/api/contracts/rates', (request, response) => {
    const { result, state } = mutateContracts((draft, body) => (
      adjustRateCard(draft.contracts, body.tiers, { day: draft.day })
    ), request);
    response.json({ rateCard: result.rateCard, changes: result.changes, event: result.event, state });
  });

  app.post('/api/contracts/:contractId/settle', (request, response) => {
    const { result, state } = mutateContracts((draft, body) => settleContract(
      draft.contracts,
      request.params.contractId,
      { outcome: body.outcome, day: draft.day, reason: body.reason }
    ), request);
    response.json({ contract: result.contract, event: result.event, state });
  });

  app.post('/api/contracts/:contractId/recalculate', (request, response) => {
    const { result, state } = mutateContracts((draft, body) => recalculateContract(
      draft.contracts,
      request.params.contractId,
      { outcome: body.outcome, day: draft.day, reason: body.reason }
    ), request);
    response.json({ contract: result.contract, event: result.event, state });
  });

  app.post('/api/contracts/:contractId/cancel', (request, response) => {
    const { result, state } = mutateContracts((draft, body) => cancelContract(
      draft.contracts,
      request.params.contractId,
      { stage: body.stage, day: draft.day, reason: body.reason }
    ), request);
    response.json({ contract: result.contract, event: result.event, state });
  });

  app.use('/api', (request, response) => {
    response.status(404).json({ error: '接口不存在。' });
  });

  if (clientDist && fs.existsSync(clientDist)) {
    app.use(express.static(clientDist));
    app.use((request, response, next) => {
      if (request.method !== 'GET') return next();
      response.sendFile(path.join(clientDist, 'index.html'));
    });
  }

  app.use((error, request, response, next) => {
    if (response.headersSent) return next(error);
    const statusCode = error.statusCode || 500;
    if (statusCode >= 500) console.error(error);
    response.status(statusCode).json({
      error: error.message || '服务器发生未知错误。',
      issues: error.issues || undefined
    });
  });

  return app;
}

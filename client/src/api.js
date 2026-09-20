async function request(path, options = {}) {
  const response = await fetch(path, {
    headers: { 'Content-Type': 'application/json', ...(options.headers || {}) },
    ...options
  });

  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(body.error || `请求失败（${response.status}）`);
    error.status = response.status;
    error.issues = body.issues || [];
    throw error;
  }
  return body;
}

export const gameApi = {
  getState: () => request('/api/game'),
  preview: (assignments) => request('/api/game/plan/preview', {
    method: 'POST',
    body: JSON.stringify({ assignments })
  }),
  advance: (assignments, expectedRevision) => request('/api/game/day/advance', {
    method: 'POST',
    body: JSON.stringify({ assignments, expectedRevision })
  }),
  reset: (seed) => request('/api/game/reset', {
    method: 'POST',
    body: JSON.stringify(seed === undefined || seed === null ? {} : { seed })
  })
};

export const contractApi = {
  list: () => request('/api/contracts'),
  quote: (payload) => request('/api/contracts/quote', {
    method: 'POST',
    body: JSON.stringify(payload)
  }),
  create: (payload, expectedRevision) => request('/api/contracts', {
    method: 'POST',
    body: JSON.stringify({ ...payload, expectedRevision })
  }),
  adjustRates: (tiers, expectedRevision) => request('/api/contracts/rates', {
    method: 'POST',
    body: JSON.stringify({ tiers, expectedRevision })
  }),
  settle: (contractId, outcome, expectedRevision, reason) => request(`/api/contracts/${contractId}/settle`, {
    method: 'POST',
    body: JSON.stringify({ outcome, reason, expectedRevision })
  }),
  recalculate: (contractId, outcome, expectedRevision, reason) => request(`/api/contracts/${contractId}/recalculate`, {
    method: 'POST',
    body: JSON.stringify({ outcome, reason, expectedRevision })
  }),
  cancel: (contractId, stage, expectedRevision, reason) => request(`/api/contracts/${contractId}/cancel`, {
    method: 'POST',
    body: JSON.stringify({ stage, reason, expectedRevision })
  })
};

const j = async (r) => {
  const body = await r.json().catch(() => ({}));
  if (!r.ok) {
    const err = new Error(body.error || `HTTP ${r.status}`);
    err.body = body;
    throw err;
  }
  return body;
};

export const api = {
  rules: () => fetch('/api/rules').then(j),
  versions: () => fetch('/api/versions').then(j),
  mappings: () => fetch('/api/mappings').then(j),
  addMapping: (payload) =>
    fetch('/api/mappings', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    }).then(j),
  normalize: (urls) =>
    fetch('/api/normalize', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ urls }),
    }).then(j),
  verify: (sourceNorm = null) =>
    fetch('/api/verify', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify(sourceNorm ? { source_norm: sourceNorm } : {}),
    }).then(j),
  crawl: (key, version = null) =>
    fetch(`/api/crawl/${encodeURIComponent(key)}${version ? `?version=${version}` : ''}`).then(j),
  plans: () => fetch('/api/plans').then(j),
  plan: (id) => fetch(`/api/plans/${id}`).then(j),
  createPlan: (name) =>
    fetch('/api/plans', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name }),
    }).then(j),
  buildPlan: (id) =>
    fetch(`/api/plans/${id}/build`, { method: 'POST' }).then(j),
  publishPlan: (id) =>
    fetch(`/api/plans/${id}/publish`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}',
    }).then(j),

  // 映射变更集：创建（冻结版本与快照）→ 提交审阅 → 应用/放弃
  changesets: () => fetch('/api/changesets').then(j),
  changeset: (id) => fetch(`/api/changesets/${id}`).then(j),
  createChangeset: (payload) =>
    fetch('/api/changesets', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    }).then(j),
  submitChangeset: (id) =>
    fetch(`/api/changesets/${id}/submit`, { method: 'POST' }).then(j),
  applyChangeset: (id, idempotencyKey = null) =>
    fetch(`/api/changesets/${id}/apply`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify(idempotencyKey ? { idempotency_key: idempotencyKey } : {}),
    }).then(j),
  abandonChangeset: (id) =>
    fetch(`/api/changesets/${id}/abandon`, { method: 'POST' }).then(j),
};

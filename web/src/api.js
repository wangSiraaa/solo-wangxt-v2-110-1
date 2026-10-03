const j = async (r) => {
  const body = await r.json().catch(() => ({}));
  if (!r.ok) {
    const e = new Error(body.error || `HTTP ${r.status}`);
    e.status = r.status;
    e.body = body;
    throw e;
  }
  return body;
};

export const api = {
  rules: () => fetch('/api/rules').then(j),
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
  crawl: (key) =>
    fetch('/api/crawl/' + encodeURIComponent(key)).then(j),
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

  // 映射版本
  mappingVersions: () => fetch('/api/mapping-versions').then(j),

  // 映射变更集
  changesets: () => fetch('/api/changesets').then(j),
  changeset: (id) => fetch(`/api/changesets/${id}`).then(j),
  createChangeset: (payload) =>
    fetch('/api/changesets', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    }).then(j),
  addChangesetItem: (id, payload) =>
    fetch(`/api/changesets/${id}/items`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    }).then(j),
  deleteChangesetItem: (id, itemId) =>
    fetch(`/api/changesets/${id}/items/${itemId}`, { method: 'DELETE' }).then(j),
  submitChangeset: (id) =>
    fetch(`/api/changesets/${id}/submit`, { method: 'POST' }).then(j),
  applyChangeset: (id) =>
    fetch(`/api/changesets/${id}/apply`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}',
    }).then(j),
  abandonChangeset: (id, reason) =>
    fetch(`/api/changesets/${id}/abandon`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ reason }),
    }).then(j),
};

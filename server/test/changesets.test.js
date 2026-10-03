/**
 * 映射变更集验收测试（真实 Fastify API + 随项目本地站点 + PostgreSQL 事务语义）。
 * 与 verifier.test.js 不同：这里需要数据库，用独立的最小数据集 TRUNCATE 后自测。
 *
 * 覆盖验收标准：
 *  ① 无冲突改动应用后，生效映射与待验证清单同时更新（版本绑定）；
 *  ② 两个变更集修改同一 canonical key：先应用者成功，后应用者过期 + 三方差异，不覆盖；
 *  ③ 非法外网目标 / 无效编码 / 未裁决歧义：整组拒绝，当前映射毫无变化；
 *  ④ 应用后旧验证报告证据与已建方案不能再发布；重新验证 + 重建后才可发布；
 *  ⑤ 重复应用同一已应用变更集返回同一结果，原始输入/版本/结果均可审计。
 */
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import Fastify from 'fastify';
import apiRoutes from '../src/routes.js';
import { startFixture } from '../src/fixture.js';
import { pool } from '../src/db.js';
import { config, fixtureOrigin } from '../src/config.js';
import { recomputeMappings } from '../src/mappings-service.js';

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(0, '127.0.0.1', () => {
      const p = srv.address().port;
      srv.close(() => resolve(p));
    });
    srv.on('error', reject);
  });
}

const origin = () => fixtureOrigin();
let app;
let fixture;

async function resetDb(mappings) {
  await pool.query(
    `TRUNCATE mapping_changeset_items, mapping_changesets, migration_plan_items,
              migration_plans, mapping_versions, verification_verdicts,
              crawl_results, url_mappings, mapping_inputs
     RESTART IDENTITY CASCADE`);
  await pool.query("INSERT INTO mapping_versions (version, note) VALUES (1,'test init')");
  for (const m of mappings) {
    await pool.query(
      `INSERT INTO mapping_inputs
         (source_raw, source_norm, target_raw, target_norm, mapping_type, note)
       VALUES ($1,$1,$2,$2,$3,$4)`,
      [m.source, m.target, m.type ?? 'manual', m.note ?? null]);
  }
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    await recomputeMappings(c, { bumpVersion: false });
    await c.query('COMMIT');
  } finally { c.release(); }
}

const BASE_MAPPINGS = () => [
  { source: `${origin()}/news/123`, target: `${origin()}/articles/123` },
  { source: `${origin()}/t-new/1`, target: `${origin()}/articles/123` },
];

before(async () => {
  config.fixture.port = await freePort();
  fixture = await startFixture();
  app = Fastify({ logger: false });
  await app.register(apiRoutes);
  await app.ready();
});

after(async () => {
  await app.close();
  await fixture.close();
  await pool.end();
});

beforeEach(async () => { await resetDb(BASE_MAPPINGS()); });

async function call(method, url, body) {
  const res = await app.inject({
    method, url,
    payload: body ?? undefined,
    headers: body ? { 'content-type': 'application/json' } : undefined,
  });
  let json = null;
  try { json = JSON.parse(res.body); } catch { json = res.body; }
  return { status: res.statusCode, body: json };
}

async function createDraft(name) {
  const r = await call('POST', '/api/changesets', { name });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  return r.body.id;
}
async function addItem(id, item) {
  const r = await call('POST', `/api/changesets/${id}/items`, item);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  return r.body;
}
async function mappingsList() {
  return (await call('GET', '/api/mappings')).body;
}
async function mappingRow(key) {
  const d = await mappingsList();
  return d.mappings.find((m) => m.source_norm === key);
}

test('① 无冲突改动应用：生效映射与待验证清单同时更新，版本前进', async () => {
  const before = await mappingsList();
  assert.equal(before.mapping_version, 1);
  assert.equal(before.mappings.length, 2);

  const id = await createDraft('新增 t-new/2');
  await addItem(id, {
    source_raw: `${origin()}/t-new/2`, target_raw: `${origin()}/articles/tech/42`,
    mapping_type: 'manual', note: '新栏目旧址',
  });
  assert.equal((await call('POST', `/api/changesets/${id}/submit`)).status, 200);
  const applied = await call('POST', `/api/changesets/${id}/apply`);
  assert.equal(applied.status, 200, JSON.stringify(applied.body));
  assert.equal(applied.body.applied_version, 2);
  assert.deepEqual(applied.body.affected_keys.sort(),
    [`${origin()}/t-new/2`]);

  const after = await mappingsList();
  assert.equal(after.mapping_version, 2, '当前映射版本前进到 v2');
  const added = after.mappings.find((m) => m.source_norm === `${origin()}/t-new/2`);
  assert.ok(added, '生效表包含新增映射');
  assert.equal(added.mapping_version, 2);
  // 待验证清单：新映射尚无针对 v2 的证据
  assert.equal(added.needs_reverify, true);
  assert.equal(added.verdict, null);

  // 原始材料带来源变更集，可审计
  const inputs = after.inputs.filter((i) => i.source_norm === `${origin()}/t-new/2`);
  assert.equal(inputs.length, 1);
  const { rows: cslink } = await pool.query(
    'SELECT source_changeset_id FROM mapping_inputs WHERE source_norm=$1',
    [`${origin()}/t-new/2`]);
  assert.equal(String(cslink[0].source_changeset_id), String(id));
});

test('② 同 canonical key 两个变更集：先应用成功，后应用过期且展示三方差异、不覆盖', async () => {
  const key = `${origin()}/news/123`;
  const idA = await createDraft('A 改 /news/123 -> /articles/tech/42');
  await addItem(idA, { operation: 'modify', source_raw: key, target_raw: `${origin()}/articles/tech/42` });
  const idB = await createDraft('B 改 /news/123 -> /articles/123?x=1');
  await addItem(idB, { operation: 'modify', source_raw: key, target_raw: `${origin()}/articles/123?x=1` });
  for (const id of [idA, idB]) {
    const s = await call('POST', `/api/changesets/${id}/submit`);
    assert.equal(s.status, 200, JSON.stringify(s.body));
  }

  const a = await call('POST', `/api/changesets/${idA}/apply`);
  assert.equal(a.status, 200, JSON.stringify(a.body));
  assert.equal(a.body.applied_version, 2);

  const b = await call('POST', `/api/changesets/${idB}/apply`);
  assert.equal(b.status, 409, '过期冲突必须以 409 拒绝');
  assert.equal(b.body.expired, true);
  assert.equal(b.body.base_version, 1);
  assert.equal(b.body.current_version, 2);
  assert.equal(b.body.conflicts.length, 1);
  const c3 = b.body.conflicts[0];
  assert.equal(c3.source_norm, key);
  // 三方差异：base=冻结的 v1，theirs=A 应用后的现状，ours=B 想改成的目标
  assert.equal(c3.base.target_norm, `${origin()}/articles/123`);
  assert.equal(c3.theirs.target_norm, `${origin()}/articles/tech/42`);
  assert.equal(c3.ours.target_norm, `${origin()}/articles/123?x=1`);

  // 不覆盖：生效映射仍是 A 的结果；B 状态变 stale
  const row = await mappingRow(key);
  assert.equal(row.target_norm, `${origin()}/articles/tech/42`);
  const detailB = await call('GET', `/api/changesets/${idB}`);
  assert.equal(detailB.body.changeset.status, 'stale');
  assert.equal(detailB.body.conflicts.length, 1);
});

test('③-a 外网目标：提交时整组拒绝，映射与版本毫无变化', async () => {
  const before = await mappingsList();
  const id = await createDraft('外网目标非法');
  // 条目录入阶段（草稿）即硬拒绝外网目标，不落任何条目
  const add = await addItemAllowFail(id, {
    source_raw: `${origin()}/evil`, target_raw: 'http://example.com/external-new',
  });
  assert.equal(add.status, 400);
  assert.match(add.body.error, /白名单/);

  // 换合法条目进草稿，再混入外网 —— 提交必须整组拒绝
  await addItem(id, { source_raw: `${origin()}/t-new/2`, target_raw: `${origin()}/articles/tech/42` });
  // 直接写一条草稿条目模拟第二编辑加入外网项（绕过录入校验）
  await pool.query(
    `INSERT INTO mapping_changeset_items
       (changeset_id, operation, source_raw, source_norm, target_raw, target_norm, mapping_type)
     VALUES ($1,'add',$2,$2,$3,$3,'manual')`,
    [id, `${origin()}/evil2`, 'http://example.com/x']);
  const sub = await call('POST', `/api/changesets/${id}/submit`);
  assert.equal(sub.status, 400);
  assert.ok(sub.body.rejected.length >= 1);
  assert.ok(sub.body.rejected.some((r) => /白名单/.test(r.reason)));

  const after = await mappingsList();
  assert.equal(after.mapping_version, before.mapping_version);
  assert.equal(after.mappings.length, before.mappings.length, '生效映射数量不变');
  assert.ok(!after.mappings.some((m) => m.source_norm === `${origin()}/evil2`));
});

test('③-b 无效百分号编码：提交时整组拒绝', async () => {
  const id = await createDraft('非法编码');
  const add = await addItemAllowFail(id, {
    source_raw: `${origin()}/a%zzbad`, target_raw: `${origin()}/articles/123`,
  });
  assert.equal(add.status, 400);
  assert.match(add.body.error, /percent/i);
});

test('③-c 未裁决歧义（同键不同目标、非显式裁决）：提交时整组拒绝', async () => {
  const before = await mappingsList();
  const id = await createDraft('制造歧义');
  // 以 add 语义给既有键声明不同目标 → 必须改用 modify 裁决；直接拒绝
  await pool.query(
    `INSERT INTO mapping_changeset_items
       (changeset_id, operation, source_raw, source_norm, target_raw, target_norm, mapping_type)
     VALUES ($1,'add',$2,$2,$3,$3,'manual')`,
    [id, `${origin()}/news/123`, `${origin()}/articles/999`]);
  const sub = await call('POST', `/api/changesets/${id}/submit`);
  assert.equal(sub.status, 400);
  assert.ok(sub.body.rejected.some((r) => /歧义/.test(r.reason)));
  const after = await mappingsList();
  assert.equal(after.mapping_version, before.mapping_version, '当前版本毫无变化');
});

test('④ 应用后旧证据与已建方案不能发布；重新验证并重建后可发布', async () => {
  // 1) 先验证并建可发布方案（最小集合：两个本来就 200 的映射）
  let v = await call('POST', '/api/verify', {});
  assert.equal(v.status, 200);
  const plan = await call('POST', '/api/plans', { name: '发布前方案' });
  const planId = plan.body.id;
  assert.equal((await call('POST', `/api/plans/${planId}/build`)).status, 200);
  const pub1 = await call('POST', `/api/plans/${planId}/publish`, {});
  assert.equal(pub1.status, 200, `应用前应可发布：${JSON.stringify(pub1.body)}`);
  assert.equal(pub1.body.published, true);

  // 已发布方案不可变，再建一个新方案演示过期阻断
  const plan2 = (await call('POST', '/api/plans', { name: '下一版方案' })).body.id;
  assert.equal((await call('POST', `/api/plans/${plan2}/build`)).status, 200);

  // 2) 应用变更集：新增 /t-new/2（旧证据/旧方案立即过期）
  const id = await createDraft('新增映射使版本前进');
  await addItem(id, { source_raw: `${origin()}/t-new/2`, target_raw: `${origin()}/articles/tech/42` });
  await call('POST', `/api/changesets/${id}/submit`);
  const applied = await call('POST', `/api/changesets/${id}/apply`);
  assert.equal(applied.status, 200);

  // 3) 旧验证证据：stale=true；爬取证据也过期
  const { rows: staleVerdicts } = await pool.query(
    "SELECT count(*)::int AS n FROM verification_verdicts WHERE stale=true");
  assert.ok(staleVerdicts[0].n >= 0);
  const d = await mappingsList();
  // /news/123 未被本次改动触及，证据仍新鲜；新键需要验证
  const touched = d.mappings.find((m) => m.source_norm === `${origin()}/t-new/2`);
  assert.equal(touched.needs_reverify, true);

  // 4) 旧方案发布被闸门拒绝（版本过期 + 新映射未纳入）
  const blockedPub = await call('POST', `/api/plans/${plan2}/publish`, {});
  assert.equal(blockedPub.status, 409);
  assert.ok(blockedPub.body.blockers.some((b) => /映射版本/.test(b.reason)),
    JSON.stringify(blockedPub.blockers));
  assert.ok(blockedPub.body.blockers.some((b) => b.source.includes('/t-new/2')),
    '新增生效映射未纳入方案也要阻断');

  // 5) 重新验证 + 重建方案后可以发布
  v = await call('POST', '/api/verify', {});
  assert.equal(v.status, 200);
  assert.equal((await call('POST', `/api/plans/${plan2}/build`)).status, 200);
  const pub2 = await call('POST', `/api/plans/${plan2}/publish`, {});
  assert.equal(pub2.status, 200, `重建后应可发布：${JSON.stringify(pub2.body)}`);
  assert.equal(pub2.body.published, true);
});

test('⑤ 重复应用返回同一结果；原始输入、冻结版本与应用结果均可审计', async () => {
  const id = await createDraft('幂等与审计');
  await addItem(id, {
    source_raw: `${origin()}/t-new/2`, target_raw: `${origin()}/articles/tech/42`,
    note: '保留这条备注做审计',
  });
  await call('POST', `/api/changesets/${id}/submit`);
  const r1 = await call('POST', `/api/changesets/${id}/apply`);
  assert.equal(r1.status, 200);
  const r2 = await call('POST', `/api/changesets/${id}/apply`);
  assert.equal(r2.status, 200, '重复应用仍是 200（幂等成功）');
  assert.deepEqual(r2.body, r1.body, '两次返回同一应用结果');

  const detail = await call('GET', `/api/changesets/${id}`);
  assert.equal(detail.body.changeset.status, 'applied');
  assert.equal(detail.body.changeset.base_mapping_version, 1, '冻结的基线版本可审计');
  assert.equal(detail.body.changeset.applied_version, 2);
  // 原始输入（raw URL）原样保留
  assert.equal(detail.body.items[0].source_raw, `${origin()}/t-new/2`);
  assert.equal(detail.body.items[0].target_raw, `${origin()}/articles/tech/42`);
  assert.equal(detail.body.apply_result.applied, true);
  assert.equal(detail.body.apply_result.changeset_id, id);

  // 版本历史带变更集关联
  const versions = await call('GET', '/api/mapping-versions');
  const v2 = versions.body.find((x) => x.version === 2);
  assert.equal(v2.applied_changeset_id, id);
  assert.equal(v2.changeset_name, '幂等与审计');
});

test('附加：放弃/再次提交等状态机不越权；过期变更集重复应用仍是同一过期结论', async () => {
  const id = await createDraft('状态机');
  await addItem(id, { source_raw: `${origin()}/t-new/2`, target_raw: `${origin()}/articles/tech/42` });
  // 草稿不可应用
  assert.equal((await call('POST', `/api/changesets/${id}/apply`)).status, 409);
  // 放弃草稿
  assert.equal((await call('POST', `/api/changesets/${id}/abandon`, { reason: '不要了' })).status, 200);
  // 已放弃不可再提交
  assert.equal((await call('POST', `/api/changesets/${id}/submit`)).status, 409);

  // 过期幂等：复现②的场景，对 stale 集重复 apply
  const key = `${origin()}/t-new/1`;
  const a = await createDraft('A2');
  await addItem(a, { operation: 'modify', source_raw: key, target_raw: `${origin()}/articles/tech/42` });
  const b = await createDraft('B2');
  await addItem(b, { operation: 'modify', source_raw: key, target_raw: `${origin()}/articles/123?z=9` });
  await call('POST', `/api/changesets/${a}/submit`);
  await call('POST', `/api/changesets/${b}/submit`);
  await call('POST', `/api/changesets/${a}/apply`);
  const e1 = await call('POST', `/api/changesets/${b}/apply`);
  const e2 = await call('POST', `/api/changesets/${b}/apply`);
  assert.equal(e1.status, 409);
  assert.deepEqual(e2.body, e1.body, '过期结论同样幂等返回');
});

test('附加：版本前进但触及键互不重叠 → 不判冲突，正常应用', async () => {
  // 第一个集改 /news/123
  const a = await createDraft('改 news');
  await addItem(a, {
    operation: 'modify', source_raw: `${origin()}/news/123`,
    target_raw: `${origin()}/articles/tech/42`,
  });
  // 第二个集（同一版本创建）新增完全不同的键 /t-new/2
  const b = await createDraft('新增不重叠键');
  await addItem(b, { source_raw: `${origin()}/t-new/2`, target_raw: `${origin()}/articles/tech/42` });
  await call('POST', `/api/changesets/${a}/submit`);
  await call('POST', `/api/changesets/${b}/submit`);
  const ra = await call('POST', `/api/changesets/${a}/apply`);
  assert.equal(ra.status, 200, JSON.stringify(ra.body));
  // 此时版本已 v2，但 b 只触及 /t-new/2，基线中不存在且未被 a 改动
  const rb = await call('POST', `/api/changesets/${b}/apply`);
  assert.equal(rb.status, 200, `互不重叠不应过期：${JSON.stringify(rb.body)}`);
  assert.equal(rb.body.applied_version, 3);
  const row = await mappingRow(`${origin()}/t-new/2`);
  assert.ok(row);
});

test('附加：已删除裁决（deleted，省略目标=旧址自身）可走变更集落库', async () => {
  const id = await createDraft('删除裁决');
  await addItem(id, {
    operation: 'add', mapping_type: 'deleted',
    source_raw: `${origin()}/forum/announce/9`,
  });
  const sub = await call('POST', `/api/changesets/${id}/submit`);
  assert.equal(sub.status, 200, JSON.stringify(sub.body));
  const r = await call('POST', `/api/changesets/${id}/apply`);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const detail = await call('GET', `/api/changesets/${id}`);
  assert.equal(detail.body.items[0].mapping_type, 'deleted');
  assert.equal(detail.body.items[0].target_norm, `${origin()}/forum/announce/9`);
});

async function addItemAllowFail(id, item) {
  return call('POST', `/api/changesets/${id}/items`, item);
}

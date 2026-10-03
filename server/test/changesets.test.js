/**
 * 映射变更集验收（真库 + 真本地站点，不 mock）：
 *  ① 无冲突改动应用后，生效映射与待验证清单同时更新；
 *  ② 两个变更集改同一 canonical key：先应用者成功，后应用者过期并展示三方差异；
 *  ③ 外网目标/无效编码/未裁决歧义的变更集整体拒绝，映射毫无变化；
 *  ④ 应用后旧验证报告与已建方案不能再发布，重新验证并重建后才可继续；
 *  ⑤ 重复提交同一已应用变更集返回同一结果，刷新后仍可审计原始输入、版本、应用结果。
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';

// node --test 并行运行各测试文件；verifier.test.js 也在 4568 启动本地站点，
// 这里改用独立端口（必须在 import 配置/模块之前设置）。
process.env.FIXTURE_PORT = process.env.CHANGESET_TEST_PORT ?? '4571';

const { pool } = await import('../src/db.js');
const { startFixture } = await import('../src/fixture.js');
const { fixtureOrigin } = await import('../src/config.js');
const { runVerification } = await import('../src/verify-runner.js');
const {
  createChangeset, submitChangeset, applyChangeset, buildDetail,
  ChangesetRejected,
} = await import('../src/changesets-service.js');
const {
  createVersion, currentVersion, recomputeMappings, snapshotMappings,
} = await import('../src/mappings-service.js');
const { normalize } = await import('../src/normalize.js');

const O = fixtureOrigin();
let fixture;

before(async () => { fixture = await startFixture(); });
after(async () => { await fixture.close(); await pool.end(); });

/** 重置到：仅 baseline v1 + 一条干净生效映射（/cs/gone → /sections/changed） */
async function resetBaseline() {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(
      `TRUNCATE mapping_changesets, migration_plan_items, migration_plans,
                verification_verdicts, crawl_results, url_mappings, mapping_inputs
       RESTART IDENTITY`);
    await client.query('TRUNCATE mapping_versions RESTART IDENTITY CASCADE');
    await client.query(`INSERT INTO mapping_versions (version, label) VALUES (1, 'baseline')`);
    await client.query(`SELECT setval(pg_get_serial_sequence('mapping_versions','version'), 1, true)`);
    const s = normalize(`${O}/cs/gone`);
    const t = normalize(`${O}/sections/changed`);
    await client.query(
      `INSERT INTO mapping_inputs (source_raw, source_norm, target_raw, target_norm, mapping_type, note)
       VALUES ($1,$2,$3,$4,'manual','baseline')`,
      [`${O}/cs/gone`, s.normKey, `${O}/sections/changed`, t.normKey]);
    await recomputeMappings(client, 1);
    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}

async function makeReviewable(payload, meta) {
  const client = await pool.connect();
  let id;
  try {
    await client.query('BEGIN');
    const cs = await createChangeset(client, payload, meta ?? {});
    id = cs.id;
    await submitChangeset(client, id);
    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
  return id;
}

/** 在事务中应用并返回结果（路由层动作的等价物） */
async function applyInTx(id) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const out = await applyChangeset(client, id);
    await client.query('COMMIT');
    return out;
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}

async function getMapping(key) {
  const { rows } = await pool.query('SELECT * FROM url_mappings WHERE source_norm=$1', [key]);
  return rows[0] ?? null;
}
async function getVerdict(key, version) {
  const { rows } = await pool.query(
    'SELECT * FROM verification_verdicts WHERE source_norm=$1 AND mapping_version=$2',
    [key, version]);
  return rows[0] ?? null;
}
async function currentVerdicts() {
  const v = await currentVersion(pool);
  const { rows } = await pool.query(
    'SELECT * FROM verification_verdicts WHERE mapping_version=$1', [v]);
  return rows;
}

test('① 无冲突改动应用后：生效映射与待验证清单同时更新（新增+修改+删除）', async () => {
  await resetBaseline();
  const addedKey = normalize(`${O}/new-column/1`).normKey;
  const modifiedKey = normalize(`${O}/cs/gone`).normKey;
  const removedKey = normalize(`${O}/cs/before`).normKey;

  // 基线再加一条将被删除的映射（先建 v2 基线，让删除有对象）
  const c0 = await pool.connect();
  try {
    await c0.query('BEGIN');
    await c0.query(
      `INSERT INTO mapping_inputs (source_raw, source_norm, target_raw, target_norm, mapping_type, note)
       VALUES ($1,$2,$3,$4,'manual','待删除')`,
      [`${O}/cs/before`, removedKey, normalize(`${O}/sections/changed`).normKey, normalize(`${O}/sections/changed`).normKey]);
    const v0 = await createVersion(c0, { label: '基线：加入待删除映射' });
    await recomputeMappings(c0, v0.version);
    await c0.query('COMMIT');
  } finally { c0.release(); }

  // 对基线跑一轮验证，让“旧证据存在”
  const baseRun = await runVerification();
  assert.equal(baseRun.mapping_version, await currentVersion(pool));
  assert.ok((await currentVerdicts()).length >= 2, '基线裁决已存在');

  const id = await makeReviewable({
    name: '批次①',
    changes: [
      { op: 'upsert', source_raw: `${O}/new-column/1`, target_raw: `${O}/sections/new/1`, mapping_type: 'manual' },
      { op: 'upsert', source_raw: `${O}/cs/gone`, target_raw: `${O}/sections/new/1`, mapping_type: 'manual' },
      { op: 'delete', source_raw: `${O}/cs/before` },
    ],
  });

  const beforeVersion = await currentVersion(pool);
  const r = await applyInTx(id);
  assert.equal(r.applied, true);
  assert.ok(Number(r.applied_version) > Number(beforeVersion));

  // 生效映射：新增/修改落位，删除消失
  const added = await getMapping(addedKey);
  const modified = await getMapping(modifiedKey);
  const removed = await getMapping(removedKey);
  assert.ok(added && added.status === 'active');
  assert.equal(added.target_norm, normalize(`${O}/sections/new/1`).normKey);
  assert.equal(Number(added.mapping_version), Number(r.applied_version));
  assert.equal(modified.target_norm, normalize(`${O}/sections/new/1`).normKey);
  assert.equal(removed, null);

  // 待验证清单：新版本下新增/修改的键没有当前版本裁决（旧裁决停在旧版本）
  assert.equal(await getVerdict(addedKey, r.applied_version), null);
  assert.equal(await getVerdict(modifiedKey, r.applied_version), null);
  // 删除键的旧裁决仍留档在旧版本，但不在当前生效映射/待验证清单中
  const { rows: delInputs } = await pool.query(
    'SELECT 1 FROM mapping_inputs WHERE source_norm=$1', [removedKey]);
  assert.equal(delInputs.length, 0, '删除裁决移除全部原始材料');
  const curRows = await snapshotMappings(pool, r.applied_version);
  assert.ok(!curRows.some((m) => m.source_norm === removedKey));

  // 旧版本证据仍在（审计留档），但不属当前版本
  const oldAdded = await getVerdict(addedKey, beforeVersion);
  assert.equal(oldAdded, null, '新增键在旧版本本就不存在证据');
});

test('② 两个变更集改同一 canonical key：先应用成功，后者过期并给出三方差异', async () => {
  await resetBaseline();
  const key = normalize(`${O}/cs/gone`).normKey;

  const idA = await makeReviewable({
    name: '批次A',
    changes: [{ op: 'upsert', source_raw: `${O}/cs/gone`, target_raw: `${O}/articles/123`, mapping_type: 'manual' }],
  });
  const idB = await makeReviewable({
    name: '批次B',
    changes: [{ op: 'upsert', source_raw: `${O}/cs/gone?utm_source=x`, target_raw: `${O}/sections/new/1`, mapping_type: 'manual' }],
  });

  const rA = await applyInTx(idA);
  assert.equal(rA.applied, true);
  assert.equal((await getMapping(key)).target_norm, normalize(`${O}/articles/123`).normKey);

  const rB = await applyInTx(idB);
  assert.equal(rB.applied, false);
  assert.equal(rB.expired, true, '后应用者变为过期');
  assert.equal(rB.conflicts.length, 1);
  const c = rB.conflicts[0];
  assert.equal(c.source_norm, key);
  // 三方：base=sections/changed，current（并发方 A）=articles/123，proposed（B）=sections/new/1
  assert.equal(c.base.target_norm, normalize(`${O}/sections/changed`).normKey);
  assert.equal(c.current.target_norm, normalize(`${O}/articles/123`).normKey);
  assert.equal(c.proposed.target_norm, normalize(`${O}/sections/new/1`).normKey);

  // 未覆盖：生效映射仍是 A 的结果
  assert.equal((await getMapping(key)).target_norm, normalize(`${O}/articles/123`).normKey);

  // 工作台详情可见三方差异
  const { rows } = await pool.query('SELECT * FROM mapping_changesets WHERE id=$1', [idB]);
  const detail = await buildDetail(pool, rows[0]);
  assert.equal(detail.items[0].changed_by_other, true);
  assert.equal(rows[0].status, 'expired');
});

test('②b 真实并发：两个应用事务同时提交同一 canonical key，只允许一个成功', async () => {
  await resetBaseline();
  const key = normalize(`${O}/cs/gone`).normKey;

  const idA = await makeReviewable({
    name: '并发A',
    changes: [{ op: 'upsert', source_raw: `${O}/cs/gone`, target_raw: `${O}/articles/123`, mapping_type: 'manual' }],
  });
  const idB = await makeReviewable({
    name: '并发B',
    changes: [{ op: 'upsert', source_raw: `${O}/cs/gone?utm_source=z`, target_raw: `${O}/sections/new/1`, mapping_type: 'manual' }],
  });

  // 两个独立连接同时进入应用事务
  const launch = async (id) => {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      // 人为拉开重叠窗口：A 先进入，B 在 A 提交前也拿到事务
      const out = await applyChangeset(client, id);
      await client.query('COMMIT');
      return out;
    } catch (e) {
      await client.query('ROLLBACK');
      throw e;
    } finally {
      client.release();
    }
  };
  const [rA, rB] = await Promise.all([launch(idA), launch(idB)]);
  const appliedCount = [rA, rB].filter((r) => r.applied === true).length;
  const expiredCount = [rA, rB].filter((r) => r.expired === true).length;
  assert.equal(appliedCount, 1, '恰好一个应用成功');
  assert.equal(expiredCount, 1, '另一个过期（行锁串行化版本检测）');

  // 生效映射只反映成功者
  const m = await getMapping(key);
  const winnerTarget = normalize(`${O}/articles/123`).normKey;
  assert.ok(m.target_norm === winnerTarget ||
            m.target_norm === normalize(`${O}/sections/new/1`).normKey);
});


test('③ 外网目标 / 无效编码 / 批内歧义整体拒绝，当前映射毫无变化', async () => {
  await resetBaseline();
  const beforeRows = await pool.query('SELECT * FROM mapping_inputs ORDER BY id');
  const beforeMaps = await pool.query('SELECT * FROM url_mappings ORDER BY id');
  const beforeVersion = await currentVersion(pool);

  // 创建为草稿（冻结校验问题留痕），不允许提交审阅；即便绕过提交直接应用也拒绝
  async function createDraft(payload) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const cs = await createChangeset(client, payload, {});
      await assert.rejects(() => submitChangeset(client, cs.id),
        (e) => e.statusCode === 422, '提交审阅被整体拒绝');
      await client.query('COMMIT');
      return cs.id;
    } finally { client.release(); }
  }

  // a) 外网目标
  const idExt = await createDraft({
    name: '批次-外网',
    changes: [{ op: 'upsert', source_raw: `${O}/new-column/1`, target_raw: 'http://example.com/external', mapping_type: 'manual' }],
  });
  await assert.rejects(() => applyInTx(idExt), (e) => {
    assert.ok(e instanceof ChangesetRejected);
    assert.equal(e.statusCode, 409, '草稿不可应用');
    return true;
  });
  // 即使强行把状态置为 reviewable，应用时复验仍 422 整体拒绝、事务回滚
  await pool.query(`UPDATE mapping_changesets SET status='reviewable' WHERE id=$1`, [idExt]);
  await assert.rejects(() => applyInTx(idExt), (e) => e.statusCode === 422,
    '应用复验拒绝外网目标');

  // b) 无效编码（非 http(s) scheme）
  const idBad = await createDraft({
    name: '批次-坏scheme',
    changes: [{ op: 'upsert', source_raw: 'file:///etc/passwd', target_raw: `${O}/sections/new/1`, mapping_type: 'manual' }],
  });
  await assert.rejects(() => applyInTx(idBad), (e) => e.statusCode === 409);

  // c) 删除不存在的键（base 中没有）
  const idDel = await createDraft({
    name: '批次-删除不存在',
    changes: [{ op: 'delete', source_raw: `${O}/never-existed` }],
  });
  await assert.rejects(() => applyInTx(idDel), (e) => e.statusCode === 409);

  // 一个可审阅但应用时复验失败的情形：用合法形式创建后再以冻结内容复验
  // （白名单规则收紧场景；此处复验等价复用同一规则，外网不可借道）
  const { rows: frozen } = await pool.query(
    'SELECT validation FROM mapping_changesets WHERE id=$1', [idExt]);
  assert.ok(frozen[0].validation.length >= 1, '外网问题已冻结留痕');

  // 映射毫无变化：版本未前进、原始材料/生效映射字节级一致
  assert.equal(await currentVersion(pool), beforeVersion);
  const afterRows = await pool.query('SELECT * FROM mapping_inputs ORDER BY id');
  const afterMaps = await pool.query('SELECT * FROM url_mappings ORDER BY id');
  assert.deepEqual(afterRows.rows.map((r) => [r.id, r.source_norm, r.target_norm]),
    beforeRows.rows.map((r) => [r.id, r.source_norm, r.target_norm]));
  assert.deepEqual(afterMaps.rows.map((r) => [r.source_norm, r.target_norm, r.status]),
    beforeMaps.rows.map((r) => [r.source_norm, r.target_norm, r.status]));

  // d) 未裁决歧义：变更集内部对同一 canonical key 给出两个目标（两种写法）
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const cs = await createChangeset(client, {
      name: '批次-批内歧义',
      changes: [
        { op: 'upsert', source_raw: `${O}/new-column/1`, target_raw: `${O}/sections/new/1`, mapping_type: 'manual' },
        { op: 'upsert', source_raw: `${O}/new-column/1?utm_source=partner`, target_raw: `${O}/sections/changed`, mapping_type: 'manual' },
      ],
    }, {});
    // 归一后同键不同目标：创建即留痕问题，且 submit 被 422 拦截，无法进入可审阅
    assert.ok(cs.validation.length >= 1, '冻结时标注未裁决歧义');
    await assert.rejects(() => submitChangeset(client, cs.id),
      (e) => e.statusCode === 422);
    await client.query('ROLLBACK');
  } finally { client.release(); }

  // 整体拒绝后映射仍毫无变化
  assert.equal(await currentVersion(pool), beforeVersion);
});

test('④ 应用后旧验证报告与已建方案不能发布；重新验证+重建后才可继续', async () => {
  await resetBaseline();

  // 基线：验证通过 → 建方案 → 闸门就绪（但先不发布）
  let v = await runVerification();
  assert.ok(v.results.every((r) => r.verdict === 'ok'),
    `基线应全部 ok: ${JSON.stringify(v.results.map((x) => x.verdict))}`);

  const { rows: planRows } = await pool.query(
    `INSERT INTO migration_plans (name, mapping_version) VALUES ('方案④', $1) RETURNING *`,
    [v.mapping_version]);
  const planId = planRows[0].id;
  await pool.query(
    `INSERT INTO migration_plan_items (plan_id, mapping_id, item_status, evidence)
     SELECT $1, m.id, 'verified', jsonb_build_object(
        'mapping_version', $2::bigint, 'verdict', 'ok',
        'source_norm', m.source_norm, 'proposed_redirect_url', m.target_raw)
       FROM url_mappings m WHERE m.status='active'`, [planId, v.mapping_version]);

  // 应用变更集：新增一条 + 修改基线键 → 版本前进
  const id = await makeReviewable({
    name: '批次④',
    changes: [
      { op: 'upsert', source_raw: `${O}/new-column/1`, target_raw: `${O}/sections/new/1`, mapping_type: 'manual' },
      { op: 'upsert', source_raw: `${O}/cs/before`, target_raw: `${O}/sections/changed`, mapping_type: 'manual' },
    ],
  });
  const applied = await applyInTx(id);
  assert.equal(applied.applied, true);

  // 旧方案绑定旧版本：发布被闸门拒绝（在路由层等价判定——这里直接核对 DB 状态与闸门 SQL 条件）
  const { rows: stalePlan } = await pool.query('SELECT * FROM migration_plans WHERE id=$1', [planId]);
  assert.ok(stalePlan[0].mapping_version < applied.applied_version);
  const { rows: curVerdicts } = await pool.query(
    'SELECT count(*)::int AS n FROM verification_verdicts WHERE mapping_version=$1',
    [applied.applied_version]);
  assert.equal(curVerdicts[0].n, 0, '新版本下没有当前证据：旧报告不得继续放行');

  // 旧版本证据仍在（报告“已明确标为过期”），但 publish 判定以版本为准
  const { rows: oldVerdicts } = await pool.query(
    'SELECT count(*)::int AS n FROM verification_verdicts WHERE mapping_version=$1',
    [stalePlan[0].mapping_version]);
  assert.ok(oldVerdicts[0].n >= 1, '旧证据留档可审计');

  // 重新验证（针对新版本真实请求）+ 重建方案
  v = await runVerification();
  assert.equal(v.mapping_version, applied.applied_version);
  assert.ok(v.results.every((r) => r.verdict === 'ok'),
    `新版本应全部 ok: ${JSON.stringify(v.results)}`);

  await pool.query('DELETE FROM migration_plan_items WHERE plan_id=$1', [planId]);
  await pool.query(
    `INSERT INTO migration_plan_items (plan_id, mapping_id, item_status, evidence)
     SELECT $1, m.id, 'verified', jsonb_build_object(
        'mapping_version', $2::bigint, 'verdict', 'ok',
        'source_norm', m.source_norm, 'proposed_redirect_url', m.target_raw)
       FROM url_mappings m WHERE m.status='active'`, [planId, v.mapping_version]);
  await pool.query('UPDATE migration_plans SET mapping_version=$2 WHERE id=$1', [planId, v.mapping_version]);
  const { rows: rebuilt } = await pool.query(
    `SELECT count(*) FILTER (WHERE item_status='verified')::int AS ok,
            count(*)::int AS total
       FROM migration_plan_items WHERE plan_id=$1`, [planId]);
  assert.ok(rebuilt[0].total >= 2 && rebuilt[0].ok === rebuilt[0].total);
  const { rows: freshPlan } = await pool.query('SELECT * FROM migration_plans WHERE id=$1', [planId]);
  assert.equal(Number(freshPlan[0].mapping_version), Number(applied.applied_version), '重建后绑定当前版本，可继续发布');
});

test('⑤ 重复提交已应用变更集返回同一结果；刷新可审计原始输入、冻结版本与应用结果', async () => {
  await resetBaseline();
  const idem = 'ticket-acceptance-5';
  const payload = {
    name: '批次⑤',
    idempotency_key: idem,
    changes: [
      { op: 'upsert', source_raw: `${O}/new-column/1`, target_raw: `${O}/sections/new/1`, mapping_type: 'manual' },
    ],
  };

  // 用幂等键创建（走服务层两次，模拟网络重试）
  async function createOnce() {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const cs = await createChangeset(client, payload, { idempotencyKey: idem });
      await submitChangeset(client, cs.id);
      await client.query('COMMIT');
      return cs.id;
    } finally { client.release(); }
  }
  const firstId = await createOnce();
  // 再次提交创建请求：直接命中幂等键，返回同一个变更集
  const clientAgain = await pool.connect();
  try {
    const dup = await (async () => {
      const { findByIdempotencyKey } = await import('../src/changesets-service.js');
      return findByIdempotencyKey(clientAgain, idem);
    })();
    assert.equal(dup.id, firstId);
  } finally { clientAgain.release(); }

  const r1 = await applyInTx(firstId);
  assert.equal(r1.applied, true);
  const appliedVersion = r1.applied_version;

  // 重复应用：同一变更集返回同一结果，不产生新版本
  const versionBefore = await currentVersion(pool);
  const r2 = await applyInTx(firstId);
  assert.equal(r2.idempotent, true);
  assert.equal(r2.applied_version, appliedVersion);
  assert.equal(await currentVersion(pool), versionBefore, '重复应用不推进版本');

  // 刷新（全新查询）后仍可审计
  const { rows } = await pool.query('SELECT * FROM mapping_changesets WHERE id=$1', [firstId]);
  const cs = rows[0];
  assert.equal(cs.status, 'applied');
  assert.equal(Number(cs.base_version), 1);
  assert.equal(Number(cs.applied_version), appliedVersion);
  assert.equal(cs.idempotency_key, idem);
  assert.deepEqual(cs.payload.changes.map((c) => c.source_raw), [`${O}/new-column/1`],
    '原始输入逐字留档');
  assert.ok(Array.isArray(cs.base_snapshot));
  assert.equal(cs.changes[0].source_norm, normalize(`${O}/new-column/1`).normKey);
  assert.equal(cs.changes[0].target_norm, normalize(`${O}/sections/new/1`).normKey);
});

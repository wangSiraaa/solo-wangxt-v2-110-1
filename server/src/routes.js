/** REST API：映射录入、规范化试算、验证、映射变更集、迁移方案与发布闸门。 */
import { pool } from './db.js';
import { normalize, strictNormalize, isLocalOrigin, carryTrackers, splitQuery } from './normalize.js';
import { commitMappingChange, getCurrentVersion } from './mappings-service.js';
import {
  listChangesets, getChangeset, createChangeset, addChangesetItem,
  removeChangesetItem, submitChangeset, applyChangeset, abandonChangeset,
  listVersions, STATUS_LABEL as CHANGESET_STATUS,
} from './changesets-service.js';
import { runVerification, VERDICT_LABEL } from './verify-runner.js';
import { config } from './config.js';

/** 把服务层抛出的带 statusCode 的业务错误转成 HTTP 响应 */
function sendServiceError(reply, e) {
  if (e.statusCode) {
    return reply.code(e.statusCode).send({
      error: e.message,
      code: e.code,
      rejected: e.rejected,
      apply_result: e.apply_result,
    });
  }
  throw e;
}

export default async function api(app) {
  app.get('/api/health', async () => ({ ok: true, fixture: `127.0.0.1:${config.fixture.port}` }));

  app.get('/api/rules', async () => config.rules);

  // 规范化试算（不写库）：展示大小写/编码/尾斜杠/查询参数如何处理
  app.post('/api/normalize', async (req) => {
    const { urls } = req.body ?? {};
    if (!Array.isArray(urls)) {
      return app.httpErrors?.badRequest?.('urls[] required') ?? { error: 'urls[] required' };
    }
    return urls.map((u) => {
      const strict = strictNormalize(String(u));
      if (!strict.ok) return { input: u, ok: false, error: strict.error };
      const { trackers } = splitQuery(new URL(u).search);
      return {
        input: u, ok: true,
        norm_key: strict.normKey,
        pathname: strict.pathname,
        identity_query: strict.identityQuery,
        tracker_params: [...trackers.keys()],
        is_local_origin: isLocalOrigin(strict),
      };
    });
  });

  // 全量材料：原始输入 + 生效映射 + 最新裁决（含版本与过期标记）
  app.get('/api/mappings', async () => {
    const version = await getCurrentVersion(pool);
    const { rows: inputs } = await pool.query(
      `SELECT i.*, m.mapping_version, m.status AS mapping_status,
              v.verdict, v.issues, v.final_status, v.final_url_raw, v.hops,
              v.tracker_preserved, v.verified_at, v.mapping_version AS verdict_version,
              v.stale AS verdict_stale,
              (v.mapping_version < m.mapping_version OR v.stale) AS needs_reverify
         FROM mapping_inputs i
         LEFT JOIN url_mappings m ON m.source_norm = i.source_norm
         LEFT JOIN verification_verdicts v ON v.source_norm = i.source_norm
        ORDER BY i.id`);
    const { rows: mappings } = await pool.query(
      `SELECT m.*,
              v.verdict, v.stale AS verdict_stale,
              (v.verdict IS NULL OR v.stale OR v.mapping_version < m.mapping_version) AS needs_reverify
         FROM url_mappings m
         LEFT JOIN verification_verdicts v ON v.source_norm=m.source_norm
        ORDER BY m.id`);
    for (const m of mappings) {
      m.mapping_version = Number(m.mapping_version);
      m.verdict_version = m.verdict_version != null ? Number(m.verdict_version) : null;
    }
    for (const i of inputs) {
      i.verdict_version = i.verdict_version != null ? Number(i.verdict_version) : null;
    }
    const { rows: ambiguities } = await pool.query('SELECT * FROM mapping_ambiguities ORDER BY source_norm');
    return {
      inputs, mappings, ambiguities,
      mapping_version: version,
      verdictLabel: VERDICT_LABEL,
    };
  });

  // 直接录入一条原始映射（保留兼容入口）：同样经过版本化提交 ——
  // 与变更集应用互斥，改动后旧证据/旧方案立即标过期。
  app.post('/api/mappings', async (req, reply) => {
    const { source_raw, target_raw, mapping_type = 'manual', note } = req.body ?? {};
    const s = strictNormalize(String(source_raw ?? ''));
    if (!s.ok) return reply.code(400).send({ error: `source: ${s.error}` });
    const t = strictNormalize(String(target_raw ?? ''));
    if (!t.ok) return reply.code(400).send({ error: `target: ${t.error}` });
    if (!isLocalOrigin(t)) {
      return reply.code(400).send({ error: `target: ${target_raw} 不在本地站点白名单内` });
    }

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(
        `INSERT INTO mapping_inputs (source_raw, source_norm, target_raw, target_norm, mapping_type, note)
         VALUES ($1,$2,$3,$4,$5,$6)`,
        [source_raw, s.normKey, target_raw, t.normKey, mapping_type, note ?? null]);
      const r = await commitMappingChange(client, { note: '直接录入（兼容入口）' });
      await client.query('COMMIT');
      return {
        ok: true, source_norm: s.normKey, target_norm: t.normKey,
        mapping_version: r.newVersion, changed: r.versionMoved,
      };
    } catch (e) {
      await client.query('ROLLBACK');
      throw e;
    } finally {
      client.release();
    }
  });

  app.post('/api/verify', async (req) => {
    const onlyKey = req.body?.source_norm ?? null;
    return runVerification({ onlyKey });
  });

  app.get('/api/crawl/:key', async (req, reply) => {
    const key = decodeURIComponent(req.params.key);
    const { rows } = await pool.query(
      'SELECT * FROM crawl_results WHERE source_norm=$1 ORDER BY hop_index', [key]);
    if (!rows.length) return reply.code(404).send({ error: 'no crawl evidence; run verification first' });
    return rows;
  });

  // ---- 映射版本与变更集 ----------------------------------------------

  app.get('/api/mapping-versions', async () => listVersions());

  app.get('/api/changesets', async () => listChangesets());

  app.post('/api/changesets', async (req, reply) => {
    try {
      return await createChangeset({
        name: req.body?.name,
        description: req.body?.description,
        createdBy: req.body?.created_by,
      });
    } catch (e) { return sendServiceError(reply, e); }
  });

  app.get('/api/changesets/:id', async (req, reply) => {
    try { return await getChangeset(Number(req.params.id)); }
    catch (e) { return sendServiceError(reply, e); }
  });

  // 往草稿里加/改一条原始 URL 改动（operation=remove 时可省略 target）
  app.post('/api/changesets/:id/items', async (req, reply) => {
    try {
      return await addChangesetItem(Number(req.params.id), req.body ?? {});
    } catch (e) { return sendServiceError(reply, e); }
  });

  app.delete('/api/changesets/:id/items/:itemId', async (req, reply) => {
    try {
      return await removeChangesetItem(Number(req.params.id), Number(req.params.itemId));
    } catch (e) { return sendServiceError(reply, e); }
  });

  // 草稿 → 可审阅：整组校验（非法编码/外网目标/未裁决歧义全部在此拒绝）
  app.post('/api/changesets/:id/submit', async (req, reply) => {
    try { return await submitChangeset(Number(req.params.id)); }
    catch (e) { return sendServiceError(reply, e); }
  });

  // 可审阅 → 已应用 / 已过期：单事务冲突检测 + 重算 + 版本推进
  app.post('/api/changesets/:id/apply', async (req, reply) => {
    try {
      const r = await applyChangeset(Number(req.params.id));
      if (r.status === 'stale') return reply.code(409).send(r.apply_result);
      if (r.status === 'in_review') return reply.code(422).send(r.apply_result);
      return r.apply_result;
    } catch (e) { return sendServiceError(reply, e); }
  });

  app.post('/api/changesets/:id/abandon', async (req, reply) => {
    try { return await abandonChangeset(Number(req.params.id), req.body?.reason); }
    catch (e) { return sendServiceError(reply, e); }
  });

  // ---- 迁移方案 -------------------------------------------------------

  app.get('/api/plans', async () => {
    const { rows } = await pool.query(
      `SELECT p.*,
              count(pi.id) AS items,
              count(pi.id) FILTER (WHERE pi.item_status='verified') AS verified,
              count(pi.id) FILTER (WHERE pi.item_status='blocked')  AS blocked,
              count(pi.id) FILTER (WHERE pi.item_status='pending') AS pending
         FROM migration_plans p
         LEFT JOIN migration_plan_items pi ON pi.plan_id=p.id
        GROUP BY p.id ORDER BY p.id`);
    return rows;
  });

  app.post('/api/plans', async (req, reply) => {
    const name = String(req.body?.name ?? '').trim();
    if (!name) return reply.code(400).send({ error: 'name required' });
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const version = await getCurrentVersion(client);
      const { rows } = await client.query(
        `INSERT INTO migration_plans (name, base_mapping_version) VALUES ($1,$2)
         RETURNING *`, [name, version]);
      await client.query('COMMIT');
      return rows[0];
    } catch (e) {
      await client.query('ROLLBACK');
      if (e.code === '23505') return reply.code(409).send({ error: 'plan name exists' });
      throw e;
    } finally {
      client.release();
    }
  });

  // 把全部 active 映射纳入方案，并按最新裁决设置条目状态；冻结当前映射版本
  app.post('/api/plans/:id/build', async (req, reply) => {
    const planId = Number(req.params.id);
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const { rows: plan } = await client.query('SELECT * FROM migration_plans WHERE id=$1', [planId]);
      if (!plan.length) { await client.query('ROLLBACK'); return reply.code(404).send({ error: 'plan not found' }); }
      if (plan[0].status === 'published') {
        await client.query('ROLLBACK');
        return reply.code(409).send({ error: '已发布方案不可改' });
      }
      await client.query('DELETE FROM migration_plan_items WHERE plan_id=$1', [planId]);

      const currentVersion = await getCurrentVersion(client);
      const { rows: ms } = await client.query(
        `SELECT m.*, v.verdict, v.issues, v.final_status, v.final_url_raw,
                v.final_url_norm, v.hops, v.tracker_preserved,
                v.mapping_version AS verdict_version, v.stale AS verdict_stale
           FROM url_mappings m
           LEFT JOIN verification_verdicts v ON v.source_norm=m.source_norm
          WHERE m.status='active' ORDER BY m.id`);
      for (const m of ms) {
        // 证据必须针对当前映射版本：过期/缺失裁决一律不能算 verified
        const fresh = !m.verdict_stale
          && Number(m.verdict_version) === Number(m.mapping_version)
          && (m.verdict === 'ok' || m.verdict === 'deleted_gone_ok');
        // 计划中的最终跳转 URL：携带追踪参数的示例（取首次输入的参数）
        const { rows: ins } = await client.query(
          'SELECT source_raw FROM mapping_inputs WHERE source_norm=$1 ORDER BY id LIMIT 1',
          [m.source_norm]);
        const proposed = m.mapping_type === 'deleted'
          ? null
          : carryTrackers(ins[0].source_raw, m.target_raw);
        await client.query(
          `INSERT INTO migration_plan_items
             (plan_id, mapping_id, item_status, evidence,
              source_raw, source_norm, target_raw, target_norm, mapping_type)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
          [planId, m.id,
           fresh ? 'verified' : m.verdict ? 'blocked' : 'pending',
           JSON.stringify({
             verdict: m.verdict ?? null,
             issues: m.issues ?? [],
             final_status: m.final_status ?? null,
             final_url: m.final_url_raw ?? null,
             hops: m.hops ?? 0,
             tracker_preserved: m.tracker_preserved ?? null,
             proposed_redirect_url: proposed,
             mapping_version: Number(m.mapping_version),
             evidence_version: m.verdict_version != null ? Number(m.verdict_version) : null,
             evidence_stale: m.verdict_stale ?? true,
           }),
           m.source_raw, m.source_norm, m.target_raw, m.target_norm, m.mapping_type]);
      }
      await client.query(
        `UPDATE migration_plans
            SET base_mapping_version=$2, stale=false
          WHERE id=$1`,
        [planId, currentVersion]);
      await client.query('COMMIT');
      return { built: ms.length, mapping_version: currentVersion };
    } finally {
      client.release();
    }
  });

  app.get('/api/plans/:id', async (req, reply) => {
    const { rows: plans } = await pool.query('SELECT * FROM migration_plans WHERE id=$1', [req.params.id]);
    if (!plans.length) return reply.code(404).send({ error: 'not found' });
    const currentVersion = await getCurrentVersion(pool);
    // 优先用条目自身快照：映射后来被删除/替换时，过期方案仍完整可审计
    const { rows: items } = await pool.query(
      `SELECT pi.*,
              COALESCE(pi.source_raw, m.source_raw)   AS source_raw,
              COALESCE(pi.source_norm, m.source_norm) AS source_norm,
              COALESCE(pi.target_raw, m.target_raw)   AS target_raw,
              COALESCE(pi.target_norm, m.target_norm) AS target_norm,
              COALESCE(pi.mapping_type, m.mapping_type) AS mapping_type
         FROM migration_plan_items pi
         LEFT JOIN url_mappings m ON m.id=pi.mapping_id
        WHERE pi.plan_id=$1 ORDER BY pi.id`, [req.params.id]);
    return {
      plan: plans[0],
      current_mapping_version: currentVersion,
      stale: plans[0].stale || Number(plans[0].base_mapping_version) < currentVersion,
      items,
    };
  });

  /**
   * 发布闸门：
   *  - 方案自身未过期（base_mapping_version 等于当前映射版本、stale=false）；
   *  - 不存在 blocked/pending 条目（每条都必须有针对当前版本的成功证据）；
   *  - 不存在未纳入方案的 active 映射；
   *  - 不存在 conflicted 映射。
   * 任何一条不满足都拒绝发布并列出受影响链接。
   */
  app.post('/api/plans/:id/publish', async (req, reply) => {
    const planId = Number(req.params.id);
    const blockers = [];

    const { rows: plan } = await pool.query('SELECT * FROM migration_plans WHERE id=$1', [planId]);
    if (!plan.length) return reply.code(404).send({ error: 'not found' });
    if (plan[0].status === 'published') {
      return { alreadyPublished: true, plan: plan[0] };
    }

    const currentVersion = await getCurrentVersion(pool);
    if (plan[0].stale || Number(plan[0].base_mapping_version) < currentVersion) {
      blockers.push({
        source: `（方案 #${planId}）`,
        reason: `方案基于映射版本 ${plan[0].base_mapping_version}，`
          + `当前已为版本 ${currentVersion}：旧验证证据已过期，必须重新验证并重建方案`,
      });
    }

    const { rows: badItems } = await pool.query(
      `SELECT pi.source_raw, pi.item_status, pi.evidence
         FROM migration_plan_items pi
        WHERE pi.plan_id=$1 AND pi.item_status <> 'verified'`, [planId]);
    for (const b of badItems) {
      blockers.push({
        source: b.source_raw ?? `（已删除的映射条目）`,
        reason: b.item_status === 'pending'
          ? '只有映射表条目，没有针对当前版本的验证证据（填表不等于迁移完成）'
          : b.evidence?.evidence_stale
            ? `验证证据基于旧映射版本（v${b.evidence.evidence_version ?? '?'}），已过期：请重新验证后重建方案`
            : `验证未通过：${(b.evidence?.issues ?? []).join('；') || b.evidence?.verdict}`,
      });
    }

    const { rows: missing } = await pool.query(
      `SELECT m.source_raw FROM url_mappings m
        WHERE m.status='active'
          AND NOT EXISTS (SELECT 1 FROM migration_plan_items pi
                           WHERE pi.mapping_id=m.id AND pi.plan_id=$1)`,
      [planId]);
    missing.forEach((m) => blockers.push({ source: m.source_raw, reason: '生效映射未纳入方案' }));

    const { rows: conflicts } = await pool.query('SELECT source_raw FROM url_mappings WHERE status=$1', ['conflicted']);
    conflicts.forEach((m) => blockers.push({ source: m.source_raw, reason: '归一化歧义未裁决' }));

    if (blockers.length) {
      return reply.code(409).send({ published: false, blockers });
    }

    const { rows } = await pool.query(
      `UPDATE migration_plans SET status='published', published_at=now()
        WHERE id=$1 RETURNING *`, [planId]);
    return { published: true, plan: rows[0] };
  });

  app.get('/api/changeset-status-label', async () => CHANGESET_STATUS);
}

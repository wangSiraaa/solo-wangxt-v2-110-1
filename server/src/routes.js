/** REST API：映射录入、映射变更集、规范化试算、验证、迁移方案与发布闸门。 */
import { pool } from './db.js';
import { normalize, carryTrackers, splitQuery } from './normalize.js';
import {
  recomputeMappings, currentVersion, createVersion,
} from './mappings-service.js';
import {
  createChangeset, findByIdempotencyKey, submitChangeset,
  applyChangeset, abandonChangeset, buildDetail, ChangesetRejected,
} from './changesets-service.js';
import { runVerification, VERDICT_LABEL } from './verify-runner.js';
import { config } from './config.js';

export default async function api(app) {
  app.get('/api/health', async () => ({ ok: true, fixture: `127.0.0.1:${config.fixture.port}` }));

  app.get('/api/rules', async () => config.rules);

  // 映射版本线（变更集历史/证据绑定的依据）
  app.get('/api/versions', async () => {
    const { rows } = await pool.query(
      `SELECT v.version, v.label, v.changeset_id, v.created_at,
              c.name AS changeset_name, c.status AS changeset_status
         FROM mapping_versions v
         LEFT JOIN mapping_changesets c ON c.id = v.changeset_id
        ORDER BY v.version`);
    return { current: await currentVersion(pool), versions: rows };
  });

  // 规范化试算（不写库）：展示大小写/编码/尾斜杠/查询参数如何处理
  app.post('/api/normalize', async (req) => {
    const { urls } = req.body ?? {};
    if (!Array.isArray(urls)) {
      return app.httpErrors?.badRequest?.('urls[] required') ?? { error: 'urls[] required' };
    }
    return urls.map((u) => {
      const r = normalize(String(u));
      if (!r.ok) return { input: u, ok: false, error: r.error };
      const { trackers } = splitQuery(new URL(u).search);
      return {
        input: u, ok: true,
        norm_key: r.normKey,
        pathname: r.pathname,
        identity_query: r.identityQuery,
        tracker_params: [...trackers.keys()],
      };
    });
  });

  // 全量材料：原始输入 + 生效映射 + 最新裁决 + 版本/过期证据信息
  app.get('/api/mappings', async () => {
    const version = await currentVersion(pool);
    const { rows: inputs } = await pool.query(
      `SELECT i.*,
              v.verdict, v.issues, v.final_status, v.final_url_raw, v.hops,
              v.tracker_preserved, v.verified_at,
              v.mapping_version AS verdict_version,
              (SELECT v2.mapping_version FROM verification_verdicts v2
                WHERE v2.source_norm = i.source_norm AND v2.mapping_version < $1
                ORDER BY v2.mapping_version DESC LIMIT 1) AS stale_evidence_version
         FROM mapping_inputs i
         LEFT JOIN verification_verdicts v
           ON v.source_norm = i.source_norm AND v.mapping_version = $1
        ORDER BY i.id`, [version]);
    const { rows: mappings } = await pool.query('SELECT * FROM url_mappings ORDER BY id');
    const { rows: ambiguities } = await pool.query('SELECT * FROM mapping_ambiguities ORDER BY source_norm');
    const { rows: staleCount } = await pool.query(
      'SELECT count(DISTINCT source_norm)::int AS n FROM verification_verdicts WHERE mapping_version < $1',
      [version]);
    return {
      inputs, mappings, ambiguities, verdictLabel: VERDICT_LABEL,
      current_version: version,
      stale_evidence_keys: staleCount[0].n,
    };
  });

  // 录入一条原始映射（直接通道）：只进 mapping_inputs；随后推进版本并重算。
  // 注意：临近发布的批量修改应走 /api/changesets（冻结版本、可审阅、防并发覆盖）。
  app.post('/api/mappings', async (req, reply) => {
    const { source_raw, target_raw, mapping_type = 'manual', note } = req.body ?? {};
    const s = normalize(String(source_raw ?? ''));
    const t = normalize(String(target_raw ?? ''));
    if (!s.ok) return reply.code(400).send({ error: `source: ${s.error}` });
    if (!t.ok) return reply.code(400).send({ error: `target: ${t.error}` });

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(
        `INSERT INTO mapping_inputs (source_raw, source_norm, target_raw, target_norm, mapping_type, note)
         VALUES ($1,$2,$3,$4,$5,$6)`,
        [source_raw, s.normKey, target_raw, t.normKey, mapping_type, note ?? null]);
      const ver = await createVersion(client, { label: '直接录入/修改映射' });
      await recomputeMappings(client, ver.version);
      await client.query('COMMIT');
      return { ok: true, source_norm: s.normKey, target_norm: t.normKey, mapping_version: ver.version };
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

  // 逐跳证据：默认返回该键最新一个版本的证据；?version=N 可查历史版本。
  // stale=true 表示证据早于当前映射版本——变更应用后旧证据明确标为过期，
  // 不再作为发布闸门的放行依据。
  app.get('/api/crawl/:key', async (req, reply) => {
    const key = decodeURIComponent(req.params.key);
    const current = await currentVersion(pool);
    const wantVersion = req.query?.version ? Number(req.query.version) : null;
    const params = [key];
    let versionWhere = '';
    if (wantVersion) {
      versionWhere = 'AND mapping_version = $2';
      params.push(wantVersion);
    }
    const { rows } = await pool.query(
      `SELECT * FROM crawl_results
        WHERE source_norm=$1 ${versionWhere}
          AND mapping_version = (
                SELECT max(mapping_version) FROM crawl_results WHERE source_norm=$1
                  ${wantVersion ? 'AND mapping_version = $2' : ''})
        ORDER BY hop_index`, params);
    if (!rows.length) return reply.code(404).send({ error: 'no crawl evidence; run verification first' });
    const evidenceVersion = rows[0].mapping_version;
    return {
      source_norm: key,
      current_version: current,
      evidence_version: evidenceVersion,
      stale: evidenceVersion < current,
      hops: rows,
    };
  });

  // ---- 映射变更集 -------------------------------------------------------

  app.get('/api/changesets', async () => {
    const { rows } = await pool.query(
      `SELECT id, name, status, base_version, applied_version, idempotency_key,
              jsonb_array_length(changes) AS change_count,
              jsonb_array_length(validation) AS issue_count,
              conflicts IS NOT NULL AS has_conflicts,
              created_at, submitted_at, applied_at, ended_at
         FROM mapping_changesets ORDER BY id DESC`);
    const current = await currentVersion(pool);
    return { changesets: rows, current_version: current };
  });

  // 创建（默认 draft）。冻结 base_version、规范化改动行与当时生效映射快照；
  // 校验问题随单留痕，不触碰任何映射。
  app.post('/api/changesets', async (req, reply) => {
    const payload = req.body ?? {};
    const idemKey = payload.idempotency_key ? String(payload.idempotency_key) : null;
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      if (idemKey) {
        const existing = await findByIdempotencyKey(client, idemKey);
        if (existing) {
          await client.query('COMMIT');
          return reply.code(200).send({ idempotent: true, changeset: existing });
        }
      }
      const cs = await createChangeset(client, payload, {
        name: String(payload.name ?? '').trim(),
        idempotencyKey: idemKey,
        createdBy: payload.created_by ?? null,
      });
      await client.query('COMMIT');
      return reply.code(201).send({ changeset: cs, validation: cs.validation });
    } catch (e) {
      await client.query('ROLLBACK');
      throw e;
    } finally {
      client.release();
    }
  });

  app.get('/api/changesets/:id', async (req, reply) => {
    const { rows } = await pool.query(
      'SELECT * FROM mapping_changesets WHERE id=$1', [req.params.id]);
    if (!rows.length) return reply.code(404).send({ error: 'not found' });
    const detail = await buildDetail(pool, rows[0]);
    return { changeset: rows[0], ...detail };
  });

  // 统一的状态动作封装：事务内执行服务函数；终结性错误回滚并透传状态码
  async function action(req, reply, fn) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const out = await fn(client);
      await client.query('COMMIT');
      return out;
    } catch (e) {
      await client.query('ROLLBACK');
      if (e instanceof ChangesetRejected) {
        return reply.code(e.statusCode).send(e.body);
      }
      throw e;
    } finally {
      client.release();
    }
  }

  app.post('/api/changesets/:id/submit', (req, reply) =>
    action(req, reply, (client) => submitChangeset(client, Number(req.params.id))));

  app.post('/api/changesets/:id/abandon', (req, reply) =>
    action(req, reply, (client) => abandonChangeset(client, Number(req.params.id))));

  // 应用：单事务内版本检测 → 原始材料增删 → 推进版本 → 重算歧义/生效映射。
  // 外网目标/无效编码/遗留歧义/冲突项任一存在：整体回滚（或标记过期），
  // 绝无“半套改动”落库。重复提交已应用变更集返回同一结果。
  app.post('/api/changesets/:id/apply', (req, reply) =>
    action(req, reply, (client) => applyChangeset(client, Number(req.params.id))));

  // ---- 迁移方案 -------------------------------------------------------

  app.get('/api/plans', async () => {
    const current = await currentVersion(pool);
    const { rows } = await pool.query(
      `SELECT p.*,
              count(pi.id) AS items,
              count(pi.id) FILTER (WHERE pi.item_status='verified') AS verified,
              count(pi.id) FILTER (WHERE pi.item_status='blocked')  AS blocked,
              count(pi.id) FILTER (WHERE pi.item_status='pending') AS pending,
              (p.mapping_version < $1) AS stale
         FROM migration_plans p
         LEFT JOIN migration_plan_items pi ON pi.plan_id=p.id
        GROUP BY p.id ORDER BY p.id`, [current]);
    return { plans: rows, current_version: current };
  });

  app.post('/api/plans', async (req, reply) => {
    const name = String(req.body?.name ?? '').trim();
    if (!name) return reply.code(400).send({ error: 'name required' });
    try {
      const { rows } = await pool.query(
        `INSERT INTO migration_plans (name) VALUES ($1)
         RETURNING *`, [name]);
      return rows[0];
    } catch (e) {
      if (e.code === '23505') return reply.code(409).send({ error: 'plan name exists' });
      throw e;
    }
  });

  // 把全部 active 映射纳入方案，按“方案所绑定映射版本”的裁决设置条目状态，
  // 并把方案的 mapping_version 冻结为当前版本。
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
      const version = await currentVersion(client);
      await client.query('DELETE FROM migration_plan_items WHERE plan_id=$1', [planId]);

      const { rows: ms } = await client.query(
        `SELECT m.*, v.verdict, v.issues, v.final_status, v.final_url_raw,
                v.final_url_norm, v.hops, v.tracker_preserved
           FROM url_mappings m
           LEFT JOIN verification_verdicts v
             ON v.source_norm=m.source_norm AND v.mapping_version=$1
          WHERE m.status='active' ORDER BY m.id`, [version]);
      for (const m of ms) {
        const good = m.verdict === 'ok' || m.verdict === 'deleted_gone_ok';
        // 计划中的最终跳转 URL：携带追踪参数的示例（取首次输入的参数）
        const { rows: ins } = await client.query(
          'SELECT source_raw FROM mapping_inputs WHERE source_norm=$1 ORDER BY id LIMIT 1',
          [m.source_norm]);
        const proposed = m.mapping_type === 'deleted'
          ? null
          : carryTrackers(ins[0].source_raw, m.target_raw);
        await client.query(
          `INSERT INTO migration_plan_items (plan_id, mapping_id, item_status, evidence)
           VALUES ($1,$2,$3,$4)`,
          [planId, m.id,
           good ? 'verified' : m.verdict ? 'blocked' : 'pending',
           JSON.stringify({
             mapping_version: version,
             source_norm: m.source_norm,
             verdict: m.verdict ?? null,
             issues: m.issues ?? [],
             final_status: m.final_status ?? null,
             final_url: m.final_url_raw ?? null,
             hops: m.hops ?? 0,
             tracker_preserved: m.tracker_preserved ?? null,
             proposed_redirect_url: proposed,
           })]);
      }
      await client.query(
        'UPDATE migration_plans SET mapping_version=$2, published_version=NULL WHERE id=$1',
        [planId, version]);
      await client.query('COMMIT');
      return { built: ms.length, mapping_version: version };
    } catch (e) {
      await client.query('ROLLBACK').catch(() => {});
      throw e;
    } finally {
      client.release();
    }
  });

  app.get('/api/plans/:id', async (req, reply) => {
    const current = await currentVersion(pool);
    const { rows: plans } = await pool.query('SELECT * FROM migration_plans WHERE id=$1', [req.params.id]);
    if (!plans.length) return reply.code(404).send({ error: 'not found' });
    const { rows: items } = await pool.query(
      `SELECT pi.*, m.source_raw, m.source_norm, m.target_raw, m.target_norm,
              m.mapping_type, pi.evidence
         FROM migration_plan_items pi
         LEFT JOIN url_mappings m ON m.id=pi.mapping_id
        WHERE pi.plan_id=$1 ORDER BY pi.id`, [req.params.id]);
    return {
      plan: plans[0],
      items,
      current_version: current,
      stale: plans[0].mapping_version < current,
    };
  });

  /**
   * 发布闸门：
   *  - 方案绑定的映射版本必须等于当前版本：变更集应用后旧证据/旧方案过期，
   *    必须重新验证（/api/verify）并重建（build）才可继续；
   *  - 不存在 blocked/pending 条目（每条都必须有当前版本成功验证的证据）；
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

    const current = await currentVersion(pool);
    if (plan[0].mapping_version < current) {
      blockers.push({
        source: `（方案版本 v${plan[0].mapping_version}）`,
        reason: `方案依据的映射版本已过期（当前 v${current}）：旧验证报告与方案不得发布，请先重新验证并重建方案`,
      });
    }

    const { rows: badItems } = await pool.query(
      `SELECT m.source_raw, pi.item_status, pi.evidence
         FROM migration_plan_items pi
         LEFT JOIN url_mappings m ON m.id=pi.mapping_id
        WHERE pi.plan_id=$1 AND pi.item_status <> 'verified'`, [planId]);
    for (const b of badItems) {
      blockers.push({
        source: b.source_raw ?? `（映射已删除：${b.evidence?.source_norm ?? '?'}）`,
        reason: b.item_status === 'pending'
          ? '只有映射表条目，没有当前版本的验证证据（填表不等于迁移完成）'
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
      return reply.code(409).send({ published: false, blockers, current_version: current });
    }

    const { rows } = await pool.query(
      `UPDATE migration_plans
          SET status='published', published_at=now(), published_version=$2
        WHERE id=$1 RETURNING *`, [planId, current]);
    return { published: true, plan: rows[0] };
  });
}

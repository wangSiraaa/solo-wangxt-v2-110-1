/**
 * 映射变更集（mapping changesets）服务。
 *
 * 纪律：
 *  - 创建即冻结：base_version（当时生效映射版本）+ 规范化后的改动行 +
 *    当时全量生效映射快照 base_snapshot，此后不随编辑改写，审计可还原。
 *  - 生命周期：draft（草稿）→ reviewable（可审阅）→ applied（已应用）；
 *    应用时若版本已被并发推进且触碰键发生分叉 → expired（已过期），
 *    不覆盖、给出三方差异（base / 并发方 / 本变更集）。
 *    draft/reviewable 可 abandon（放弃）。
 *  - 应用必须单事务：版本检测 → 写入 mapping_inputs（新增/修改 upsert，
 *    删除移除原始材料）→ 推进版本线 → 重算生效映射与规范化歧义；
 *    外网目标、无效编码、删除不存在的键、应用后出现未裁决歧义等任一不过，
 *    整个事务回滚——“半套改动”绝不落库。
 *  - 旧的逐跳证据、最终裁决、迁移方案由各自表的 mapping_version 绑定；
 *    版本前进后它们仍是历史留档，但不再放行发布（见 routes.js 闸门）。
 */
import { normalize } from './normalize.js';
import { isLocalOrigin } from './config.js';
import {
  currentVersion, createVersion, snapshotMappings, recomputeMappings,
} from './mappings-service.js';

const TERMINAL = new Set(['applied', 'expired', 'abandoned']);

/**
 * 校验并冻结一批改动。不碰数据库的纯函数（baseRows 由调用方读入），
 * 这样创建与应用前的复验可以共用同一份规则。
 *
 * @param {object} payload 原始请求体（含 changes[]）
 * @param {Array}  baseRows base_version 下生效映射（source_norm 键）
 * @returns {{changes: object[], issues: object[]}}
 */
export function prepareChanges(payload, baseRows) {
  const rawChanges = Array.isArray(payload?.changes) ? payload.changes : null;
  const issues = [];
  if (!rawChanges) {
    return { changes: [], issues: [{ index: -1, reason: 'changes[] required' }] };
  }
  if (!rawChanges.length) {
    return { changes: [], issues: [{ index: -1, reason: 'changeset 必须至少包含一条改动' }] };
  }

  const baseByKey = new Map(baseRows.map((r) => [r.source_norm, r]));
  const seen = new Map(); // source_norm -> { index, op, target_norm }
  const changes = [];

  rawChanges.forEach((c, index) => {
    const op = c?.op === 'upsert' || c?.op === 'delete' ? c.op : null;
    if (!op) {
      issues.push({ index, op: c?.op ?? null, source_raw: c?.source_raw ?? null,
        reason: "op 必须是 'upsert'（新增/修改）或 'delete'（已删除裁决）" });
      return;
    }
    const s = normalize(String(c.source_raw ?? ''));
    if (!s.ok) {
      issues.push({ index, op, source_raw: c.source_raw ?? null, reason: `旧址无效编码: ${s.error}` });
      return;
    }
    if (!isLocalOrigin(s)) {
      issues.push({
        index, op, source_raw: c.source_raw,
        reason: `旧址 ${s.normKey} 不属于随项目启动的本地站点（仅 ${s.host}:${s.port || '80'} 字面白名单）`,
      });
      return;
    }

    const frozen = {
      index, op,
      source_raw: String(c.source_raw), source_norm: s.normKey,
    };

    if (op === 'upsert') {
      const mappingType = c.mapping_type === 'deleted' ? 'deleted' : 'manual';
      const t = normalize(String(c.target_raw ?? ''));
      if (!t.ok) {
        issues.push({ index, op, source_raw: c.source_raw, reason: `目标无效编码: ${t.error}` });
        return;
      }
      if (!isLocalOrigin(t)) {
        issues.push({ index, op, source_raw: c.source_raw, target_raw: c.target_raw,
          reason: `目标 ${t.normKey} 是本地站点外地址（外网/其它端口一律拒绝，不允许半套改动落库）` });
        return;
      }
      Object.assign(frozen, {
        target_raw: String(c.target_raw), target_norm: t.normKey,
        mapping_type: mappingType, note: c.note ?? null,
      });
    } else {
      // 删除裁决：旧址必须在 base 版本中存在，否则该改动没有意义且无法审计
      if (!baseByKey.has(s.normKey)) {
        issues.push({ index, op, source_raw: c.source_raw, source_norm: s.normKey,
          reason: '删除裁决的旧址在冻结版本的生效映射中不存在' });
        return;
      }
      const base = baseByKey.get(s.normKey);
      Object.assign(frozen, {
        target_raw: base.target_raw, target_norm: base.target_norm,
        mapping_type: base.mapping_type, note: c.note ?? null,
      });
    }
    // 同一 canonical key 在批内出现：
    //  - 写法变体 + 完全相同裁决：允许（追踪参数差异本就不进键），折叠为一条；
    //  - 不同目标或一增一删：属于未裁决歧义/自相矛盾，拒绝整批。
    if (seen.has(s.normKey)) {
      const prev = seen.get(s.normKey);
      const sameVerdict = prev.op === frozen.op &&
        (frozen.op === 'delete' || prev.target_norm === frozen.target_norm);
      if (!sameVerdict) {
        issues.push({
          index, op, source_norm: s.normKey,
          reason: `同 canonical key 的两条改动裁决不一致（第 ${prev.index} 行与本行）：未裁决歧义不可落库`,
        });
      }
      return;
    }
    seen.set(s.normKey, {
      index, op,
      target_norm: frozen.op === 'delete' ? null : frozen.target_norm,
    });
    changes.push(frozen);
  });

  // 防御：批内规范化歧义（多写法归一到同一 canonical key 却指向不同目标）。
  // 正常已在折叠循环中拦截；这里保留权威复核，未来扩展改动行结构时不被绕过。
  const targetByKey = new Map();
  for (const ch of changes.filter((x) => x.op === 'upsert')) {
    if (!targetByKey.has(ch.source_norm)) targetByKey.set(ch.source_norm, new Set());
    targetByKey.get(ch.source_norm).add(ch.target_norm);
  }
  for (const [key, targets] of targetByKey) {
    if (targets.size > 1) {
      issues.push({ index: -1, source_norm: key,
        reason: `变更集应用后该 canonical key 仍有 ${targets.size} 个未裁决目标，未裁决歧义不可落库` });
    }
  }

  return { changes, issues };
}

/**
 * 版本分叉：冻结版本之后、当前版本的触碰键是否已被别人改过。
 * @returns {Array<{source_norm, base, current, proposed}>} 冲突行（三方）
 */
export function threeWayDiff(baseRows, currentRows, changes) {
  const baseByKey = new Map(baseRows.map((r) => [r.source_norm, r]));
  const curByKey = new Map(currentRows.map((r) => [r.source_norm, r]));
  const conflicts = [];
  for (const ch of changes) {
    const base = baseByKey.get(ch.source_norm) ?? null;
    const current = curByKey.get(ch.source_norm) ?? null;
    const sig = (r) => (r ? `${r.target_norm}|${r.mapping_type}|${r.status}` : null);
    if (sig(base) !== sig(current)) {
      conflicts.push({
        source_norm: ch.source_norm,
        op: ch.op,
        base: base ? {
          target_norm: base.target_norm, mapping_type: base.mapping_type,
          status: base.status, target_raw: base.target_raw,
        } : null,
        current: current ? {
          target_norm: current.target_norm, mapping_type: current.mapping_type,
          status: current.status, target_raw: current.target_raw,
        } : null,
        proposed: ch.op === 'delete' ? { deleted: true } : {
          target_norm: ch.target_norm, mapping_type: ch.mapping_type,
          target_raw: ch.target_raw,
        },
      });
    }
  }
  return conflicts;
}

function rowOf(m, label) {
  if (!m) return { side: label, exists: false };
  return {
    side: label, exists: true,
    target_raw: m.target_raw, target_norm: m.target_norm,
    mapping_type: m.mapping_type, status: m.status,
  };
}

/** 详情页/API 用的逐条差异（base → 本变更集；过期时附当前侧三方） */
export async function buildDetail(client, cs) {
  const version = await currentVersion(client);
  const baseRows = Array.isArray(cs.base_snapshot) ? cs.base_snapshot : [];
  const baseByKey = new Map(baseRows.map((r) => [r.source_norm, r]));
  const { rows: curRows } = await client.query(
    'SELECT * FROM url_mappings ORDER BY source_norm');
  const curByKey = new Map(curRows.map((r) => [r.source_norm, r]));

  const items = (cs.changes ?? []).map((ch) => {
    const base = baseByKey.get(ch.source_norm) ?? null;
    const current = curByKey.get(ch.source_norm) ?? null;
    let changeKind;
    if (ch.op === 'delete') changeKind = 'delete';
    else if (!base) changeKind = 'add';
    else changeKind = 'modify';
    return {
      change_kind: changeKind,
      source_raw: ch.source_raw, source_norm: ch.source_norm,
      base: base ? rowOf(base, 'base') : null,
      current: current ? rowOf(current, 'current') : null,
      proposed: ch.op === 'delete'
        ? { side: 'changeset', exists: false, deleted: true }
        : { side: 'changeset', exists: true,
            target_raw: ch.target_raw, target_norm: ch.target_norm,
            mapping_type: ch.mapping_type, status: 'active' },
      changed_by_other: cs.status === 'expired' && (() => {
        const sig = (r) => (r ? `${r.target_norm}|${r.mapping_type}|${r.status}` : null);
        return sig(base) !== sig(current);
      })(),
    };
  });
  return { current_version: version, items };
}

// ---- 数据库操作 ----------------------------------------------------------

export async function createChangeset(client, payload, meta = {}) {
  const baseVersion = await currentVersion(client);
  const baseRows = await snapshotMappings(client, baseVersion);
  const { changes, issues } = prepareChanges(payload, baseRows);

  const { rows } = await client.query(
    `INSERT INTO mapping_changesets
       (name, status, base_version, payload, changes, base_snapshot,
        validation, idempotency_key, created_by)
     VALUES ($1,'draft',$2,$3,$4,$5,$6,$7,$8)
     RETURNING *`,
    [meta.name || String(payload?.name ?? '').trim() || `变更集@v${baseVersion}`,
     baseVersion,
     JSON.stringify(payload ?? {}),
     JSON.stringify(changes),
     JSON.stringify(baseRows),
     JSON.stringify(issues),
     meta.idempotencyKey ?? null,
     meta.createdBy ?? null]);
  return rows[0];
}

/** 幂等查询：同一 idempotency_key 直接返回既有结果（含状态机结论） */
export async function findByIdempotencyKey(client, key) {
  if (!key) return null;
  const { rows } = await client.query(
    'SELECT * FROM mapping_changesets WHERE idempotency_key=$1', [key]);
  return rows[0] ?? null;
}

/** 应用前复验：把冻结时的规则在当前请求上下文再跑一遍（规则本身无状态） */
function revalidateFrozen(changes, baseRows) {
  const payload = {
    changes: changes.map((ch) => (ch.op === 'delete'
      ? { op: 'delete', source_raw: ch.source_raw }
      : {
          op: 'upsert', source_raw: ch.source_raw, target_raw: ch.target_raw,
          mapping_type: ch.mapping_type, note: ch.note,
        })),
  };
  return prepareChanges(payload, baseRows).issues;
}

/**
 * 应用变更集。必须跑在调用方事务中；任何校验/冲突/歧义失败都抛出
 * ChangesetRejected，由路由回滚——不允许半套改动落库。
 */
export class ChangesetRejected extends Error {
  constructor(statusCode, body) {
    super(body.error ?? 'changeset rejected');
    this.statusCode = statusCode;
    this.body = body;
  }
}

export async function applyChangeset(client, id) {
  const { rows: csRows } = await client.query(
    'SELECT * FROM mapping_changesets WHERE id=$1', [id]);
  if (!csRows.length) throw new ChangesetRejected(404, { error: 'changeset not found' });
  const cs = csRows[0];

  // 幂等：已应用的变更集重复提交，返回同一份应用结果（不重放、不覆盖）
  if (cs.status === 'applied') {
    return {
      idempotent: true, changeset: cs,
      applied: true, applied_version: cs.applied_version != null ? Number(cs.applied_version) : null,
    };
  }
  if (TERMINAL.has(cs.status)) {
    return { idempotent: true, changeset: cs, already: cs.status };
  }
  if (cs.status !== 'reviewable') {
    throw new ChangesetRejected(409, {
      error: `变更集处于 ${cs.status} 状态，只有可审阅(reviewable)的变更集可以应用`,
      status: cs.status,
    });
  }

  const baseVersion = Number(cs.base_version);
  // 锁住版本线顶端：真实并发下两个应用事务在这里串行，
  // 后到者读到的是先到者提交后的新版本，从而走冲突检测而不是互相覆盖。
  const { rows: lockRows } = await client.query(
    'SELECT version FROM mapping_versions ORDER BY version DESC LIMIT 1 FOR UPDATE');
  const curVersion = Number(lockRows[0]?.version ?? baseVersion);
  const baseRows = Array.isArray(cs.base_snapshot) ? cs.base_snapshot : [];
  const currentRows = await snapshotMappings(client, curVersion);
  const changes = cs.changes ?? [];

  // 1) 冻结内容复验（白名单/编码规则若收紧，旧变更集也不能借道放行）
  const reIssues = revalidateFrozen(changes, baseRows);
  if (reIssues.length) {
    await client.query(
      `UPDATE mapping_changesets SET reject_reason=$2, ended_at=now() WHERE id=$1`,
      [id, JSON.stringify(reIssues)]);
    throw new ChangesetRejected(422, {
      applied: false, rejected: true,
      error: '变更集复验未通过，整体拒绝，当前映射毫无变化',
      validation: reIssues,
    });
  }

  // 2) 版本检测：冻结版本之后触碰键被并发方修改 → 过期，不覆盖，留三方差异
  const conflicts = threeWayDiff(baseRows, currentRows, changes);
  if (curVersion > baseVersion && conflicts.length) {
    const expired = {
      conflicts,
      base_version: baseVersion,
      current_version: curVersion,
    };
    await client.query(
      `UPDATE mapping_changesets
          SET status='expired', conflicts=$2, ended_at=now()
        WHERE id=$1 RETURNING *`,
      [id, JSON.stringify(expired)]);
    const { rows: updated } = await client.query(
      'SELECT * FROM mapping_changesets WHERE id=$1', [id]);
    return { applied: false, expired: true, ...expired, changeset: updated[0] };
  }

  // 3) 应用前闸门：当前生效映射中不允许存在“本变更集未触碰”的未裁决歧义键。
  //    触碰键可能正是来裁决歧义的（如删除歧义一方），其结果由事务内重算权威判定；
  //    未触碰的歧义必须先裁决，避免在歧义未清的状态下放行发布。
  const touched = new Set(changes.map((c) => c.source_norm));
  const untouchedConflicts = currentRows
    .filter((r) => r.status === 'conflicted' && !touched.has(r.source_norm))
    .map((r) => r.source_norm);
  if (untouchedConflicts.length) {
    throw new ChangesetRejected(409, {
      applied: false, rejected: true,
      error: '当前映射存在本变更集未处理的未裁决歧义，先裁决歧义再应用变更集',
      conflicted_keys: untouchedConflicts,
    });
  }

  // 4) 写入原始材料：upsert=新增/修改（同键先清旧原始行再以新裁决留证），
  //    delete=移除该键的全部原始材料（删除裁决是负责人决定，不再有映射依据）
  for (const ch of changes) {
    if (ch.op === 'delete') {
      await client.query('DELETE FROM mapping_inputs WHERE source_norm=$1', [ch.source_norm]);
    } else {
      await client.query('DELETE FROM mapping_inputs WHERE source_norm=$1', [ch.source_norm]);
      await client.query(
        `INSERT INTO mapping_inputs (source_raw, source_norm, target_raw, target_norm, mapping_type, note)
         VALUES ($1,$2,$3,$4,$5,$6)`,
        [ch.source_raw, ch.source_norm, ch.target_raw, ch.target_norm,
         ch.mapping_type, ch.note ?? `变更集 #${id}`]);
    }
  }

  // 5) 推进版本线并重算（规范化歧义 + 生效映射），全部在同一事务
  const ver = await createVersion(client, { label: `changeset #${id} 应用`, changesetId: id });
  const rec = await recomputeMappings(client, ver.version);
  if (rec.conflicted > 0) {
    // 权威歧义判定（与未被本变更集触碰的既有输入之间形成的多目标）
    throw new ChangesetRejected(409, {
      applied: false, rejected: true,
      error: `重算后仍有 ${rec.conflicted} 个 canonical key 未裁决，事务回滚`,
    });
  }

  const { rows: done } = await client.query(
    `UPDATE mapping_changesets
        SET status='applied', applied_version=$2, applied_at=now(), ended_at=now()
      WHERE id=$1 RETURNING *`, [id, ver.version]);

  return {
    applied: true,
    applied_version: ver.version,
    base_version: baseVersion,
    summary: rec,
    changeset: done[0],
  };
}

export async function submitChangeset(client, id) {
  const { rows } = await client.query('SELECT * FROM mapping_changesets WHERE id=$1', [id]);
  if (!rows.length) throw new ChangesetRejected(404, { error: 'changeset not found' });
  const cs = rows[0];
  if (TERMINAL.has(cs.status)) {
    throw new ChangesetRejected(409, { error: `变更集已终结（${cs.status}）`, status: cs.status });
  }
  if (cs.status === 'reviewable') return { changeset: cs, already: true };

  // 提交时复验：冻结时留痕的问题（外网/无效编码/批内歧义等）+ 当前规则复验，
  // 任一不过都不能进入审阅。
  const frozenIssues = Array.isArray(cs.validation) ? cs.validation : [];
  const issues = [
    ...frozenIssues,
    ...revalidateFrozen(cs.changes ?? [], Array.isArray(cs.base_snapshot) ? cs.base_snapshot : []),
  ];
  if (issues.length) {
    throw new ChangesetRejected(422, {
      error: '变更集存在未解决的校验问题，不能进入审阅',
      validation: issues,
    });
  }
  const { rows: updated } = await client.query(
    `UPDATE mapping_changesets SET status='reviewable', submitted_at=now()
      WHERE id=$1 RETURNING *`, [id]);
  return { changeset: updated[0] };
}

export async function abandonChangeset(client, id) {
  const { rows } = await client.query('SELECT * FROM mapping_changesets WHERE id=$1', [id]);
  if (!rows.length) throw new ChangesetRejected(404, { error: 'changeset not found' });
  const cs = rows[0];
  if (TERMINAL.has(cs.status)) return { changeset: cs, already: cs.status };
  const { rows: updated } = await client.query(
    `UPDATE mapping_changesets SET status='abandoned', ended_at=now()
      WHERE id=$1 RETURNING *`, [id]);
  return { changeset: updated[0] };
}

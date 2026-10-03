/**
 * 映射变更集（mapping changesets）。
 *
 * 编辑不再直接改写验证依据：改动先进入变更集，创建时冻结映射版本与生效快照；
 * 草稿 → 可审阅（提交时整组校验）→ 应用（单事务：版本冲突检测 → 落库 →
 * 重新计算规范化歧义和生效映射 → 版本前进、旧证据/方案过期）→ 已应用；
 * 冲突时转为已过期并保留 base/theirs/ours 三方差异；可放弃。
 *
 * 条目语义（原始 URL 级）：
 *  - add：新增一条原始录入。基线已有同 canonical key 时，目标必须与现有目标一致
 *         （只是书写变体）；目标不同会制造未裁决歧义 → 整组拒绝。
 *  - modify：裁决/修改既有 canonical key，用新声明替换该键的全部原始材料。
 *  - remove：删除某 canonical key 的全部材料与生效映射。
 */
import { pool } from './db.js';
import { strictNormalize, isLocalOrigin } from './normalize.js';
import { commitMappingChange, getCurrentVersion, MappingError } from './mappings-service.js';

const STATUS_LABEL = {
  draft: '草稿',
  in_review: '可审阅',
  applied: '已应用',
  stale: '已过期',
  abandoned: '已放弃',
};

export class ChangesetValidationError extends Error {
  constructor(message, rejected = []) {
    super(message);
    this.statusCode = 400;
    this.rejected = rejected;
  }
}

async function fetchCurrentSnapshot(client) {
  const { rows } = await client.query('SELECT * FROM url_mappings ORDER BY id');
  return new Map(rows.map((m) => [m.source_norm, m]));
}

async function fetchChangeset(client, id, { lock = false } = {}) {
  const { rows } = await client.query(
    `SELECT * FROM mapping_changesets WHERE id=$1 ${lock ? 'FOR UPDATE' : ''}`,
    [id]);
  return rows[0] ?? null;
}

async function fetchItems(client, changesetId) {
  const { rows } = await client.query(
    'SELECT * FROM mapping_changeset_items WHERE changeset_id=$1 ORDER BY id',
    [changesetId]);
  return rows;
}

/**
 * 规范化一条条目。仅做“编码/可解析/本地目标”这类与版本无关的硬校验；
 * 键是否存在、是否制造歧义等需要基线快照的校验在 validateForSubmit。
 * operation 保留调用方意图：add（新增）/ modify（显式修改或裁决歧义）/ remove（删除）。
 * @returns {{ok:true, ...} | {ok:false, reason}}
 */
export function normalizeItem(item) {
  const requested = ['add', 'modify', 'remove'].includes(item.operation)
    ? item.operation : 'add';
  const sourceRaw = String(item.source_raw ?? '').trim();
  const s = strictNormalize(sourceRaw);
  if (!s.ok) return { ok: false, reason: `旧址无效：${s.error}` };

  const mappingType = item.mapping_type === 'deleted' ? 'deleted' : 'manual';

  if (requested === 'remove') {
    return {
      ok: true, operation: 'remove',
      source_raw: sourceRaw, source_norm: s.normKey,
      target_raw: null, target_norm: null, mapping_type: mappingType,
    };
  }

  // deleted 裁决允许省略目标（约定目标即旧址自身，验证期望 410/404）
  let targetRaw = String(item.target_raw ?? '').trim();
  if (!targetRaw) {
    if (mappingType === 'deleted') targetRaw = sourceRaw;
    else return { ok: false, reason: '缺少新址目标 URL' };
  }
  const t = strictNormalize(targetRaw);
  if (!t.ok) return { ok: false, reason: `目标无效：${t.error}` };
  if (!isLocalOrigin(t)) {
    return { ok: false, reason: `目标 ${targetRaw} 不在随项目启动的本地站点白名单内（禁止外网/其它端口落库）` };
  }
  return {
    ok: true, operation: requested,
    source_raw: sourceRaw, source_norm: s.normKey,
    target_raw: targetRaw, target_norm: t.normKey,
    mapping_type: mappingType,
  };
}

/** 有效操作即条目声明的操作（存在性约束在 validateForSubmit 校验） */
function effectiveOperation(item) {
  return item.operation === 'remove' ? 'remove' : item.operation === 'modify' ? 'modify' : 'add';
}

/**
 * 提交前的整组校验（也用于工作台提前展示问题）。
 * @param {Array} items 已规范化存储的条目行
 * @param {Map} baseMap 创建时冻结的快照
 */
export function validateForSubmit(items, baseMap) {
  const rejected = [];
  const prepared = [];

  for (const [idx, raw] of items.entries()) {
    const norm = normalizeItem(raw);
    const label = raw.source_raw || `#${idx + 1}`;
    if (!norm.ok) {
      rejected.push({ index: idx, source_raw: label, reason: norm.reason });
      continue;
    }
    const op = effectiveOperation(norm);
    const base = baseMap.get(norm.source_norm);

    if (op === 'remove') {
      if (!base) {
        rejected.push({ index: idx, source_raw: label, reason: '基线版本中不存在该 canonical key，无法删除' });
        continue;
      }
    } else if (op === 'modify') {
      if (!base) {
        rejected.push({ index: idx, source_raw: label, reason: '基线版本中不存在该 canonical key，无法修改（新增请用 add）' });
        continue;
      }
      // modify 即显式裁决：对 active 键改目标、对 conflicted 键给出唯一目标，都合法
    } else {
      // add 到既有键：仅允许“同目标书写变体”；不同目标或对歧义键的 add 一律拒绝
      if (base && (base.status === 'conflicted' || base.target_norm !== norm.target_norm)) {
        rejected.push({
          index: idx, source_raw: label,
          reason: `同归一化键 ${norm.source_norm} 已存在${base.status === 'conflicted' ? '未裁决歧义' : `目标 ${base.target_norm}`}，`
            + `新声明目标 ${norm.target_norm} 与之不同会制造/延续未裁决歧义（请改用“修改/裁决”）`,
        });
        continue;
      }
    }

    // 同变更集内多条落到同键（不同原始写法）：目标必须一致，否则也是未裁决歧义
    if (op !== 'remove') {
      const dup = prepared.find((p) => p.source_norm === norm.source_norm);
      if (dup && dup.target_norm !== norm.target_norm) {
        rejected.push({
          index: idx, source_raw: label,
          reason: `变更集内同归一化键 ${norm.source_norm} 声明了不同目标 `
            + `${dup.target_norm} 与 ${norm.target_norm}，未裁决歧义`,
        });
        continue;
      }
    }

    prepared.push({ ...norm, operation: op });
  }

  return { rejected, prepared };
}

/** 应用前在“当前材料 + 本组改动”的拟态结果上检测未裁决歧义 */
function prospectiveAmbiguities(currentInputs, prepared) {
  const groups = new Map();
  for (const row of currentInputs) {
    if (!groups.has(row.source_norm)) groups.set(row.source_norm, []);
    groups.get(row.source_norm).push(row);
  }
  for (const p of prepared) {
    if (p.operation === 'remove') {
      groups.delete(p.source_norm);
    } else if (p.operation === 'modify') {
      groups.set(p.source_norm, [{
        source_norm: p.source_norm, target_norm: p.target_norm,
        source_raw: p.source_raw, target_raw: p.target_raw,
      }]);
    } else {
      if (!groups.has(p.source_norm)) groups.set(p.source_norm, []);
      groups.get(p.source_norm).push({
        source_norm: p.source_norm, target_norm: p.target_norm,
        source_raw: p.source_raw, target_raw: p.target_raw,
      });
    }
  }
  const ambiguities = [];
  for (const [sourceNorm, rows] of groups) {
    const targets = new Set(rows.map((r) => r.target_norm));
    if (targets.size > 1) ambiguities.push({ source_norm, targets: [...targets] });
  }
  return ambiguities;
}

function rowToView(m) {
  if (!m) return null;
  return {
    source_raw: m.source_raw,
    source_norm: m.source_norm,
    target_raw: m.target_raw,
    target_norm: m.target_norm,
    mapping_type: m.mapping_type,
    status: m.status,
    mapping_version: Number(m.mapping_version),
  };
}

/** 计算 base/theirs/ours 三方差异（过期冲突展示） */
function buildThreeWay(item, baseMap, currentMap) {
  const key = item.source_norm;
  const base = rowToView(baseMap.get(key));
  const theirs = rowToView(currentMap.get(key));
  const ours = item.operation === 'remove'
    ? { source_norm: key, removed: true }
    : {
        source_raw: item.source_raw,
        source_norm: key,
        target_raw: item.target_raw,
        target_norm: item.target_norm,
        mapping_type: item.mapping_type,
      };
  const changedSinceBase =
    JSON.stringify(base) !== JSON.stringify(theirs);
  return {
    source_norm: key,
    operation: item.operation,
    conflict: changedSinceBase,
    base, theirs, ours,
  };
}

function itemDiff(item, baseMap) {
  const key = item.source_norm;
  return {
    operation: item.operation,
    source_norm: key,
    before: rowToView(baseMap.get(key)),
    after: item.operation === 'remove'
      ? { source_norm: key, removed: true }
      : {
          source_raw: item.source_raw,
          source_norm: key,
          target_raw: item.target_raw,
          target_norm: item.target_norm,
          mapping_type: item.mapping_type,
        },
  };
}

function parseSnapshot(cs) {
  const snap = cs.base_snapshot ?? {};
  return new Map(Object.entries(snap));
}

/** BIGINT/BIGSERIAL 经 node-pg 返回字符串，对 API 输出统一数值化 */
function withNumbers(cs) {
  if (!cs) return cs;
  return {
    ...cs,
    id: Number(cs.id),
    base_mapping_version: Number(cs.base_mapping_version),
    applied_version: cs.applied_version != null ? Number(cs.applied_version) : null,
  };
}

// ---- CRUD ---------------------------------------------------------------

export async function listChangesets() {
  const { rows } = await pool.query(
    `SELECT c.*,
            (SELECT count(*) FROM mapping_changeset_items i WHERE i.changeset_id=c.id) AS item_count,
            (SELECT max(version) FROM mapping_versions) AS current_version
       FROM mapping_changesets c ORDER BY c.id`);
  return rows.map((r) => ({
    ...withNumbers(r),
    item_count: Number(r.item_count),
    current_version: Number(r.current_version),
  }));
}

export async function getChangeset(id) {
  const client = await pool.connect();
  try {
    const cs = await fetchChangeset(client, id);
    if (!cs) throw new MappingError(404, 'not_found', '变更集不存在');
    const items = await fetchItems(client, id);
    const baseMap = parseSnapshot(cs);
    const currentMap = await fetchCurrentSnapshot(client);
    const currentVersion = await getCurrentVersion(client);

    const prepared = items.map((it) => ({
      ...it, effective_operation: effectiveOperation(it),
    }));
    const { rejected } = validateForSubmit(items, baseMap);
    const diffs = prepared.map((it) => itemDiff(
      { ...it, operation: it.effective_operation }, baseMap));

    let conflicts = [];
    if ((cs.status === 'stale' || cs.status === 'in_review')
        && Number(cs.base_mapping_version) < currentVersion) {
      conflicts = prepared
        .map((it) => buildThreeWay(
          { ...it, operation: it.effective_operation }, baseMap, currentMap))
        .filter((d) => d.conflict);
    }

    return {
      changeset: {
        ...withNumbers(cs),
        status_label: STATUS_LABEL[cs.status],
      },
      current_version: currentVersion,
      items: prepared,
      validation: { valid: rejected.length === 0, rejected },
      diffs,
      conflicts,
      apply_result: cs.apply_result ?? null,
      statusLabel: STATUS_LABEL,
    };
  } finally {
    client.release();
  }
}

export async function createChangeset({ name, description, createdBy }) {
  const trimmed = String(name ?? '').trim();
  if (!trimmed) throw new MappingError(400, 'name_required', '变更集名称必填');
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const version = await getCurrentVersion(client);
    const { rows: mapRows } = await client.query('SELECT * FROM url_mappings ORDER BY id');
    const snapshot = {};
    for (const m of mapRows) snapshot[m.source_norm] = rowToView(m);
    const { rows } = await client.query(
      `INSERT INTO mapping_changesets
         (name, description, created_by, base_mapping_version, base_snapshot)
       VALUES ($1,$2,$3,$4,$5) RETURNING *`,
      [trimmed, description ?? null, createdBy ?? null, version, JSON.stringify(snapshot)]);
    await client.query('COMMIT');
    return rows[0];
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}

export async function addChangesetItem(changesetId, body) {
  const client = await pool.connect();
  try {
    const cs = await fetchChangeset(client, changesetId);
    if (!cs) throw new MappingError(404, 'not_found', '变更集不存在');
    if (cs.status !== 'draft') {
      throw new MappingError(409, 'not_editable',
        `状态为 ${STATUS_LABEL[cs.status]} 的变更集不可再编辑（仅草稿可改）`);
    }
    // 录入时只做与版本无关的硬校验（编码/白名单/可解析）
    const norm = normalizeItem(body);
    if (!norm.ok) throw new MappingError(400, 'invalid_item', norm.reason);

    const { rows } = await client.query(
      `INSERT INTO mapping_changeset_items
         (changeset_id, operation, source_raw, source_norm,
          target_raw, target_norm, mapping_type, note)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
       ON CONFLICT (changeset_id, source_norm) DO UPDATE SET
         operation=EXCLUDED.operation, source_raw=EXCLUDED.source_raw,
         target_raw=EXCLUDED.target_raw, target_norm=EXCLUDED.target_norm,
         mapping_type=EXCLUDED.mapping_type, note=EXCLUDED.note
       RETURNING *`,
      [changesetId, norm.operation, norm.source_raw, norm.source_norm,
       norm.target_raw, norm.target_norm, norm.mapping_type, body.note ?? null]);
    await client.query(
      "UPDATE mapping_changesets SET updated_at=now() WHERE id=$1", [changesetId]);
    return rows[0];
  } finally {
    client.release();
  }
}

export async function removeChangesetItem(changesetId, itemId) {
  const client = await pool.connect();
  try {
    const cs = await fetchChangeset(client, changesetId);
    if (!cs) throw new MappingError(404, 'not_found', '变更集不存在');
    if (cs.status !== 'draft') {
      throw new MappingError(409, 'not_editable', '仅草稿状态可删除条目');
    }
    await client.query('DELETE FROM mapping_changeset_items WHERE id=$1 AND changeset_id=$2',
      [itemId, changesetId]);
    return { ok: true };
  } finally {
    client.release();
  }
}

export async function submitChangeset(changesetId) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const cs = await fetchChangeset(client, changesetId, { lock: true });
    if (!cs) { await client.query('ROLLBACK'); throw new MappingError(404, 'not_found', '变更集不存在'); }
    if (cs.status !== 'draft') {
      await client.query('ROLLBACK');
      throw new MappingError(409, 'not_draft',
        `仅草稿可提交审阅，当前状态：${STATUS_LABEL[cs.status]}`);
    }
    const items = await fetchItems(client, changesetId);
    if (!items.length) {
      await client.query('ROLLBACK');
      throw new ChangesetValidationError('变更集为空，不能提交审阅');
    }
    const { rejected, prepared } = validateForSubmit(items, parseSnapshot(cs));
    if (rejected.length) {
      await client.query('ROLLBACK');
      throw new ChangesetValidationError(
        `${rejected.length} 个条目未通过整组校验，变更集保持草稿`, rejected);
    }
    // 规范化后的硬结论回写（deleted 省略目标等补全结果），审计时与输入一致可查
    for (const p of prepared) {
      await client.query(
        `UPDATE mapping_changeset_items
            SET operation=$2, target_raw=$3, target_norm=$4, mapping_type=$5
          WHERE changeset_id=$1 AND source_norm=$6`,
        [changesetId, p.operation, p.target_raw, p.target_norm, p.mapping_type, p.source_norm]);
    }
    const { rows } = await client.query(
      `UPDATE mapping_changesets
          SET status='in_review', submitted_at=now(), updated_at=now()
        WHERE id=$1 RETURNING *`, [changesetId]);
    await client.query('COMMIT');
    return { ok: true, changeset: rows[0], items: prepared.length };
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}

export async function abandonChangeset(changesetId, reason) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const cs = await fetchChangeset(client, changesetId, { lock: true });
    if (!cs) { await client.query('ROLLBACK'); throw new MappingError(404, 'not_found', '变更集不存在'); }
    if (!['draft', 'in_review'].includes(cs.status)) {
      await client.query('ROLLBACK');
      throw new MappingError(409, 'not_abandonable',
        `状态为 ${STATUS_LABEL[cs.status]} 的变更集不可放弃`);
    }
    const { rows } = await client.query(
      `UPDATE mapping_changesets
          SET status='abandoned', abandoned_at=now(),
              expire_reason=$2, updated_at=now()
        WHERE id=$1 RETURNING *`,
      [changesetId, reason ?? null]);
    await client.query('COMMIT');
    return rows[0];
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}

/**
 * 应用变更集：一个事务内完成全部工作。
 * 重复应用“已应用/已过期”的变更集 → 返回首次保存的同一结果（幂等、可审计）。
 */
export async function applyChangeset(changesetId) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    // 与直接录入互斥；同一时刻只有一个映射提交能推进版本
    await client.query('SELECT pg_advisory_xact_lock(734771)');
    const cs = await fetchChangeset(client, changesetId, { lock: true });
    if (!cs) { await client.query('ROLLBACK'); throw new MappingError(404, 'not_found', '变更集不存在'); }

    // 幂等：已有应用结论（成功或过期）一律原样返回，包括 HTTP 语义
    if (cs.status === 'applied' || cs.status === 'stale') {
      await client.query('ROLLBACK');
      return { idempotent: true, status: cs.status, apply_result: cs.apply_result };
    }
    if (cs.status !== 'in_review') {
      await client.query('ROLLBACK');
      throw new MappingError(409, 'not_reviewable',
        `仅“可审阅”状态可应用，当前状态：${STATUS_LABEL[cs.status]}`);
    }

    const items = await fetchItems(client, changesetId);
    const baseMap = parseSnapshot(cs);
    const currentMap = await fetchCurrentSnapshot(client);
    const currentVersion = await getCurrentVersion(client);
    const prepared = validateForSubmit(items, baseMap).prepared;

    // 1) 按当前版本检测冲突：基线之后被别的变更集改过、且本集也触及的键
    const conflicts = [];
    if (currentVersion > Number(cs.base_mapping_version)) {
      for (const p of prepared) {
        const tw = buildThreeWay(p, baseMap, currentMap);
        if (tw.conflict) conflicts.push(tw);
      }
    }
    if (conflicts.length) {
      const result = {
        applied: false,
        expired: true,
        reason: 'mapping_version_conflict',
        base_version: Number(cs.base_mapping_version),
        current_version: currentVersion,
        conflicts,
      };
      await client.query(
        `UPDATE mapping_changesets
            SET status='stale', expire_reason='映射版本已被其它变更集推进，存在键冲突',
                apply_result=$2, updated_at=now()
          WHERE id=$1`,
        [changesetId, JSON.stringify(result)]);
      await client.query('COMMIT');
      return { idempotent: false, status: 'stale', apply_result: result };
    }

    // 2) 拟态歧义检测：外网目标/非法编码已在提交时拒绝；这里再按“当前材料”兜底
    const { rows: currentInputs } = await client.query('SELECT * FROM mapping_inputs');
    const ambiguities = prospectiveAmbiguities(currentInputs, prepared);
    if (ambiguities.length) {
      const result = {
        applied: false,
        reason: 'unresolved_ambiguity',
        base_version: Number(cs.base_mapping_version),
        current_version: currentVersion,
        ambiguities,
      };
      await client.query('ROLLBACK');
      // 不落任何“半套改动”：状态保持可审阅，供负责人修改后重新提交
      return { idempotent: false, status: 'in_review', apply_result: result };
    }

    // 3) 落库原始材料（全部成功或整体回滚）
    const changes = [];
    for (const p of prepared) {
      if (p.operation === 'remove' || p.operation === 'modify') {
        await client.query('DELETE FROM mapping_inputs WHERE source_norm=$1', [p.source_norm]);
      }
      if (p.operation === 'remove') {
        changes.push({ operation: 'remove', source_norm: p.source_norm });
        continue;
      }
      await client.query(
        `INSERT INTO mapping_inputs
           (source_raw, source_norm, target_raw, target_norm, mapping_type,
            note, source_changeset_id)
         VALUES ($1,$2,$3,$4,$5,$6,$7)`,
        [p.source_raw, p.source_norm, p.target_raw, p.target_norm,
         p.mapping_type, items.find((i) => i.source_norm === p.source_norm)?.note ?? null,
         changesetId]);
      changes.push({
        operation: p.operation, source_norm: p.source_norm,
        source_raw: p.source_raw, target_raw: p.target_raw,
        target_norm: p.target_norm, mapping_type: p.mapping_type,
      });
    }

    // 4) 重算生效映射 + 版本前进 + 旧证据/方案过期（同一事务）
    const commit = await commitMappingChange(client, {
      changesetId: changesetId,
      note: `变更集 #${changesetId} 应用`,
    });

    const result = {
      applied: true,
      changeset_id: changesetId,
      base_version: Number(cs.base_mapping_version),
      applied_version: commit.newVersion,
      version_moved: commit.versionMoved,
      changes,
      effective_mappings: commit.total,
      conflicted: commit.conflicted,
      affected_keys: commit.changedKeys,
    };
    const { rows: updated } = await client.query(
      `UPDATE mapping_changesets
          SET status='applied', applied_at=now(),
              applied_version=$2, apply_result=$3, updated_at=now()
        WHERE id=$1 RETURNING *`,
      [changesetId, commit.newVersion, JSON.stringify(result)]);
    await client.query('COMMIT');
    return { idempotent: false, status: 'applied', apply_result: result, changeset: updated[0] };
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}

export async function listVersions() {
  const { rows } = await pool.query(
    `SELECT v.id, v.version, v.created_at, v.note, v.applied_changeset_id,
            c.name AS changeset_name, c.status AS changeset_status
       FROM mapping_versions v
       LEFT JOIN mapping_changesets c ON c.id=v.applied_changeset_id
      ORDER BY v.version DESC`);
  return rows.map((r) => ({
    ...r,
    version: Number(r.version),
    id: Number(r.id),
    applied_changeset_id: r.applied_changeset_id != null ? Number(r.applied_changeset_id) : null,
  }));
}

export { STATUS_LABEL };

/**
 * mapping_inputs（原始录入材料）-> url_mappings（生效映射）的同步与版本化提交。
 *
 * 历史上这里会 TRUNCATE url_mappings；引入映射版本与变更集后改为“差异同步”：
 *  - 保留未改动键的 mapping id（迁移方案条目外键不断）；
 *  - 冲突键置 conflicted：不挑赢家、不静默覆盖；
 *  - 每次有实际改动的提交都令 mapping_versions 前进一个版本，
 *    受影响 canonical key 的验证裁决/逐跳证据标 stale，
 *    基于旧版本建立的迁移方案（未发布）整体标 stale —— 旧证据不再放行。
 */
import { analyzeInputs } from './ambiguity.js';

export class MappingError extends Error {
  constructor(status, code, message, extra = {}) {
    super(message);
    this.statusCode = status;
    this.code = code;
    Object.assign(this, extra);
  }
}

export async function getCurrentVersion(client) {
  const { rows } = await client.query(
    'SELECT max(version)::int AS v FROM mapping_versions');
  return rows[0].v ?? 1;
}

async function snapshotMappings(client) {
  const { rows } = await client.query('SELECT * FROM url_mappings ORDER BY id');
  return rows;
}

/**
 * 按 mapping_inputs 差异同步 url_mappings（不提交事务、不碰版本/证据）。
 * @returns {{total:number, conflicted:number, changedKeys:Set<string>,
 *            before:Map<string,object>, after:Map<string,object>}}
 */
export async function syncMappingsFromInputs(client, { newVersion } = {}) {
  const beforeRows = await snapshotMappings(client);
  const before = new Map(beforeRows.map((m) => [m.source_norm, m]));

  const { rows } = await client.query('SELECT * FROM mapping_inputs ORDER BY id');
  const { groups, ambiguous } = analyzeInputs(rows);
  const conflict = new Set(ambiguous.map((a) => a.source_norm));

  // 删除已不在材料中的生效行（plan_items.mapping_id 由 ON DELETE SET NULL 置空）
  const liveKeys = [...groups.keys()];
  if (before.size) {
    await client.query(
      `DELETE FROM url_mappings WHERE source_norm <> ALL ($1::text[])`,
      [liveKeys]);
  }

  for (const [sourceNorm, items] of groups) {
    const first = items[0];
    const status = conflict.has(sourceNorm) ? 'conflicted' : 'active';
    const note = conflict.has(sourceNorm)
      ? '同归一化键存在多个不同目标，待人工裁决'
      : first.note ?? null;
    const old = before.get(sourceNorm);
    if (!old) {
      await client.query(
        `INSERT INTO url_mappings
           (source_raw, source_norm, target_raw, target_norm, mapping_type,
            status, note, mapping_version)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
        [first.source_raw, sourceNorm, first.target_raw, first.target_norm,
         first.mapping_type, status, note, newVersion ?? 1]);
    } else {
      await client.query(
        `UPDATE url_mappings
            SET source_raw=$2, target_raw=$3, target_norm=$4,
                mapping_type=$5, status=$6, note=$7,
                mapping_version=CASE WHEN $8::bigint IS NULL THEN mapping_version ELSE $8 END
          WHERE id=$1`,
        [old.id, first.source_raw, first.target_raw, first.target_norm,
         first.mapping_type, status, note, newVersion ?? null]);
    }
  }

  const afterRows = await snapshotMappings(client);
  const after = new Map(afterRows.map((m) => [m.source_norm, m]));

  const changedKeys = new Set();
  for (const [k, a] of after) {
    const b = before.get(k);
    if (!b
      || b.target_norm !== a.target_norm
      || b.source_raw !== a.source_raw
      || b.target_raw !== a.target_raw
      || b.mapping_type !== a.mapping_type
      || b.status !== a.status) {
      changedKeys.add(k);
    }
  }
  for (const k of before.keys()) if (!after.has(k)) changedKeys.add(k);

  return { total: groups.size, conflicted: conflict.size, changedKeys, before, after };
}

/**
 * 把受影响 canonical key 的旧验证裁决/逐跳证据标为过期（行保留作审计）。
 */
async function markEvidenceStale(client, keys) {
  if (!keys.size) return;
  const list = [...keys];
  await client.query(
    `UPDATE verification_verdicts SET stale=true
      WHERE source_norm = ANY ($1::text[]) AND stale=false`, [list]);
  await client.query(
    `UPDATE crawl_results SET stale=true
      WHERE source_norm = ANY ($1::text[]) AND stale=false`, [list]);
}

/**
 * 旧版本上建立、尚未发布的迁移方案整体过期；已发布方案是历史事实，不动。
 */
async function markPlansStale(client, oldVersion, newVersion) {
  await client.query(
    `UPDATE migration_plans
        SET stale=true
      WHERE status <> 'published' AND stale=false
        AND base_mapping_version < $1`,
    [newVersion]);
  // 方案内条目随之失去可发布状态（verified 也要重新验证）
  await client.query(
    `UPDATE migration_plan_items pi
        SET item_status='blocked'
       FROM migration_plans p
      WHERE pi.plan_id=p.id AND p.stale=true AND pi.item_status='verified'`);
  void oldVersion;
}

/**
 * 统一的映射改动提交入口：调用方已在同一事务内完成对 mapping_inputs 的写操作。
 *  - 差异同步生效表；
 *  - 有实际改动才推进 mapping_versions；
 *  - 旧证据与旧方案标过期。
 *
 * @param {import('pg').PoolClient} client
 * @param {{changesetId?:number|null, note?:string, lock?:boolean}} [opts]
 */
export async function commitMappingChange(client, opts = {}) {
  if (opts.lock !== false) {
    // 序列化所有映射提交：变更集应用互斥，版本号严格单调
    await client.query('SELECT pg_advisory_xact_lock(734771)');
  }
  const oldVersion = await getCurrentVersion(client);
  const { total, conflicted, changedKeys, before, after } =
    await syncMappingsFromInputs(client, { newVersion: oldVersion + 1 });

  let newVersion = oldVersion;
  if (changedKeys.size) {
    newVersion = oldVersion + 1;
    await client.query(
      `INSERT INTO mapping_versions (version, note, applied_changeset_id)
       VALUES ($1,$2,$3)`,
      [newVersion, opts.note ?? null, opts.changesetId ?? null]);
    await markEvidenceStale(client, changedKeys);
    await markPlansStale(client, oldVersion, newVersion);
  }
  return { oldVersion, newVersion, versionMoved: newVersion !== oldVersion,
           total, conflicted, changedKeys: [...changedKeys], before, after };
}

/**
 * 向后兼容包装：重算生效映射（直接录入/整改脚本使用）。
 * 注意：必须运行在调用方事务内；版本推进与证据过期由 commitMappingChange 完成。
 */
export async function recomputeMappings(client, opts = {}) {
  if (opts.bumpVersion === false) {
    // 仅种子等“初始化”场景：同步但不推进版本
    const { total, conflicted } = await syncMappingsFromInputs(client, { newVersion: 1 });
    return { total, conflicted };
  }
  const r = await commitMappingChange(client, { note: opts.note ?? '直接录入/脚本改动' });
  return { total: r.total, conflicted: r.conflicted, version: r.newVersion };
}

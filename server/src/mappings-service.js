/**
 * mapping_inputs（原始录入材料）-> url_mappings（生效映射）的重算。
 * 冲突键置 conflicted：不挑赢家、不静默覆盖。
 *
 * 重算总是在调用方的事务内进行，并用调用方给定（或当前最新）的
 * mapping_versions 版本戳给整表加盖 mapping_version——任何“半套改动”
 * 在事务回滚时都不会留下版本戳。
 */
import { analyzeInputs } from './ambiguity.js';

/** 当前生效映射版本号（至少为 baseline 1） */
export async function currentVersion(client) {
  const { rows } = await client.query('SELECT max(version) AS v FROM mapping_versions');
  return Number(rows[0].v ?? 1);
}

/** 推进版本线：label 说明来源（直接录入 / 变更集 #id） */
export async function createVersion(client, { label, changesetId = null }) {
  const { rows } = await client.query(
    `INSERT INTO mapping_versions (label, changeset_id) VALUES ($1, $2)
     RETURNING version, label, changeset_id, created_at`,
    [label, changesetId]);
  return { ...rows[0], version: Number(rows[0].version) };
}

/** 取出某个版本视角下的全量生效映射快照（用于冻结 / 三方差异） */
export async function snapshotMappings(client, version = null) {
  const v = version ?? (await currentVersion(client));
  const { rows } = await client.query(
    `SELECT source_raw, source_norm, target_raw, target_norm, mapping_type, status, note
       FROM url_mappings
      WHERE mapping_version = (
              SELECT max(mapping_version) FROM url_mappings
                 WHERE mapping_version <= $1)
      ORDER BY source_norm`, [v]);
  return rows;
}

export async function recomputeMappings(client, version = null) {
  const v = version ?? (await currentVersion(client));
  const { rows } = await client.query('SELECT * FROM mapping_inputs ORDER BY id');
  const { groups, ambiguous } = analyzeInputs(rows);
  const conflict = new Set(ambiguous.map((a) => a.source_norm));
  // 整表重写：migration_plan_items.mapping_id 为 ON DELETE SET NULL，
  // 旧方案条目连同其中冻结的 evidence JSON 保留，供“已过期”审计。
  await client.query('DELETE FROM url_mappings');
  for (const [sourceNorm, items] of groups) {
    const first = items[0];
    await client.query(
      `INSERT INTO url_mappings
         (source_raw, source_norm, target_raw, target_norm, mapping_type, status, note, mapping_version)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [first.source_raw, sourceNorm, first.target_raw, first.target_norm,
       first.mapping_type, conflict.has(sourceNorm) ? 'conflicted' : 'active',
       first.note ?? null, v]);
  }
  return { conflicted: conflict.size, total: groups.size, version: v };
}

/**
 * 整改脚本（演示“填完表 ≠ 完成”的正确后续动作）：
 *  1. 业务裁决歧义：保留 /articles/123，删除错误导入 /articles/999；
 *  2. 删除错误的大小写录入 /News/123（旧站本无此资源）；
 *  3. 剔除非本站地址（example.com 不属于本次迁移范围）；
 *  4. 更新原始材料里 /loop/a 的目标为修复后真实落点，再版本化提交：
 *     生效映射重算、映射版本前进、旧验证证据与方案标过期。
 * 长链与环的修复在站点侧（FIXTURE_MODE=fixed 模拟已上线的修复配置）。
 *
 * 运行：FIXTURE_MODE=fixed node scripts/remediate.js
 */
import { pool } from '../server/src/db.js';
import { normalize } from '../server/src/normalize.js';
import { commitMappingChange } from '../server/src/mappings-service.js';
import { fixtureOrigin } from '../server/src/config.js';

const O = fixtureOrigin();
const client = await pool.connect();
try {
  await client.query('BEGIN');

  // 1) 歧义裁决：/news/123 唯一目标 /articles/123，删除指向 999 的错误录入
  const wrong999 = normalize(`${O}/articles/999`).normKey;
  const newsKey = normalize(`${O}/news/123`).normKey;
  const r1 = await client.query(
    'DELETE FROM mapping_inputs WHERE source_norm=$1 AND target_norm=$2',
    [newsKey, wrong999]);
  console.log(`歧义裁决：删除错误录入 ${r1.rowCount} 条（错误目标 /articles/999）`);

  // 2) 大小写错误录入：/News/123 在旧站不存在，不是合法旧址
  const badCase = normalize(`${O}/News/123`).normKey;
  const r2 = await client.query('DELETE FROM mapping_inputs WHERE source_norm=$1', [badCase]);
  console.log(`剔除大小写错误录入 ${r2.rowCount} 条（/News/123 旧站 404）`);

  // 3) 非本站地址不纳入本次迁移
  const r3 = await client.query(
    "DELETE FROM mapping_inputs WHERE source_raw LIKE 'http://example.com%'");
  console.log(`剔除非白名单站点录入 ${r3.rowCount} 条`);

  // 4) 环已在站点侧打断：把 /loop/a 的原始声明目标改成修复后的真实落点
  const loopKey = normalize(`${O}/loop/a`).normKey;
  const r4 = await client.query(
    `UPDATE mapping_inputs
        SET target_raw=$2, target_norm=$3, note='环已打断，直跳到科技文章'
      WHERE source_norm=$1`,
    [loopKey, `${O}/articles/tech/42`, normalize(`${O}/articles/tech/42`).normKey]);
  console.log(`环修复：更新 /loop/a 的声明目标 ${r4.rowCount} 条`);

  const r = await commitMappingChange(client, { note: '整改脚本：裁决歧义/剔除错误录入/更新环目标' });
  console.log(`重算生效映射：${r.total} 条，冲突 ${r.conflicted} 条；`
    + `映射版本 v${r.oldVersion} → v${r.newVersion}`);
  console.log(`旧验证证据已对 ${r.changedKeys.length} 个键标为过期，需重新验证`);
  await client.query('COMMIT');
} catch (e) {
  await client.query('ROLLBACK');
  throw e;
} finally {
  client.release();
  await pool.end();
}

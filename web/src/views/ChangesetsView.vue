<template>
  <div class="panel">
    <h2>映射变更集 —— 冻结版本、先审阅后应用</h2>
    <p class="muted small">
      临近发布时多编辑并行修改同一张规范化旧址：创建变更集即冻结当时的映射版本、
      规范化后的改动行与生效映射快照。应用时在单事务内做版本冲突检测、
      规范化歧义与生效映射重算；外网目标、无效编码或冲突项会导致整体拒绝，
      绝不留下半套改动。
    </p>

    <label class="field">
      <span>变更集名称</span>
      <input v-model="name" placeholder="例：2026 秋季栏目迁移批次 A" />
    </label>
    <label class="field">
      <span>幂等键（可选，重复提交同一已应用变更集返回同一结果）</span>
      <input v-model="idempotencyKey" placeholder="例：ticket-COLUMN-AUTUMN-A" />
    </label>

    <table>
      <thead>
        <tr><th style="width:110px">操作</th><th>原始旧址 URL</th><th>目标 URL / 删除裁决</th>
            <th style="width:150px">类型</th><th style="width:40px"></th></tr>
      </thead>
      <tbody>
        <tr v-for="(row, i) in rows" :key="i">
          <td>
            <select v-model="row.op">
              <option value="upsert">新增/修改</option>
              <option value="delete">删除裁决</option>
            </select>
          </td>
          <td><input v-model="row.source_raw" placeholder="http://127.0.0.1:4568/old/..."></td>
          <td>
            <input v-if="row.op === 'upsert'" v-model="row.target_raw" placeholder="http://127.0.0.1:4568/new/...">
            <span v-else class="muted small">删除：该旧址从生效映射中移除，期望 410/404 由站点侧保证</span>
          </td>
          <td>
            <select v-if="row.op === 'upsert'" v-model="row.mapping_type">
              <option value="manual">迁移</option>
              <option value="deleted">已删除</option>
            </select>
          </td>
          <td><a href="#" @click.prevent="rows.splice(i,1)">✕</a></td>
        </tr>
      </tbody>
    </table>
    <div class="row" style="margin-top:8px">
      <button class="btn secondary" @click="addRow">+ 一行改动</button>
      <button class="btn" @click="create(false)" :disabled="busy">创建为草稿</button>
      <button class="btn" @click="create(true)" :disabled="busy">创建并提交审阅</button>
      <span v-if="error" class="badge bad">{{ error }}</span>
    </div>
  </div>

  <div class="panel">
    <h2>变更集列表（当前生效映射版本 v{{ currentVersion }}）</h2>
    <table>
      <thead>
        <tr><th>#</th><th>名称</th><th>状态</th><th>冻结版本</th><th>应用版本</th>
            <th>改动/问题</th><th>冲突</th><th>创建</th><th></th></tr>
      </thead>
      <tbody>
        <tr v-for="c in list" :key="c.id">
          <td>{{ c.id }}</td>
          <td>{{ c.name }}</td>
          <td><span class="badge" :class="statusClass(c.status)">{{ statusText(c.status) }}</span></td>
          <td>v{{ c.base_version }}<span v-if="Number(c.base_version) !== Number(currentVersion)" class="badge warn" style="margin-left:4px">版本已前进</span></td>
          <td>{{ c.applied_version ? `v${c.applied_version}` : '—' }}</td>
          <td>{{ c.change_count }} 项<span v-if="Number(c.issue_count)"> / <span style="color:var(--bad)">{{ c.issue_count }} 问题</span></span></td>
          <td><span v-if="c.has_conflicts" class="badge bad">三方差异</span><span v-else>—</span></td>
          <td class="small muted">{{ fmt(c.created_at) }}</td>
          <td style="white-space:nowrap"><a href="#" @click.prevent="open(c.id)">查看</a></td>
        </tr>
      </tbody>
    </table>
  </div>

  <!-- 详情：差异 / 冲突 / 历史 -->
  <div class="panel" v-if="detail">
    <h2>
      变更集 #{{ detail.changeset.id }}：{{ detail.changeset.name }}
      <span class="badge" :class="statusClass(detail.changeset.status)" style="margin-left:8px">
        {{ statusText(detail.changeset.status) }}
      </span>
    </h2>
    <p class="small muted">
      冻结于 v{{ detail.changeset.base_version }}（{{ fmt(detail.changeset.created_at) }}）；
      当前映射 v{{ detail.current_version }}
      <template v-if="detail.changeset.applied_version">；应用于 v{{ detail.changeset.applied_version }}（{{ fmt(detail.changeset.applied_at) }}）</template>
      <template v-if="detail.changeset.idempotency_key">；幂等键 <span class="mono">{{ detail.changeset.idempotency_key }}</span></template>
    </p>

    <div v-if="detail.changeset.status === 'draft'" class="row">
      <button class="btn" @click="submit(detail.changeset.id)" :disabled="busy">提交审阅</button>
      <button class="btn secondary" @click="abandon(detail.changeset.id)" :disabled="busy">放弃</button>
    </div>
    <div v-else-if="detail.changeset.status === 'reviewable'" class="row">
      <button class="btn" @click="apply(detail.changeset.id)" :disabled="busy">应用（事务 + 版本检测）</button>
      <button class="btn secondary" @click="reapplySame(detail.changeset.id)" :disabled="busy">重复应用（验证幂等）</button>
      <button class="btn secondary" @click="abandon(detail.changeset.id)" :disabled="busy">放弃</button>
    </div>
    <div v-else-if="detail.changeset.status === 'applied'" class="row">
      <button class="btn secondary" @click="reapplySame(detail.changeset.id)" :disabled="busy">重复提交同一已应用变更集</button>
    </div>

    <div v-if="reject" class="callout bad">
      <b>整体拒绝（事务已回滚，当前映射毫无变化）：</b>{{ reject.error }}
      <ul v-if="reject.validation?.length">
        <li v-for="(v, k) in reject.validation" :key="k">
          第 {{ v.index >= 0 ? v.index + 1 : '—' }} 行（{{ v.op || '?' }}）
          <span class="mono">{{ v.source_raw || v.source_norm || '' }}</span>：{{ v.reason }}
        </li>
      </ul>
    </div>

    <!-- 校验问题（冻结时即存在；不允许进入应用） -->
    <div v-if="validation.length" class="callout bad">
      <b>冻结时的校验问题：</b>
      <ul>
        <li v-for="(v, k) in validation" :key="k">
          第 {{ v.index >= 0 ? v.index + 1 : '—' }} 行（{{ v.op || '?' }}）
          <span class="mono">{{ v.source_raw || v.source_norm || '' }}</span>：{{ v.reason }}
        </li>
      </ul>
    </div>

    <!-- 冲突三方差异：base（冻结版本） / current（并发方） / proposed（本变更集） -->
    <div v-if="conflicts.length" class="callout bad">
      <b>三方差异：以下 canonical key 在冻结版本后已被别的变更集改动，本变更集过期、不覆盖：</b>
      <table style="margin-top:8px">
        <thead><tr><th>canonical key / 操作</th><th>base（冻结 v{{ detail.changeset.base_version }}）</th>
                   <th>current（并发方 v{{ detail.current_version }}）</th><th>proposed（本变更集）</th></tr></thead>
        <tbody>
          <tr v-for="(x, k) in conflicts" :key="k">
            <td class="mono">{{ x.source_norm }}<br><span class="small muted">{{ x.op }}</span></td>
            <td class="mono small">{{ side(x.base) }}</td>
            <td class="mono small">{{ side(x.current) }}</td>
            <td class="mono small">{{ side(x.proposed) }}</td>
          </tr>
        </tbody>
      </table>
    </div>

    <h3 style="margin-top:14px">逐条差异（{{ detail.items.length }}）</h3>
    <table>
      <thead><tr><th>类型</th><th>canonical key（原始旧址）</th><th>base 冻结版本</th>
                 <th>current 当前</th><th>proposed 本变更集</th></tr></thead>
      <tbody>
        <tr v-for="(it, k) in detail.items" :key="k" :style="it.changed_by_other ? 'background:rgba(248,81,73,.08)' : ''">
          <td>
            <span class="badge" :class="it.change_kind === 'add' ? 'ok' : it.change_kind === 'delete' ? 'bad' : 'warn'">
              {{ kindText(it.change_kind) }}
            </span>
            <span v-if="it.changed_by_other" class="badge bad" style="margin-left:4px">已被他人修改</span>
          </td>
          <td class="mono small">{{ it.source_norm }}<br><span class="muted">{{ it.source_raw }}</span></td>
          <td class="mono small">{{ itemSide(it.base) }}</td>
          <td class="mono small">{{ itemSide(it.current) }}</td>
          <td class="mono small">{{ itemSide(it.proposed) }}</td>
        </tr>
      </tbody>
    </table>

    <details style="margin-top:10px">
      <summary class="small muted">审计：创建时逐字原始输入 payload</summary>
      <pre class="mono small" style="overflow:auto">{{ JSON.stringify(detail.changeset.payload, null, 2) }}</pre>
    </details>
  </div>

  <div class="panel">
    <h2>映射版本历史（证据与方案均绑定到具体版本）</h2>
    <table>
      <thead><tr><th>版本</th><th>说明</th><th>来源变更集</th><th>时间</th></tr></thead>
      <tbody>
        <tr v-for="v in versions" :key="v.version">
          <td>v{{ v.version }}</td>
          <td>{{ v.label }}</td>
          <td class="small">{{ v.changeset_id ? `#${v.changeset_id} ${v.changeset_name ?? ''}（${statusText(v.changeset_status)}）` : '—' }}</td>
          <td class="small muted">{{ fmt(v.created_at) }}</td>
        </tr>
      </tbody>
    </table>
  </div>
</template>

<script setup>
import { onMounted, ref } from 'vue';
import { api } from '../api.js';

const O = 'http://127.0.0.1:4568';
const list = ref([]);
const versions = ref([]);
const currentVersion = ref(1);
const name = ref('');
const idempotencyKey = ref('');
const rows = ref([{ op: 'upsert', source_raw: `${O}/new-column/1`, target_raw: `${O}/sections/new/1`, mapping_type: 'manual' }]);
const busy = ref(false);
const error = ref('');
const detail = ref(null);
const reject = ref(null);

function addRow() { rows.value.push({ op: 'upsert', source_raw: '', target_raw: '', mapping_type: 'manual' }); }
function statusText(s) {
  return { draft: '草稿', reviewable: '可审阅', applied: '已应用', expired: '已过期', abandoned: '已放弃' }[s] || s;
}
function statusClass(s) {
  return { draft: 'neutral', reviewable: 'warn', applied: 'ok', expired: 'bad', abandoned: 'neutral' }[s] || 'neutral';
}
function kindText(k) { return { add: '新增', modify: '修改', delete: '删除' }[k] || k; }
function fmt(ts) { return ts ? new Date(ts).toLocaleString('zh-CN') : '—'; }
function side(r) {
  if (!r) return '∅（不存在）';
  if (r.deleted) return '✕ 删除裁决';
  return `${r.target_norm} [${r.mapping_type}/${r.status}]`;
}
function itemSide(r) {
  if (!r) return '∅';
  if (r.deleted) return '✕ 删除';
  if (!r.exists) return '∅';
  return `${r.target_norm} [${r.mapping_type}${r.status === 'conflicted' ? '/conflicted' : ''}]`;
}

async function load() {
  const d = await api.changesets();
  list.value = d.changesets; currentVersion.value = d.current_version;
  const v = await api.versions();
  versions.value = v.versions;
}
async function open(id) {
  detail.value = await api.changeset(id);
  reject.value = null;
}
async function create(submit) {
  busy.value = true; error.value = '';
  try {
    const changes = rows.value
      .filter((r) => r.source_raw.trim())
      .map((r) => (r.op === 'delete'
        ? { op: 'delete', source_raw: r.source_raw.trim() }
        : {
            op: 'upsert', source_raw: r.source_raw.trim(),
            target_raw: r.target_raw.trim(), mapping_type: r.mapping_type,
          }));
    const payload = {
      name: name.value.trim() || `变更集 ${new Date().toLocaleString('zh-CN')}`,
      idempotency_key: idempotencyKey.value.trim() || undefined,
      changes,
    };
    const r = await api.createChangeset(payload);
    const cs = r.changeset;
    let openedId = cs.id;
    if (submit && (!cs.validation || cs.validation.length === 0)) {
      await api.submitChangeset(cs.id);
    }
    await load();
    await open(openedId);
    name.value = ''; idempotencyKey.value = '';
    rows.value = [{ op: 'upsert', source_raw: '', target_raw: '', mapping_type: 'manual' }];
  } catch (e) { error.value = e.message; }
  finally { busy.value = false; }
}
async function submit(id) {
  try { await api.submitChangeset(id); await open(id); await load(); }
  catch (e) { error.value = e.message; }
}
async function apply(id) {
  busy.value = true; reject.value = null;
  try {
    const r = await api.applyChangeset(id);
    if (r.expired || r.rejected) reject.value = r;
    await load(); await open(id);
  } catch (e) {
    reject.value = e.body ?? { error: e.message };
    await open(id);
  } finally { busy.value = false; }
}
async function reapplySame(id) {
  busy.value = true;
  try {
    const r = await api.applyChangeset(id);
    if (r.idempotent) alert(`幂等返回：变更集已是「${statusText(r.changeset?.status)}」，应用结果与首次相同（v${r.applied_version ?? r.changeset?.applied_version ?? '—'}）`);
    await load(); await open(id);
  } catch (e) { reject.value = e.body ?? { error: e.message }; }
  finally { busy.value = false; }
}
async function abandon(id) {
  await api.abandonChangeset(id); await open(id); await load();
}
onMounted(load);
</script>

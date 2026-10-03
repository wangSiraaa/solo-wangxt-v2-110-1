<template>
  <div class="panel">
    <h2>映射变更集 —— 改动先审阅，再决定是否动生效映射</h2>
    <p class="muted small">
      每个变更集创建时<b>冻结当前映射版本</b>（当前：v{{ currentVersion }}）；
      多个编辑可并行起草，应用时在一个事务内按当前版本检测冲突、重算规范化歧义和生效映射。
      外网目标、无效编码、未裁决歧义整组拒绝；应用成功后旧验证证据与迁移方案立即标为过期，
      须重新验证、重建方案才能发布。
    </p>
    <div class="row" style="align-items:flex-end">
      <label class="field" style="flex:3">
        <span>变更集名称</span>
        <input v-model="newName" placeholder="例：2026 秋改版第三批映射" />
      </label>
      <div style="flex:1">
        <button class="btn" @click="create">新建变更集（草稿）</button>
      </div>
    </div>

    <table style="margin-top:10px">
      <thead>
        <tr><th>ID</th><th>名称</th><th>状态</th><th>条目</th><th>冻结版本</th><th>应用版本</th><th></th></tr>
      </thead>
      <tbody>
        <tr v-for="c in list" :key="c.id">
          <td>{{ c.id }}</td>
          <td>{{ c.name }}<div class="small muted">{{ c.description }}</div></td>
          <td><span class="badge" :class="statusClass(c.status)">{{ statusText(c.status) }}</span></td>
          <td>{{ c.item_count }}</td>
          <td>v{{ c.base_mapping_version }}</td>
          <td>{{ c.applied_version ? `v${c.applied_version}` : '—' }}</td>
          <td style="white-space:nowrap">
            <a href="#" @click.prevent="open(c.id)">查看差异/冲突</a>
            <template v-if="c.status === 'draft'">
              · <a href="#" @click.prevent="submit(c.id)">提交审阅</a>
              · <a href="#" class="muted" @click.prevent="abandon(c.id)">放弃</a>
            </template>
            <template v-else-if="c.status === 'in_review'">
              · <a href="#" @click.prevent="apply(c.id)"><b>应用</b></a>
              · <a href="#" class="muted" @click.prevent="abandon(c.id)">放弃</a>
            </template>
          </td>
        </tr>
      </tbody>
    </table>
  </div>

  <div class="panel" v-if="detail">
    <h2>
      变更集 #{{ detail.changeset.id }}：{{ detail.changeset.name }}
      <span class="badge" :class="statusClass(detail.changeset.status)" style="margin-left:8px">
        {{ statusText(detail.changeset.status) }}
      </span>
    </h2>
    <p class="muted small">
      冻结于映射版本 <b>v{{ detail.changeset.base_mapping_version }}</b>；
      当前版本 <b>v{{ detail.current_version }}</b>
      <template v-if="detail.changeset.applied_version">
        ；已应用为 <b>v{{ detail.changeset.applied_version }}</b>
      </template>
    </p>

    <!-- 整组校验问题 -->
    <div v-if="detail.validation.rejected.length" class="callout bad">
      <b>整组校验未通过（{{ detail.validation.rejected.length }}）——外网目标/无效编码/未裁决歧义不会半套落库：</b>
      <table style="margin-top:8px">
        <thead><tr><th>条目</th><th>原因</th></tr></thead>
        <tbody>
          <tr v-for="r in detail.validation.rejected" :key="r.index">
            <td class="mono">{{ r.source_raw }}</td><td>{{ r.reason }}</td>
          </tr>
        </tbody>
      </table>
    </div>

    <!-- 版本冲突：三方差异 -->
    <div v-if="detail.conflicts.length" class="callout bad">
      <b>⚠️ 版本冲突（base / theirs / ours 三方差异，不覆盖先应用者的结果）：</b>
      <table style="margin-top:8px">
        <thead>
          <tr><th>canonical key</th><th>base（冻结基线）</th><th>theirs（当前生效）</th><th>ours（本变更集）</th></tr>
        </thead>
        <tbody>
          <tr v-for="(c, i) in detail.conflicts" :key="i">
            <td class="mono small">{{ c.source_norm }}</td>
            <td class="mono small">{{ fmtSide(c.base) }}</td>
            <td class="mono small" style="color:var(--ok)">{{ fmtSide(c.theirs) }}</td>
            <td class="mono small" style="color:var(--warn)">{{ fmtSide(c.ours) }}</td>
          </tr>
        </tbody>
      </table>
    </div>

    <!-- 草稿编辑 -->
    <template v-if="detail.changeset.status === 'draft'">
      <h3>添加原始 URL 改动</h3>
      <div class="row">
        <label class="field" style="flex:1">
          <span>操作</span>
          <select v-model="form.operation">
            <option value="add">新增（add）</option>
            <option value="modify">修改/裁决（modify）</option>
            <option value="remove">删除（remove）</option>
          </select>
        </label>
        <label class="field" style="flex:2">
          <span>类型</span>
          <select v-model="form.mapping_type">
            <option value="manual">迁移到新栏目</option>
            <option value="deleted">已删除裁决（期望 410/404）</option>
          </select>
        </label>
      </div>
      <label class="field">
        <span>原始旧址 URL（保留大小写、%XX、尾斜杠、追踪参数等真实写法）</span>
        <input v-model="form.source_raw" placeholder="http://127.0.0.1:4568/news/123" />
      </label>
      <label class="field" v-if="form.operation !== 'remove'">
        <span>目标 URL（已删除裁决可留空，默认旧址自身）</span>
        <input v-model="form.target_raw" placeholder="http://127.0.0.1:4568/articles/123" />
      </label>
      <div style="margin:8px 0">
        <button class="btn" @click="addItem">加入变更集</button>
        <span v-if="formError" class="badge bad" style="margin-left:10px">{{ formError }}</span>
      </div>
    </template>

    <!-- 条目与差异 -->
    <h3>条目（{{ detail.items.length }}）与相对冻结基线的差异</h3>
    <table>
      <thead>
        <tr><th>操作</th><th>原始旧址</th><th>基线 before</th><th>本变更集 after</th><th></th></tr>
      </thead>
      <tbody>
        <tr v-for="(it, i) in detail.items" :key="it.id">
          <td><span class="badge" :class="opClass(it.effective_operation)">{{ opText(it.effective_operation) }}</span></td>
          <td class="mono small">{{ it.source_raw }}<div class="muted">{{ it.mapping_type === 'deleted' ? '已删除裁决' : '迁移' }}</div></td>
          <td class="mono small muted">{{ fmtSide(detail.diffs[i]?.before) }}</td>
          <td class="mono small">{{ fmtSide(detail.diffs[i]?.after) }}</td>
          <td>
            <a v-if="detail.changeset.status === 'draft'" href="#"
               @click.prevent="removeItem(it.id)">移除</a>
          </td>
        </tr>
      </tbody>
    </table>

    <!-- 应用结果（审计） -->
    <div v-if="detail.apply_result" class="callout"
         :class="detail.apply_result.applied ? 'ok' : 'bad'" style="margin-top:10px">
      <b>应用结果（持久化，重复应用返回同一结果）：</b>
      <pre class="mono small" style="white-space:pre-wrap">{{ JSON.stringify(detail.apply_result, null, 2) }}</pre>
    </div>
  </div>

  <div class="panel">
    <h2>映射版本历史</h2>
    <table>
      <thead><tr><th>版本</th><th>时间</th><th>来源变更集</th><th>说明</th></tr></thead>
      <tbody>
        <tr v-for="v in versions" :key="v.id">
          <td><b>v{{ v.version }}</b></td>
          <td class="small">{{ fmt(v.created_at) }}</td>
          <td>{{ v.applied_changeset_id ? `#${v.applied_changeset_id} ${v.changeset_name ?? ''}` : '—' }}</td>
          <td class="small muted">{{ v.note }}</td>
        </tr>
      </tbody>
    </table>
  </div>
</template>

<script setup>
import { onMounted, ref } from 'vue';
import { api } from '../api.js';

const list = ref([]);
const detail = ref(null);
const versions = ref([]);
const currentVersion = ref(1);
const newName = ref('');
const form = ref({ operation: 'add', mapping_type: 'manual', source_raw: '', target_raw: '' });
const formError = ref('');

async function load() {
  list.value = await api.changesets();
  currentVersion.value = list.value[0]?.current_version ?? 1;
  versions.value = await api.mappingVersions();
  if (detail.value) await open(detail.value.changeset.id);
}
async function create() {
  if (!newName.value.trim()) return;
  const c = await api.createChangeset({ name: newName.value.trim() });
  newName.value = '';
  await load();
  await open(c.id);
}
async function open(id) { detail.value = await api.changeset(id); }
async function addItem() {
  formError.value = '';
  try {
    await api.addChangesetItem(detail.value.changeset.id, { ...form.value });
    form.value = { ...form.value, source_raw: '', target_raw: '' };
    await load();
  } catch (e) { formError.value = e.message; }
}
async function removeItem(itemId) {
  await api.deleteChangesetItem(detail.value.changeset.id, itemId);
  await load();
}
async function submit(id) {
  try {
    await api.submitChangeset(id);
  } catch (e) {
    alert(e.body?.rejected?.map((r) => `• ${r.source_raw}: ${r.reason}`).join('\n') || e.message);
  }
  await load();
}
async function apply(id) {
  try {
    await api.applyChangeset(id);
  } catch (e) {
    if (e.status === 409 && e.body?.expired) {
      alert('该变更集已过期：触及的 canonical key 已被先应用的变更集改动。\n请查看三方差异（base/theirs/ours）后重建变更集。');
    } else {
      alert(e.message);
    }
  }
  await load();
}
async function abandon(id) {
  const reason = prompt('放弃原因（可选）') ?? '';
  await api.abandonChangeset(id, reason);
  if (detail.value?.changeset.id === id) detail.value = null;
  await load();
}

function statusText(s) {
  return { draft: '草稿', in_review: '可审阅', applied: '已应用', stale: '已过期', abandoned: '已放弃' }[s] || s;
}
function statusClass(s) {
  return { draft: 'neutral', in_review: 'warn', applied: 'ok', stale: 'bad', abandoned: 'neutral' }[s] || 'neutral';
}
function opText(op) {
  return { add: '新增', modify: '修改/裁决', remove: '删除' }[op] || op;
}
function opClass(op) {
  return { add: 'ok', modify: 'warn', remove: 'bad' }[op] || 'neutral';
}
function fmtSide(side) {
  if (!side) return '（无 / 新增）';
  if (side.removed) return '🗑 删除该键';
  const type = side.mapping_type === 'deleted' ? '[已删除] ' : '';
  return `${type}${side.target_norm ?? side.target_raw ?? ''}`;
}
function fmt(ts) { return ts ? new Date(ts).toLocaleString('zh-CN') : '—'; }

onMounted(load);
</script>

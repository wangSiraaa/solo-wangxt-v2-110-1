<template>
  <div class="panel">
    <h2>迁移方案</h2>
    <p class="muted small">
      “纳入方案”只是 pending；执行验证后，证据齐全且裁决通过才是 verified。
      方案在纳入时<b>冻结映射版本</b>：之后任何变更集应用都会把旧方案标为
      <span class="badge bad">已过期</span>，发布闸门拒绝旧证据放行，
      必须重新验证并重建方案。
    </p>
    <div class="row" style="align-items:flex-end">
      <label class="field" style="flex:3">
        <span>方案名称</span>
        <input v-model="newName" placeholder="例：2026 秋季栏目改版" />
      </label>
      <div style="flex:1">
        <button class="btn" @click="create">新建方案</button>
      </div>
    </div>
    <table style="margin-top:10px">
      <thead><tr><th>ID</th><th>名称</th><th>状态</th><th>映射版本</th><th>条目</th><th>已验证</th><th>阻断</th><th>待验证</th><th></th></tr></thead>
      <tbody>
        <tr v-for="p in plans" :key="p.id">
          <td>{{ p.id }}</td><td>{{ p.name }}</td>
          <td>
            <span class="badge" :class="p.status === 'published' ? 'ok' : 'neutral'">{{ statusText(p.status) }}</span>
            <span v-if="p.stale && p.status !== 'published'" class="badge bad" style="margin-left:4px">已过期</span>
          </td>
          <td class="small">v{{ p.base_mapping_version }}</td>
          <td>{{ p.items }}</td><td>{{ p.verified }}</td>
          <td :style="Number(p.blocked) ? 'color:var(--bad)' : ''">{{ p.blocked }}</td>
          <td>{{ p.pending }}</td>
          <td style="white-space:nowrap">
            <a href="#" @click.prevent="open(p.id)">查看</a> ·
            <a href="#" @click.prevent="build(p.id)">纳入全部生效映射</a> ·
            <a href="#" @click.prevent="publish(p.id)">尝试发布</a>
          </td>
        </tr>
      </tbody>
    </table>
  </div>

  <div class="panel" v-if="detail">
    <h2>方案 #{{ detail.plan.id }}：{{ detail.plan.name }}（{{ statusText(detail.plan.status) }}）</h2>
    <p class="muted small">
      冻结映射版本 <b>v{{ detail.plan.base_mapping_version }}</b>；当前 <b>v{{ detail.current_mapping_version }}</b>
      <span v-if="detail.stale && detail.plan.status !== 'published'" class="badge bad" style="margin-left:6px">
        证据已过期：重新验证后点“纳入全部生效映射”重建
      </span>
    </p>
    <div v-if="detail.stale && detail.plan.status !== 'published'" class="callout bad">
      ⚠️ 该方案基于旧映射版本，其中的验证证据已被后续变更集标为过期，发布闸门不会放行。
      请先在“验证总览”重新验证，再回到本页重新纳入（重建）。
    </div>
    <div v-if="lastPublish && !lastPublish.published">
      <div class="callout bad">
        <b>发布被拒绝，受影响链接：</b>
        <table style="margin-top:8px">
          <thead><tr><th>旧址</th><th>原因</th></tr></thead>
          <tbody>
            <tr v-for="(b, i) in lastPublish.blockers" :key="i">
              <td class="mono">{{ b.source }}</td><td>{{ b.reason }}</td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>
    <div v-else-if="lastPublish?.published" class="callout ok">
      ✅ 已发布。每条链接均有最终页面状态与逐跳证据。
    </div>
    <table>
      <thead><tr><th>状态</th><th>旧址</th><th>计划目标（含保留的追踪参数）</th><th>裁决证据</th></tr></thead>
      <tbody>
        <tr v-for="it in detail.items" :key="it.id">
          <td>
            <span class="badge" :class="it.item_status === 'verified' ? 'ok' : it.item_status === 'blocked' ? 'bad' : 'neutral'">
              {{ it.item_status === 'verified' ? '已验证' : it.item_status === 'blocked' ? '阻断' : '仅填表' }}
            </span>
          </td>
          <td class="mono">{{ it.source_raw }}</td>
          <td class="mono">{{ it.evidence?.proposed_redirect_url || '（已删除，返回 410/404）' }}</td>
          <td class="small">
            <div>最终状态：{{ it.evidence?.final_status ?? '—' }}；跳数：{{ it.evidence?.hops ?? '—' }}</div>
            <ul v-if="it.evidence?.issues?.length" class="issues">
              <li v-for="(x, k) in it.evidence.issues" :key="k">{{ x }}</li>
            </ul>
          </td>
        </tr>
      </tbody>
    </table>
  </div>
</template>

<script setup>
import { onMounted, ref, watch } from 'vue';
import { api } from '../api.js';
const props = defineProps({ refreshKey: Number });

const plans = ref([]);
const newName = ref('');
const detail = ref(null);
const lastPublish = ref(null);

async function load() { plans.value = await api.plans(); if (detail.value) await open(detail.value.plan.id); }
async function create() {
  if (!newName.value.trim()) return;
  await api.createPlan(newName.value.trim());
  newName.value = '';
  await load();
}
async function open(id) { detail.value = await api.plan(id); lastPublish.value = null; }
async function build(id) {
  const r = await api.buildPlan(id);
  alert(`已纳入 ${r.built} 条生效映射（状态取决于最新验证证据）`);
  await load();
}
async function publish(id) {
  try {
    lastPublish.value = await api.publishPlan(id);
  } catch (e) {
    if (e.status === 409 && e.body) lastPublish.value = e.body;
    else alert(e.message);
  }
  await load();
}
function statusText(s) {
  return { draft: '草稿', ready: '就绪', published: '已发布' }[s] || s;
}
watch(() => props.refreshKey, load);
onMounted(load);
</script>

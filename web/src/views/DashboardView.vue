<template>
  <div class="panel">
    <h2>验证总览 —— 真实请求本地站点，逐跳取证</h2>
    <div class="row" style="align-items:center">
      <p class="muted small" style="flex:3">
        验证器只允许访问随项目启动的本地站点（127.0.0.1:4568）；
        每一跳的状态码、Location、最终状态都落库。映射表填完<b>不等于</b>迁移完成——
        只有这里出现绿色裁决，发布闸门才可能放行。
      </p>
      <div style="flex:1; text-align:right">
        <button class="btn" :disabled="running" @click="runAll">
          {{ running ? '验证中…' : '对全部映射重新验证' }}
        </button>
      </div>
    </div>

    <div v-if="staleKeys > 0" class="callout bad" style="margin-top:8px">
      ⚠️ {{ staleKeys }} 条链接的验证证据来自<b>旧映射版本</b>，已明确标为过期、不再放行发布；
      变更集应用改变了生效映射，必须对当前版本重新验证。
    </div>

    <div class="kpi" style="margin-top:12px">
      <div class="card"><div class="num" style="color:var(--ok)">{{ counts.ok }}</div><div class="lbl">通过（含已删除正确消亡）</div></div>
      <div class="card"><div class="num" style="color:var(--warn)">{{ counts.ambiguity }}</div><div class="lbl">归一化歧义</div></div>
      <div class="card"><div class="num" style="color:var(--bad)">{{ counts.loop + counts.long + counts.badStatus + counts.fetch }}</div><div class="lbl">环/长链/最终页异常/越权</div></div>
      <div class="card"><div class="num">{{ counts.unverified }}</div><div class="lbl">从未验证（仅填表）</div></div>
    </div>
  </div>

  <div class="panel">
    <h2>逐条裁决与证据</h2>
    <table>
      <thead>
        <tr>
          <th>裁决</th><th>旧址（生效映射）</th><th>最终 URL</th><th>最终状态</th>
          <th>跳数</th><th>追踪参数</th><th>版本/证据</th><th>问题 / 证据</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="row in rows" :key="row.source_norm">
          <td><VerdictBadge :verdict="row.verdict" :label="label" /></td>
          <td class="mono">{{ row.source_raw }}</td>
          <td class="mono">{{ row.final_url_raw || '—' }}</td>
          <td>{{ row.final_status ?? '—' }}</td>
          <td>{{ row.hops ?? '—' }}</td>
          <td>
            <span v-if="row.tracker_preserved === true" class="badge ok">已保留</span>
            <span v-else-if="row.tracker_preserved === false" class="badge bad">丢失</span>
            <span v-else class="badge neutral">—</span>
          </td>
          <td>
            <div class="small">证据 v{{ row.verdict_version ?? '—' }} / 当前 v{{ currentVersion }}</div>
            <span v-if="row.verdict_version && Number(row.verdict_version) < Number(currentVersion)" class="badge bad">证据已过期</span>
            <span v-else-if="!row.verdict" class="badge warn">待验证</span>
            <span v-else class="badge ok">当前版本</span>
          </td>
          <td>
            <ul v-if="row.issues && row.issues.length" class="issues">
              <li v-for="(i, k) in row.issues" :key="k">{{ i }}</li>
            </ul>
            <span v-else class="muted small">无</span>
            <div class="small" v-if="row.verified_at">
              <a href="#" @click.prevent="showHops(row)">查看逐跳证据</a>
              · {{ fmt(row.verified_at) }}
            </div>
          </td>
        </tr>
      </tbody>
    </table>
  </div>

  <div class="panel" v-if="hops.length">
    <h2>
      逐跳证据：{{ hopsKey }}
      <span v-if="hopsStale" class="badge bad" style="margin-left:8px">
        该证据来自旧映射版本 v{{ hopsEvidenceVersion }}（当前 v{{ hopsCurrentVersion }}），仅留档、不再放行
      </span>
      <span v-else class="badge ok" style="margin-left:8px">证据版本 v{{ hopsEvidenceVersion }} = 当前版本</span>
    </h2>
    <table>
      <thead><tr><th>#</th><th>请求 URL（规范化）</th><th>状态</th><th>Location（原样）</th><th>错误</th></tr></thead>
      <tbody>
        <tr v-for="h in hops" :key="h.hop_index">
          <td>{{ h.hop_index }}</td>
          <td class="mono">{{ h.url_norm }}</td>
          <td>{{ h.status_code ?? '—' }}</td>
          <td class="mono">{{ h.location_raw || '—' }}</td>
          <td class="mono">{{ h.fetch_error || '' }}</td>
        </tr>
      </tbody>
    </table>
  </div>
</template>

<script setup>
import { computed, onMounted, ref } from 'vue';
import { api } from '../api.js';
import VerdictBadge from '../components/VerdictBadge.vue';

const rows = ref([]);
const label = ref({});
const running = ref(false);
const hops = ref([]);
const hopsKey = ref('');
const hopsStale = ref(false);
const hopsEvidenceVersion = ref(null);
const hopsCurrentVersion = ref(1);
const currentVersion = ref(1);
const staleKeys = ref(0);

const counts = computed(() => {
  const c = { ok: 0, ambiguity: 0, loop: 0, long: 0, badStatus: 0, fetch: 0, unverified: 0 };
  for (const r of rows.value) {
    if (!r.verdict) c.unverified++;
    else if (r.verdict === 'ok' || r.verdict === 'deleted_gone_ok') c.ok++;
    else if (r.verdict === 'ambiguity') c.ambiguity++;
    else if (r.verdict === 'redirect_loop') c.loop++;
    else if (r.verdict === 'chain_too_long') c.long++;
    else if (r.verdict === 'final_status_bad' || r.verdict === 'deleted_not_gone') c.badStatus++;
    else if (r.verdict === 'fetch_error') c.fetch++;
  }
  return c;
});

async function load() {
  const d = await api.mappings();
  label.value = d.verdictLabel;
  currentVersion.value = d.current_version;
  staleKeys.value = d.stale_evidence_keys;
  // 待验证清单以“生效映射”为准，裁决取当前版本（左连接；无当前版本裁决即为待验证）
  rows.value = d.mappings;
}
async function runAll() {
  running.value = true;
  try { await api.verify(); await load(); }
  finally { running.value = false; }
}
async function showHops(row) {
  hopsKey.value = row.source_norm;
  const d = await api.crawl(row.source_norm);
  hops.value = d.hops;
  hopsStale.value = d.stale;
  hopsEvidenceVersion.value = d.evidence_version;
  hopsCurrentVersion.value = d.current_version;
}
function fmt(ts) { return new Date(ts).toLocaleString('zh-CN'); }
onMounted(load);
</script>

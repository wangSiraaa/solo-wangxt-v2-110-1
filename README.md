# URL 迁移验证工作台（Vue 3 + Fastify + PostgreSQL）

内容平台更换栏目结构时，技术负责人需要回答一个问题：**旧链接最终会落到哪里、最终页面状态是什么**。
本项目把“填映射表”和“迁移完成”严格区分开——每条映射只有经过真实 HTTP 请求验证、
拿到逐跳证据并通过发布闸门，才允许发布。

## 它保证了什么

1. **WHATWG URL 规范化**（`server/src/normalize.js`），规则集中、显式：
   - 路径**大小写敏感**：`/News/123` ≠ `/news/123`；
   - 百分号编码只统一十六进制大小写（`%2f→%2F`），**绝不 decode 后合并**；
     原始中文按 UTF-8 编码，`/a%2Fb` 与 `/a/b` 是不同资源；
   - **尾斜杠保留**：`/column/weekly/` ≠ `/column/weekly`；
   - 查询参数：非追踪参数参与资源身份；追踪参数（utm_*、gclid 等）不参与身份，
     但迁移跳转时**原样带到最终 URL**；fragment 丢弃。
2. **只验证随项目启动的本地站点**：白名单 `127.0.0.1:4568`，每一跳的 `Location`
   重新解析并重新过白名单，外网/其它端口一律拒绝（防 SSRF，见 `server/src/verifier.js`）。
3. **检测重定向环、过长链（>5 跳）、多旧址归一后的歧义**：
   - 环：归一化 URL 在同链中重复即停；
   - 长链：超过预算仍给 Location 即 `chain_too_long`；
   - 歧义：多个录入归一到同一键却指向不同目标 → `conflicted`，不挑赢家、阻断发布。
4. **最终页面状态必须核实**：普通迁移期望最终 2xx 且落点严格等于映射目标；
   已删除栏目期望 **410 Gone**（接受 404），不允许 301 到首页蒙混。
5. **PostgreSQL 保存三类数据**：旧新映射（原始材料 `mapping_inputs` + 生效表
   `url_mappings`）、爬取逐跳结果（`crawl_results`）、迁移方案（`migration_plans`
   / `migration_plan_items`），另存每入口最终裁决 `verification_verdicts`。
6. **映射变更集（临近发布的多人协作）**：编辑不再即时改掉验证依据，改动先进入
   `mapping_changesets`（草稿 → 可审阅 → 已应用 / 已过期 / 已放弃）。创建时冻结
   `base_mapping_version` 与生效快照；应用在**单事务**内按当前版本检测冲突、
   重算规范化歧义和生效映射，版本每前进一步（`mapping_versions`），受影响链接的
   旧裁决/逐跳证据与未发布方案立即 **stale**，重新验证、重建方案后才可发布。
   外网目标、无效百分号编码、未裁决歧义一律整组拒绝，绝不落“半套改动”。

## 快速开始

本仓库在无 root 环境中携带了从 Debian 官方包解压的 PostgreSQL 15（arm64，
位于 `tools/`）。如目录不存在，见文末“自备 PostgreSQL”。

```bash
npm install
npm run pg:start        # 启动 tools/ 下的本地 PostgreSQL（127.0.0.1:55432）
npm run migrate         # 建库 + 建表
npm run seed            # 写入 10 条演示录入（含全部异常场景）

npm test                # 27 项测试：规范化规则 + 验证器集成（真实本地站点）
                        #          + 映射变更集 8 项验收（事务/冲突/过期/版本绑定）
npm run verify          # CLI：对全部映射真实请求验证并给出裁决
node scripts/report.js  # 产出 docs/verification-report-before.md 风格的证据报告

npm start               # 本地站点 + API + 已构建的前端
                        # 工作台 http://127.0.0.1:4567 （仅监听 127.0.0.1）
```

前端开发模式：`npm run dev:web`（Vite :5173，`/api` 代理到 4567）。

## 演示场景（`server/src/seed.js` + `server/src/fixture.js`）

| 场景 | 旧址 | 预期 |
|---|---|---|
| 编码中文路径 + 追踪参数 | `/频道/科技/42.html?utm_source=weibo` | 301→新页 200，追踪参数保留 |
| 正确小写路径 | `/news/123` | 通过 |
| 尾斜杠是身份 | `/column/weekly/` | 通过；无斜杠写法 404 |
| 编码斜杠 | `/old-files%2Fdraft` | 通过；`/files/draft` 是另一个资源（404） |
| 已删除栏目 | `/forum/announce/9` | **410 Gone** |
| 重定向环 | `/loop/a ↔ /loop/b` | `redirect_loop` |
| 过长链（7 跳） | `/chain/0 … /chain/7` | `chain_too_long` |
| 归一化歧义 | 同键 `/news/123` 指向 123 与 999 | `ambiguity`，不生效不请求 |
| 外网地址 | `http://example.com/...` | 白名单拒绝，**不发起请求** |
| 大小写错误 | `/News/123` | 最终 404，验证失败 |

## “填完表 ≠ 迁移完成”的完整闭环

```bash
# 1) 整改前：验证失败、报告记录受影响链接与证据（docs/verification-report-before.md）
npm run seed && npm run verify
#  → 共 9 条，通过 4，阻断 5（环/长链/404/歧义/越权）

# 2) 业务与运维修复：
#    - 站点侧打断环、长链改直跳（FIXTURE_MODE=fixed 模拟已上线配置）
#    - scripts/remediate.js：裁决歧义、剔除错误录入和非本站地址、更新映射目标
FIXTURE_MODE=fixed node scripts/remediate.js
FIXTURE_MODE=fixed npm run verify
#  → 共 7 条，全部通过（含 1 条已删除正确 410）

# 3) 整改后证据报告
FIXTURE_MODE=fixed node scripts/report.js
#  → docs/verification-report.md（passed=7 blocked=0）
```

工作台里的“迁移方案”也遵循同样闸门：纳入方案只是 `pending`，
`build` 时按**当前映射版本**的最新裁决标注 `verified/blocked` 并冻结版本；
`publish` 时只要方案版本过期、存在 blocked/pending、未纳入的生效映射或未裁决歧义，
就返回 **409 + 受影响链接清单**。变更集应用后旧方案自动 stale，必须重新验证、重建。

## 映射变更集（多人改动同一批旧址）

```
草稿(draft) ──提交──▶ 可审阅(in_review) ──应用──▶ 已应用(applied)
   │                     │                    （冲突）
   │                     ├──应用冲突──▶ 已过期(stale，保留 base/theirs/ours 三方差异)
   └──放弃───────────────┴──────────────▶ 已放弃(abandoned)
```

- **冻结版本**：创建时记录 `base_mapping_version` 与全部生效映射快照；
- **条目是原始 URL 级改动**：`add`（新增，不允许对既有键声明不同目标）、
  `modify`（显式修改/裁决歧义，给冲突键唯一目标）、`remove`（删除）；
  每条含原始旧址、目标/已删除裁决（`manual`/`deleted`）；
- **提交审阅 = 整组校验**：无效百分号编码、外网（非 127.0.0.1:4568）目标、
  未裁决歧义整体拒绝，变更集保持草稿、生效映射毫无变化；
- **应用 = 单事务**：`pg_advisory_xact_lock` 串行化 → 比对当前版本，被先应用者
  改过的同 canonical key 触发过期（409，展示三方差异，不覆盖）→ 落原始材料 →
  重算歧义和生效映射 → 写新版本 → 旧裁决/证据/未发布方案标 stale；
- **幂等可审计**：对 `applied/stale` 变更集重复应用返回首次保存的同一结果；
  原始输入、冻结版本、应用版本、影响键、冲突三方差异永久保留。

## API 摘要

| 方法/路径 | 作用 |
|---|---|
| `POST /api/normalize` | 规范化试算（不写库，含非法编码与本地目标判定） |
| `GET/POST /api/mappings` | 原始录入材料 / 录入一条（版本化提交，自动重算并令旧证据过期） |
| `POST /api/verify` | 对全部（或指定 `source_norm`）真实验证，裁决绑定当前映射版本 |
| `GET /api/crawl/:key` | 查看某条链接的逐跳证据 |
| `GET /api/mapping-versions` | 映射版本历史（每版关联来源变更集） |
| `GET/POST /api/changesets`、`GET /api/changesets/:id` | 变更集列表 / 创建（冻结版本+快照）/ 详情（差异、冲突、校验） |
| `POST /api/changesets/:id/items`、`DELETE …/items/:itemId` | 草稿内增改/移除一条原始 URL 改动（硬校验外网/编码） |
| `POST /api/changesets/:id/submit` | 草稿→可审阅（整组校验：外网/编码/歧义全拒） |
| `POST /api/changesets/:id/apply` | 单事务应用；冲突 409+三方差异转过期；重复应用幂等 |
| `POST /api/changesets/:id/abandon` | 放弃草稿/可审阅变更集 |
| `GET/POST /api/plans`、`POST /api/plans/:id/build`、`POST /api/plans/:id/publish` | 方案与发布闸门（绑定映射版本，过期不放行） |

## 环境变量（见 `.env.example`）

`HOST/PORT`（API）、`FIXTURE_HOST/PORT`（本地站点）、`PGHOST/PGPORT/PGUSER/PGPASSWORD/PGDATABASE`、
`TRAILING_SLASH_MODE`（默认 `keep`）、`MAX_REDIRECTS`（默认 5）、`HTTP_TIMEOUT_MS`、
`FIXTURE_MODE`（`fixed` = 模拟整改后站点）。

## 自备 PostgreSQL

若 `tools/` 不存在，在 Debian/Ubuntu 上可由无 root 方式取得二进制：

```bash
mkdir -p tools/pg-debs && cd tools/pg-debs
curl -O http://deb.debian.org/debian/pool/main/p/postgresql-15/postgresql-15_15.18-0+deb12u1_arm64.deb
curl -O http://deb.debian.org/debian/pool/main/p/postgresql-15/postgresql-client-15_15.18-0+deb12u1_arm64.deb
mkdir pg && cd pg && ar x ../postgresql-15_*.deb && tar xf data.tar.xz
cd .. && mkdir pg-client && cd pg-client && ar x ../postgresql-client-15_*.deb && tar xf data.tar.xz
cd /workspace && npm run pg:start
```

其它架构（amd64 等）把 deb 文件名中的 `arm64` 替换即可。也可改用系统 PostgreSQL，
用上述 `PG*` 环境变量指向它（脚本不会触碰你已有的实例，只创建 `url_migration` 库）。

## 目录

```
server/src/   normalize.js(规范化规则/严格编码校验/本地目标判定)
              verifier.js(白名单/环/长链/最终状态)
              ambiguity.js mappings-service.js(差异同步/版本化提交/证据过期)
              changesets-service.js(变更集状态机/冲突三方差异/单事务应用)
              verify-runner.js(版本绑定裁决) fixture.js(随项目本地站点)
              routes.js(Fastify) db.js
server/sql/   schema.sql（含幂等升级：mapping_versions / mapping_changesets* 等）
web/          Vue 3 + Vite 工作台（总览/变更集/证据/方案闸门/规则五页）
scripts/      start-pg.js remediate.js report.js
docs/         verification-report-before.md / -after.md（真实跑出来的证据）
server/test/  规则单测 + 验证器集成 + 变更集验收测试（27 项）
```

-- 旧新映射、爬取结果、迁移方案三类数据，全部带“证据”列。
-- 键的规范化由应用层（WHATWG URL，规则见 config.js）保证，不使用 CITEXT，
-- 因为路径大小写敏感、百分号编码不能随意解码。
--
-- 版本纪律：mapping_versions 是生效映射的单调版本线。每次生效映射改变
-- （直接录入或应用变更集）都产生新版本；逐跳证据（crawl_results）、
-- 最终裁决（verification_verdicts）与迁移方案（migration_plans）都绑定
-- 具体映射版本。新版本生效后，旧版本证据/方案只作审计留档，不得继续放行。

-- 映射版本线：v1 = baseline（初次录入/种子），其后由变更集应用或直接录入推进。
CREATE TABLE IF NOT EXISTS mapping_versions (
  version       BIGSERIAL PRIMARY KEY,
  label         TEXT NOT NULL,
  changeset_id  BIGINT,                     -- 由哪个变更集产生（直接录入为 NULL）
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 每次录入的原始材料（证据），同一归一化键可能有多个不同写法的来源。
CREATE TABLE IF NOT EXISTS mapping_inputs (
  id              BIGSERIAL PRIMARY KEY,
  source_raw      TEXT NOT NULL,
  source_norm     TEXT NOT NULL,           -- 归一化后的查表键
  target_raw      TEXT NOT NULL,
  target_norm     TEXT NOT NULL,
  mapping_type    TEXT NOT NULL CHECK (mapping_type IN ('manual','deleted')),
  note            TEXT,
  received_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_mapping_inputs_norm ON mapping_inputs(source_norm);

-- 生效映射：source_norm 唯一。同键不同目标的冲突不允许静默覆盖，
-- 由应用层写入并标记（见 ambiguity.js），冲突行 status='conflicted' 不生效。
-- mapping_version：该行最后一次被写入时的映射版本（重算时整表加盖版本戳）。
CREATE TABLE IF NOT EXISTS url_mappings (
  id              BIGSERIAL PRIMARY KEY,
  source_raw      TEXT NOT NULL,           -- 首次建立该键时的原始地址（证据）
  source_norm     TEXT NOT NULL UNIQUE,
  target_raw      TEXT NOT NULL,
  target_norm     TEXT NOT NULL,
  mapping_type    TEXT NOT NULL CHECK (mapping_type IN ('manual','deleted')),
  status          TEXT NOT NULL DEFAULT 'active'
                  CHECK (status IN ('active','conflicted')),
  note            TEXT,
  mapping_version BIGINT NOT NULL DEFAULT 1,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 歧义（多旧址归一后相同，却指向不同资源）：
-- 以 mapping_inputs 为证据，按归一化键分组，存在 2 个以上不同 target_norm。
CREATE OR REPLACE VIEW mapping_ambiguities AS
SELECT source_norm,
       count(*) AS input_count,
       count(DISTINCT target_norm) AS target_variants,
       array_agg(DISTINCT source_raw ORDER BY source_raw) AS source_forms,
       array_agg(DISTINCT target_raw ORDER BY target_raw) AS targets
FROM mapping_inputs
GROUP BY source_norm
HAVING count(DISTINCT target_norm) > 1;

-- 逐跳证据绑定到“被验证时的映射版本”；新版本后旧行保留留档但不再作为放行依据。
CREATE TABLE IF NOT EXISTS crawl_results (
  id                  BIGSERIAL PRIMARY KEY,
  source_norm         TEXT NOT NULL,
  mapping_version     BIGINT NOT NULL DEFAULT 1,
  hop_index           INT  NOT NULL,           -- 0 = 入口地址
  url_raw             TEXT NOT NULL,           -- 该跳实际请求的原始 URL
  url_norm            TEXT NOT NULL,           -- 该跳规范化形式
  status_code         INT,
  location_raw        TEXT,                    -- 响应 Location（原样保留）
  location_norm       TEXT,
  is_redirect         BOOLEAN NOT NULL DEFAULT false,
  fetch_error         TEXT,
  fetched_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 对每个入口地址、每个映射版本的最终裁决（最终页面状态必须核实）
CREATE TABLE IF NOT EXISTS verification_verdicts (
  source_norm         TEXT NOT NULL,
  mapping_version     BIGINT NOT NULL DEFAULT 1,
  source_raw          TEXT NOT NULL,
  final_url_raw       TEXT,
  final_url_norm      TEXT,
  final_status        INT,
  hops                INT  NOT NULL DEFAULT 0,
  tracker_preserved   BOOLEAN,                 -- 追踪参数是否到达最终 URL
  -- ok / redirect_loop / chain_too_long / fetch_error /
  -- deleted_gone_ok / deleted_not_gone / ambiguity / final_status_bad
  verdict             TEXT NOT NULL,
  issues              JSONB NOT NULL DEFAULT '[]'::jsonb,
  verified_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (source_norm, mapping_version)
);

-- 迁移方案：填表只是 pending，验证通过才 allowed 发布。
-- mapping_version：方案条目所依据的映射版本（build 时冻结）；
-- 当前版本前进后，旧方案必须重新验证并重建，发布闸门拒绝放行。
CREATE TABLE IF NOT EXISTS migration_plans (
  id              BIGSERIAL PRIMARY KEY,
  name            TEXT NOT NULL UNIQUE,
  status          TEXT NOT NULL DEFAULT 'draft'
                  CHECK (status IN ('draft','ready','published')),
  mapping_version BIGINT NOT NULL DEFAULT 1,
  published_version BIGINT,                   -- 发布时对应的映射版本
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  published_at    TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS migration_plan_items (
  id              BIGSERIAL PRIMARY KEY,
  plan_id         BIGINT NOT NULL REFERENCES migration_plans(id) ON DELETE CASCADE,
  -- 重算会删除映射行；旧方案条目保留（mapping_id 置空，证据冻结在 evidence 中）
  mapping_id      BIGINT REFERENCES url_mappings(id) ON DELETE SET NULL,
  -- pending（仅填表） / verified（有验证证据） / blocked（存在问题）
  item_status     TEXT NOT NULL DEFAULT 'pending'
                  CHECK (item_status IN ('pending','verified','blocked')),
  evidence        JSONB NOT NULL DEFAULT '{}'::jsonb,
  UNIQUE (plan_id, mapping_id)
);

-- 旧库升级：外键改为 ON DELETE SET NULL（原表为默认 NO ACTION 或 CASCADE），
-- 并允许 mapping_id 为空（过期条目留档）
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint
              WHERE conrelid='migration_plan_items'::regclass
                AND conname='migration_plan_items_mapping_id_fkey'
                AND confdeltype <> 'n') THEN
    ALTER TABLE migration_plan_items DROP CONSTRAINT migration_plan_items_mapping_id_fkey;
    ALTER TABLE migration_plan_items
      ADD CONSTRAINT migration_plan_items_mapping_id_fkey
      FOREIGN KEY (mapping_id) REFERENCES url_mappings(id) ON DELETE SET NULL;
  END IF;
END $$;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns
              WHERE table_name='migration_plan_items' AND column_name='mapping_id'
                AND is_nullable='NO') THEN
    ALTER TABLE migration_plan_items ALTER COLUMN mapping_id DROP NOT NULL;
  END IF;
END $$;

-- 映射变更集：冻结创建时的映射版本（base_version）与该版本生效映射快照，
-- 携带新增/修改/删除的原始 URL 与目标/删除裁决，经历
-- draft（草稿）→ reviewable（可审阅）→ applied（已应用）
--                         └→ expired（已过期，被并发版本超越）
-- draft/reviewable └→ abandoned（已放弃）
CREATE TABLE IF NOT EXISTS mapping_changesets (
  id               BIGSERIAL PRIMARY KEY,
  name             TEXT NOT NULL,
  status           TEXT NOT NULL DEFAULT 'draft'
                   CHECK (status IN ('draft','reviewable','applied','expired','abandoned')),
  base_version     BIGINT NOT NULL REFERENCES mapping_versions(version),
  applied_version  BIGINT REFERENCES mapping_versions(version),
  -- 创建时的原始请求体（逐字留档，审计“原始输入”）
  payload          JSONB NOT NULL,
  -- 规范化、白名单校验后冻结的改动行
  changes          JSONB NOT NULL,
  -- 创建时 base_version 下的全量生效映射快照（三方差异的 base 一侧）
  base_snapshot    JSONB NOT NULL DEFAULT '{}'::jsonb,
  -- 自动校验结果：[{index, op, source_raw, reason}]
  validation       JSONB NOT NULL DEFAULT '[]'::jsonb,
  -- 应用时检出的冲突（三方差异），过期时留档
  conflicts        JSONB,
  reject_reason    JSONB,
  idempotency_key  TEXT,
  created_by       TEXT,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  submitted_at     TIMESTAMPTZ,
  applied_at       TIMESTAMPTZ,
  ended_at         TIMESTAMPTZ
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_changesets_idempotency
  ON mapping_changesets(idempotency_key) WHERE idempotency_key IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_changesets_status ON mapping_changesets(status);

-- ---- 幂等升级：对已存在的旧库补齐版本列与约束 ------------------------

INSERT INTO mapping_versions (version, label)
SELECT 1, 'baseline'
WHERE NOT EXISTS (SELECT 1 FROM mapping_versions);

-- 显式插入 baseline 后把序列对齐到已存在的最大版本（否则下一个 nextval 仍从 1 起）
SELECT setval(
  pg_get_serial_sequence('mapping_versions', 'version'),
  GREATEST((SELECT coalesce(max(version), 1) FROM mapping_versions), 1),
  true);

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                  WHERE table_name='url_mappings' AND column_name='mapping_version') THEN
    ALTER TABLE url_mappings ADD COLUMN mapping_version BIGINT NOT NULL DEFAULT 1;
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                  WHERE table_name='crawl_results' AND column_name='mapping_version') THEN
    ALTER TABLE crawl_results ADD COLUMN mapping_version BIGINT NOT NULL DEFAULT 1;
  END IF;
END $$;

-- crawl_results 旧库唯一约束 (source_norm, hop_index) → 加入版本维度
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint
              WHERE conname='crawl_results_source_norm_hop_index_key') THEN
    ALTER TABLE crawl_results DROP CONSTRAINT crawl_results_source_norm_hop_index_key;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='crawl_results_version_uniq') THEN
    ALTER TABLE crawl_results
      ADD CONSTRAINT crawl_results_version_uniq UNIQUE (source_norm, hop_index, mapping_version);
  END IF;
END $$;
CREATE INDEX IF NOT EXISTS idx_crawl_version ON crawl_results(source_norm, mapping_version);

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                  WHERE table_name='verification_verdicts' AND column_name='mapping_version') THEN
    ALTER TABLE verification_verdicts ADD COLUMN mapping_version BIGINT NOT NULL DEFAULT 1;
  END IF;
END $$;

-- 裁决主键由 source_norm 扩展为 (source_norm, mapping_version)，保留历史版本证据
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_constraint c
    WHERE c.conrelid='verification_verdicts'::regclass AND c.contype='p'
      AND NOT EXISTS (
        SELECT 1 FROM pg_attribute a
         WHERE a.attrelid=c.conrelid AND a.attnum = ANY(c.conkey) AND a.attname='mapping_version')) THEN
    ALTER TABLE verification_verdicts DROP CONSTRAINT verification_verdicts_pkey;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid='verification_verdicts'::regclass AND conname='verification_verdicts_pkey') THEN
    ALTER TABLE verification_verdicts ADD PRIMARY KEY (source_norm, mapping_version);
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                  WHERE table_name='migration_plans' AND column_name='mapping_version') THEN
    ALTER TABLE migration_plans ADD COLUMN mapping_version BIGINT NOT NULL DEFAULT 1;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                  WHERE table_name='migration_plans' AND column_name='published_version') THEN
    ALTER TABLE migration_plans ADD COLUMN published_version BIGINT;
  END IF;
END $$;
CREATE INDEX IF NOT EXISTS idx_verdicts_version ON verification_verdicts(mapping_version);

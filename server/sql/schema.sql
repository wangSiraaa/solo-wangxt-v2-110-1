-- 旧新映射、爬取结果、迁移方案三类数据，全部带“证据”列。
-- 键的规范化由应用层（WHATWG URL，规则见 config.js）保证，不使用 CITEXT，
-- 因为路径大小写敏感、百分号编码不能随意解码。
--
-- 自“映射变更集”起，生效表不再由录入即时改写：编辑提交的改动先冻结到变更集
-- （mapping_changesets/...items），负责人审阅后在一个事务内应用，每次应用令
-- mapping_versions 前进一个版本。所有验证证据、爬取记录、迁移方案都与具体
-- 映射版本绑定；新版本应用后旧证据/方案明确标为过期（stale），不再放行。

-- 映射版本：单调递增。version=1 是初始（种子/首次录入）版本，
-- 其后每成功应用一个变更集插入一行；任何时刻当前版本 = 最大 version。
CREATE TABLE IF NOT EXISTS mapping_versions (
  id                      BIGSERIAL PRIMARY KEY,
  version                 BIGINT NOT NULL UNIQUE,
  created_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
  note                    TEXT,
  applied_changeset_id    BIGINT            -- 成功应用后回填（见文件末尾外键）
);

-- 每次录入的原始材料（证据），同一归一化键可能有多个不同写法的来源。
-- provenance：经变更集落入的材料标记来源变更集，直接录入为 NULL。
CREATE TABLE IF NOT EXISTS mapping_inputs (
  id              BIGSERIAL PRIMARY KEY,
  source_raw      TEXT NOT NULL,
  source_norm     TEXT NOT NULL,           -- 归一化后的查表键
  target_raw      TEXT NOT NULL,
  target_norm     TEXT NOT NULL,
  mapping_type    TEXT NOT NULL CHECK (mapping_type IN ('manual','deleted')),
  note            TEXT,
  received_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  source_changeset_id BIGINT
);
CREATE INDEX IF NOT EXISTS idx_mapping_inputs_norm ON mapping_inputs(source_norm);
-- source_changeset_id 的外键在文件末尾添加（被引用的 mapping_changesets 此时尚未建）。

-- 生效映射：source_norm 唯一。同键不同目标的冲突不允许静默覆盖，
-- 由应用层写入并标记（见 ambiguity.js），冲突行 status='conflicted' 不生效。
-- mapping_version：本行最后一次被写入/裁决时对应的映射版本。
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

CREATE TABLE IF NOT EXISTS crawl_results (
  id                  BIGSERIAL PRIMARY KEY,
  source_norm         TEXT NOT NULL,
  hop_index           INT  NOT NULL,           -- 0 = 入口地址
  url_raw             TEXT NOT NULL,           -- 该跳实际请求的原始 URL
  url_norm            TEXT NOT NULL,           -- 该跳规范化形式
  status_code         INT,
  location_raw        TEXT,                    -- 响应 Location（原样保留）
  location_norm       TEXT,
  is_redirect         BOOLEAN NOT NULL DEFAULT false,
  fetch_error         TEXT,
  mapping_version     BIGINT NOT NULL DEFAULT 1, -- 取证时的映射版本
  stale               BOOLEAN NOT NULL DEFAULT false, -- 映射已前进到新版本
  fetched_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (source_norm, hop_index)
);

-- 对每个入口地址的最终裁决（最终页面状态必须核实）。
-- mapping_version：裁决基于的映射版本；stale=true 表示映射之后被变更集改动，
-- 该裁决（及其逐跳证据）只能作为历史，不得再支撑发布闸门。
CREATE TABLE IF NOT EXISTS verification_verdicts (
  source_norm         TEXT PRIMARY KEY,
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
  mapping_version     BIGINT NOT NULL DEFAULT 1,
  stale               BOOLEAN NOT NULL DEFAULT false,
  verified_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 迁移方案：填表只是 pending，验证通过才 allowed 发布。
-- base_mapping_version：方案最近一次纳入（build）时冻结的映射版本；
-- stale=true：之后有变更集应用、映射版本前进，方案内证据全部过期。
CREATE TABLE IF NOT EXISTS migration_plans (
  id              BIGSERIAL PRIMARY KEY,
  name            TEXT NOT NULL UNIQUE,
  status          TEXT NOT NULL DEFAULT 'draft'
                  CHECK (status IN ('draft','ready','published')),
  base_mapping_version BIGINT NOT NULL DEFAULT 1,
  stale           BOOLEAN NOT NULL DEFAULT false,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  published_at    TIMESTAMPTZ
);

-- 条目在 build 时把映射快照进自己的列：对应映射随后被删除/替换时，
-- 过期方案仍然完整可审计（mapping_id 置 NULL，而不是连带删掉条目）。
CREATE TABLE IF NOT EXISTS migration_plan_items (
  id              BIGSERIAL PRIMARY KEY,
  plan_id         BIGINT NOT NULL REFERENCES migration_plans(id) ON DELETE CASCADE,
  mapping_id      BIGINT REFERENCES url_mappings(id) ON DELETE SET NULL,
  source_raw      TEXT,
  source_norm     TEXT,
  target_raw      TEXT,
  target_norm     TEXT,
  mapping_type    TEXT,
  -- pending（仅填表） / verified（有验证证据） / blocked（存在问题）
  item_status     TEXT NOT NULL DEFAULT 'pending'
                  CHECK (item_status IN ('pending','verified','blocked')),
  evidence        JSONB NOT NULL DEFAULT '{}'::jsonb,
  UNIQUE (plan_id, mapping_id)
);

-- 既有库升级：migration_plan_items 旧外键是 NOT NULL + ON DELETE NO ACTION，
-- 需要替换成可空 + ON DELETE SET NULL；补齐快照列。
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns
              WHERE table_name='migration_plan_items' AND column_name='mapping_id'
                AND is_nullable='NO') THEN
    ALTER TABLE migration_plan_items DROP CONSTRAINT migration_plan_items_plan_id_mapping_id_key;
    ALTER TABLE migration_plan_items DROP CONSTRAINT migration_plan_items_mapping_id_fkey;
    ALTER TABLE migration_plan_items ALTER COLUMN mapping_id DROP NOT NULL;
    ALTER TABLE migration_plan_items
      ADD CONSTRAINT migration_plan_items_mapping_id_fkey
      FOREIGN KEY (mapping_id) REFERENCES url_mappings(id) ON DELETE SET NULL;
    ALTER TABLE migration_plan_items
      ADD CONSTRAINT migration_plan_items_plan_id_mapping_id_key
      UNIQUE (plan_id, mapping_id);
  END IF;
  -- 既有库补快照列
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                  WHERE table_name='migration_plan_items' AND column_name='source_raw') THEN
    ALTER TABLE migration_plan_items ADD COLUMN source_raw TEXT;
    ALTER TABLE migration_plan_items ADD COLUMN source_norm TEXT;
    ALTER TABLE migration_plan_items ADD COLUMN target_raw TEXT;
    ALTER TABLE migration_plan_items ADD COLUMN target_norm TEXT;
    ALTER TABLE migration_plan_items ADD COLUMN mapping_type TEXT;
  END IF;
END $$;

-- ---- 映射变更集 -------------------------------------------------------
-- 一组待审阅的映射改动。创建时冻结 base_mapping_version 与当时的生效映射快照
-- （base_snapshot），应用时据此在一个事务内检测冲突：
-- 当前映射版本已前进且本变更集触及的 canonical key 也被别人改过 → 过期（stale），
-- 展示 base / theirs / ours 三方差异，绝不覆盖。
CREATE TABLE IF NOT EXISTS mapping_changesets (
  id                    BIGSERIAL PRIMARY KEY,
  name                  TEXT NOT NULL,
  description           TEXT,
  created_by            TEXT,
  status                TEXT NOT NULL DEFAULT 'draft' CHECK (
                          status IN ('draft','in_review','applied','stale','abandoned')),
  base_mapping_version  BIGINT NOT NULL,
  base_snapshot         JSONB NOT NULL DEFAULT '{}'::jsonb,
  submitted_at          TIMESTAMPTZ,
  applied_at            TIMESTAMPTZ,
  applied_version       BIGINT,
  abandoned_at          TIMESTAMPTZ,
  expire_reason         TEXT,
  -- apply 结果（冲突项/拒绝原因/影响键）原样持久化，重复 apply 返回同一结果
  apply_result          JSONB,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 变更集条目：一条“原始 URL 级”的改动（新增/修改/删除的原始旧址与目标/裁决）。
--  operation: add（新 canonical key） / modify（既有 key 的新声明） / remove（删除）
--  mapping_type: manual（迁移到目标） / deleted（裁决：已删除，期望 410/404）
CREATE TABLE IF NOT EXISTS mapping_changeset_items (
  id              BIGSERIAL PRIMARY KEY,
  changeset_id    BIGINT NOT NULL REFERENCES mapping_changesets(id) ON DELETE CASCADE,
  operation       TEXT NOT NULL CHECK (operation IN ('add','modify','remove')),
  source_raw      TEXT NOT NULL,
  source_norm     TEXT NOT NULL,
  target_raw      TEXT,                      -- remove/裁决删除时可空
  target_norm     TEXT,
  mapping_type    TEXT NOT NULL DEFAULT 'manual'
                  CHECK (mapping_type IN ('manual','deleted')),
  note            TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (changeset_id, source_norm)
);
CREATE INDEX IF NOT EXISTS idx_changeset_items_cs ON mapping_changeset_items(changeset_id);

-- 回填版本表外键；mapping_inputs 的变更集来源外键；初始版本行（既有库幂等补建）。
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                  WHERE table_name='mapping_inputs' AND column_name='source_changeset_id') THEN
    ALTER TABLE mapping_inputs ADD COLUMN source_changeset_id BIGINT;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                  WHERE table_name='url_mappings' AND column_name='mapping_version') THEN
    ALTER TABLE url_mappings ADD COLUMN mapping_version BIGINT NOT NULL DEFAULT 1;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                  WHERE table_name='crawl_results' AND column_name='mapping_version') THEN
    ALTER TABLE crawl_results ADD COLUMN mapping_version BIGINT NOT NULL DEFAULT 1;
    ALTER TABLE crawl_results ADD COLUMN stale BOOLEAN NOT NULL DEFAULT false;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                  WHERE table_name='verification_verdicts' AND column_name='mapping_version') THEN
    ALTER TABLE verification_verdicts ADD COLUMN mapping_version BIGINT NOT NULL DEFAULT 1;
    ALTER TABLE verification_verdicts ADD COLUMN stale BOOLEAN NOT NULL DEFAULT false;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                  WHERE table_name='migration_plans' AND column_name='base_mapping_version') THEN
    ALTER TABLE migration_plans ADD COLUMN base_mapping_version BIGINT NOT NULL DEFAULT 1;
    ALTER TABLE migration_plans ADD COLUMN stale BOOLEAN NOT NULL DEFAULT false;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='fk_versions_changeset') THEN
    ALTER TABLE mapping_versions
      ADD CONSTRAINT fk_versions_changeset
      FOREIGN KEY (applied_changeset_id) REFERENCES mapping_changesets(id);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='fk_inputs_changeset') THEN
    ALTER TABLE mapping_inputs
      ADD CONSTRAINT fk_inputs_changeset
      FOREIGN KEY (source_changeset_id) REFERENCES mapping_changesets(id);
  END IF;
END $$;

INSERT INTO mapping_versions (version, note)
SELECT 1, '初始映射版本（建库/种子）'
WHERE NOT EXISTS (SELECT 1 FROM mapping_versions);
SELECT setval(
  pg_get_serial_sequence('mapping_versions', 'id'),
  GREATEST((SELECT COALESCE(max(id), 1) FROM mapping_versions), 1),
  true);

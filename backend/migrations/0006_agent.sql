-- 에이전트(클라이언트 종류) 구분: claude-code · codex · opencode · pi
-- 지금까지 배포된 훅은 Claude Code 플러그인뿐이므로 기존 데이터는 전부 'claude-code'로 백필한다.
-- (agent 미포함 요청도 서버가 'claude-code'로 기본 처리 — 구버전 플러그인 하위호환)

-- events: 컬럼 추가 + 백필
ALTER TABLE events ADD COLUMN agent TEXT;
UPDATE events SET agent = 'claude-code' WHERE agent IS NULL;

-- daily_stats: 집계 차원에 agent 추가 — PK (user_id, day) → (user_id, day, agent).
-- SQLite는 PK 변경이 안 되므로 테이블 재생성 후 데이터 이관.
CREATE TABLE daily_stats_new (
  user_id  TEXT    NOT NULL,
  day      TEXT    NOT NULL,             -- 'YYYY-MM-DD' (KST 기준)
  agent    TEXT    NOT NULL DEFAULT 'claude-code',
  prompts  INTEGER NOT NULL DEFAULT 0,
  chars    INTEGER NOT NULL DEFAULT 0,
  country  TEXT,
  PRIMARY KEY (user_id, day, agent)
);
INSERT INTO daily_stats_new (user_id, day, agent, prompts, chars, country)
  SELECT user_id, day, 'claude-code', prompts, chars, country FROM daily_stats;
DROP TABLE daily_stats;
ALTER TABLE daily_stats_new RENAME TO daily_stats;
CREATE INDEX IF NOT EXISTS idx_daily_day ON daily_stats(day);

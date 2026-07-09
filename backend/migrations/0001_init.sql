-- Open Code War — 초기 스키마 (DESIGN.md §5)

-- 원시 이벤트 (append-only, 감사/재집계용)
CREATE TABLE IF NOT EXISTS events (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id    TEXT    NOT NULL,
  chars      INTEGER NOT NULL DEFAULT 0,
  country    TEXT,                       -- cf.country, 예: 'KR'
  created_at INTEGER NOT NULL            -- 서버 수신 시각(UTC epoch ms)
);
CREATE INDEX IF NOT EXISTS idx_events_user_time ON events(user_id, created_at);
CREATE INDEX IF NOT EXISTS idx_events_time      ON events(created_at);

-- 유저 프로필
CREATE TABLE IF NOT EXISTS users (
  user_id      TEXT PRIMARY KEY,
  nickname     TEXT UNIQUE,              -- NULL 허용(익명)
  country      TEXT,
  created_at   INTEGER NOT NULL,
  last_seen_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_users_nickname ON users(nickname);

-- KST 일자별 집계 (리더보드 조회 최적화)
CREATE TABLE IF NOT EXISTS daily_stats (
  user_id  TEXT    NOT NULL,
  day      TEXT    NOT NULL,             -- 'YYYY-MM-DD' (KST 기준)
  prompts  INTEGER NOT NULL DEFAULT 0,
  chars    INTEGER NOT NULL DEFAULT 0,
  country  TEXT,
  PRIMARY KEY (user_id, day)
);
CREATE INDEX IF NOT EXISTS idx_daily_day ON daily_stats(day);

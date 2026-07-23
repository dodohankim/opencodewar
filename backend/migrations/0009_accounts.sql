-- Google 계정 연동 (DESIGN.md §14)
-- 선택적 로그인: 계정 복구 · 멀티 기기 합산 · 소유권 귀속. 익명 참가는 그대로 유지.
CREATE TABLE IF NOT EXISTS accounts (
  account_id TEXT PRIMARY KEY,        -- 'acc_' + 랜덤 hex
  google_sub TEXT UNIQUE NOT NULL,    -- Google OpenID subject (이메일 변경에도 불변)
  email      TEXT,
  user_id    TEXT NOT NULL,           -- canonical user (users.user_id)
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_accounts_user ON accounts(user_id);

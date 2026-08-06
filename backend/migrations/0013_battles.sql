-- 교전(Battle) — 최대 10명 개인전 (DESIGN.md §22)
-- status 컬럼은 두지 않는다: 진행/종료는 ends_at 과 now 비교로 파생(상태 전이 쓰기 0).

CREATE TABLE IF NOT EXISTS battles (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  code          TEXT    NOT NULL UNIQUE,   -- 초대 코드 (URL /b/<code>)
  name          TEXT,                      -- 방 이름 (없으면 코드로 표시)
  owner_user_id TEXT    NOT NULL,
  metric        TEXT    NOT NULL DEFAULT 'prompts',  -- 'prompts' | 'chars'
  created_at    INTEGER NOT NULL,          -- 생성 = 시작 (UTC epoch ms)
  ends_at       INTEGER NOT NULL           -- created_at + 기간(24h~7d)
);

CREATE TABLE IF NOT EXISTS battle_members (
  battle_id  INTEGER NOT NULL,
  user_id    TEXT    NOT NULL,
  joined_at  INTEGER NOT NULL,
  PRIMARY KEY (battle_id, user_id)
);

-- 내가 참가 중인 교전 조회(브리핑·/ocw battle status)용 역방향 인덱스.
CREATE INDEX IF NOT EXISTS idx_battle_members_user ON battle_members(user_id);

-- Open Code War — 로컬/데모용 시드 데이터 (재실행 가능)
-- day 값은 실행 시점의 KST 기준으로 계산되어 daily/weekly/weekend 보드에 모두 데이터가 잡힌다.
-- 상세 페이지(GET /user) 차트 데모를 위해 상위 3명은 최근 30일 히스토리도 포함한다.
-- 날짜 식(반복 등장):
--   오늘(KST)  = date('now')
--   이번주 월  = date('now','-'||((CAST(strftime('%w',date('now')) AS INTEGER)+6)%7)||' days')
--   금/토/일   = 위 월요일에 +4 / +5 / +6 days

DELETE FROM events WHERE user_id LIKE 'seed_user_%';
DELETE FROM daily_stats WHERE user_id LIKE 'seed_user_%';
DELETE FROM users WHERE user_id LIKE 'seed_user_%';

-- country(IP 자동)·city(자기선언)를 다양화해 구역 리더보드 테스트가 되게 한다.
--   KR/Seoul: 01,02,03,10 · KR/Busan: 04,05 · KR/(미설정): 06 · US/San Francisco: 07,08 · JP/Tokyo: 09
-- timezone(IANA): 상세 페이지를 그 유저 로컬 시간으로 보여주는 데 쓴다(리더보드는 공용 UTC 라 무관).
INSERT INTO users (user_id, public_id, nickname, bio, country, city, timezone, created_at, last_seen_at) VALUES
  ('seed_user_01', 'u-seeduser01', '코드깎는노인',   '20년째 손맛으로 코드를 깎습니다. vim + claude 조합.', 'KR', 'Seoul',         'Asia/Seoul',          unixepoch() * 1000, unixepoch() * 1000),
  ('seed_user_02', 'u-seeduser02', 'vim_귀신',       'hjkl로 산다. 마우스는 장식.', 'KR', 'Seoul',         'Asia/Seoul',          unixepoch() * 1000, unixepoch() * 1000),
  ('seed_user_03', 'u-seeduser03', '새벽5시개발자',  '해 뜨기 전이 제일 집중 잘 됨.', 'KR', 'Seoul',         'Asia/Seoul',          unixepoch() * 1000, unixepoch() * 1000),
  ('seed_user_04', 'u-seeduser04', '반포자이코더',   NULL, 'KR', 'Busan',         'Asia/Seoul',          unixepoch() * 1000, unixepoch() * 1000),
  ('seed_user_05', 'u-seeduser05', '프롬프트장인',   '좋은 프롬프트가 좋은 코드를 만든다.', 'KR', 'Busan',         'Asia/Seoul',          unixepoch() * 1000, unixepoch() * 1000),
  ('seed_user_06', 'u-seeduser06', '리팩터_고양이',  NULL, 'KR', NULL,            'Asia/Seoul',          unixepoch() * 1000, unixepoch() * 1000),
  ('seed_user_07', 'u-seeduser07', '세미콜론수집가', ';', 'US', 'San Francisco', 'America/Los_Angeles', unixepoch() * 1000, unixepoch() * 1000),
  ('seed_user_08', 'u-seeduser08', '버그사냥꾼',     '오늘도 한 마리 잡았다.', 'US', 'San Francisco', 'America/Los_Angeles', unixepoch() * 1000, unixepoch() * 1000),
  ('seed_user_09', 'u-seeduser09', '토큰_수도꼭지',  NULL, 'JP', 'Tokyo',         'Asia/Tokyo',          unixepoch() * 1000, unixepoch() * 1000),
  ('seed_user_10', 'u-seeduser10', NULL,             NULL, 'KR', 'Seoul',         'Asia/Seoul',          unixepoch() * 1000, unixepoch() * 1000);

INSERT INTO daily_stats (user_id, day, prompts, chars, country) VALUES
  -- 오늘 (daily 보드)
  ('seed_user_01', date('now'), 247, 19840, 'KR'),
  ('seed_user_02', date('now'), 233, 15120, 'KR'),
  ('seed_user_03', date('now'), 201, 22310, 'KR'),
  ('seed_user_04', date('now'), 188, 12040, 'KR'),
  ('seed_user_05', date('now'), 174, 20880, 'KR'),
  ('seed_user_06', date('now'), 159,  9910, 'KR'),
  ('seed_user_07', date('now'), 151, 14200, 'KR'),
  ('seed_user_08', date('now'), 142, 11760, 'KR'),
  ('seed_user_09', date('now'), 129, 16650, 'KR'),
  ('seed_user_10', date('now'), 112,  9040, 'KR'),
  -- seed_user_01 최근 30일 히스토리 (차트 데모)
  ('seed_user_01', date('now','-29 days'), 246, 19188, 'KR'),
  ('seed_user_01', date('now','-28 days'), 260, 18460, 'KR'),
  ('seed_user_01', date('now','-26 days'), 123, 7011, 'KR'),
  ('seed_user_01', date('now','-25 days'), 272, 25840, 'KR'),
  ('seed_user_01', date('now','-24 days'), 266, 23408, 'KR'),
  ('seed_user_01', date('now','-23 days'), 255, 20655, 'KR'),
  ('seed_user_01', date('now','-22 days'), 241, 17834, 'KR'),
  ('seed_user_01', date('now','-21 days'), 224, 15008, 'KR'),
  ('seed_user_01', date('now','-20 days'), 93, 5580, 'KR'),
  ('seed_user_01', date('now','-19 days'), 86, 8428, 'KR'),
  ('seed_user_01', date('now','-17 days'), 170, 14280, 'KR'),
  ('seed_user_01', date('now','-16 days'), 166, 12782, 'KR'),
  ('seed_user_01', date('now','-15 days'), 168, 11760, 'KR'),
  ('seed_user_01', date('now','-14 days'), 175, 11025, 'KR'),
  ('seed_user_01', date('now','-13 days'), 84, 4704, 'KR'),
  ('seed_user_01', date('now','-12 days'), 91, 8554, 'KR'),
  ('seed_user_01', date('now','-11 days'), 220, 19140, 'KR'),
  ('seed_user_01', date('now','-10 days'), 239, 19120, 'KR'),
  ('seed_user_01', date('now','-8 days'), 275, 18150, 'KR'),
  ('seed_user_01', date('now','-7 days'), 288, 16992, 'KR'),
  ('seed_user_01', date('now','-6 days'), 133, 12901, 'KR'),
  ('seed_user_01', date('now','-5 days'), 134, 12060, 'KR'),
  ('seed_user_01', date('now','-4 days'), 296, 24568, 'KR'),
  ('seed_user_01', date('now','-3 days'), 289, 21964, 'KR'),
  ('seed_user_01', date('now','-2 days'), 277, 19113, 'KR'),
  ('seed_user_01', date('now','-1 days'), 262, 16244, 'KR'),
  -- seed_user_02 최근 30일 히스토리 (차트 데모)
  ('seed_user_02', date('now','-29 days'), 182, 10738, 'KR'),
  ('seed_user_02', date('now','-28 days'), 204, 19788, 'KR'),
  ('seed_user_02', date('now','-27 days'), 224, 20160, 'KR'),
  ('seed_user_02', date('now','-26 days'), 240, 19920, 'KR'),
  ('seed_user_02', date('now','-24 days'), 115, 7935, 'KR'),
  ('seed_user_02', date('now','-23 days'), 255, 15810, 'KR'),
  ('seed_user_02', date('now','-22 days'), 247, 13585, 'KR'),
  ('seed_user_02', date('now','-21 days'), 234, 21762, 'KR'),
  ('seed_user_02', date('now','-20 days'), 217, 18662, 'KR'),
  ('seed_user_02', date('now','-19 days'), 198, 15642, 'KR'),
  ('seed_user_02', date('now','-18 days'), 80, 5760, 'KR'),
  ('seed_user_02', date('now','-17 days'), 72, 4680, 'KR'),
  ('seed_user_02', date('now','-15 days'), 133, 12768, 'KR'),
  ('seed_user_02', date('now','-14 days'), 129, 11481, 'KR'),
  ('seed_user_02', date('now','-13 days'), 130, 10660, 'KR'),
  ('seed_user_02', date('now','-12 days'), 138, 10350, 'KR'),
  ('seed_user_02', date('now','-11 days'), 68, 4624, 'KR'),
  ('seed_user_02', date('now','-10 days'), 76, 4636, 'KR'),
  ('seed_user_02', date('now','-9 days'), 191, 18909, 'KR'),
  ('seed_user_02', date('now','-8 days'), 213, 19596, 'KR'),
  ('seed_user_02', date('now','-6 days'), 254, 19812, 'KR'),
  ('seed_user_02', date('now','-5 days'), 268, 19028, 'KR'),
  ('seed_user_02', date('now','-4 days'), 125, 8000, 'KR'),
  ('seed_user_02', date('now','-3 days'), 126, 7182, 'KR'),
  ('seed_user_02', date('now','-2 days'), 278, 26410, 'KR'),
  ('seed_user_02', date('now','-1 days'), 269, 23672, 'KR'),
  -- seed_user_03 최근 30일 히스토리 (차트 데모)
  ('seed_user_03', date('now','-29 days'), 59, 5015, 'KR'),
  ('seed_user_03', date('now','-28 days'), 146, 11388, 'KR'),
  ('seed_user_03', date('now','-27 days'), 164, 11644, 'KR'),
  ('seed_user_03', date('now','-26 days'), 182, 11648, 'KR'),
  ('seed_user_03', date('now','-25 days'), 198, 11286, 'KR'),
  ('seed_user_03', date('now','-24 days'), 210, 19950, 'KR'),
  ('seed_user_03', date('now','-22 days'), 101, 8181, 'KR'),
  ('seed_user_03', date('now','-21 days'), 222, 16428, 'KR'),
  ('seed_user_03', date('now','-20 days'), 217, 14539, 'KR'),
  ('seed_user_03', date('now','-19 days'), 207, 12420, 'KR'),
  ('seed_user_03', date('now','-18 days'), 194, 19012, 'KR'),
  ('seed_user_03', date('now','-17 days'), 179, 16289, 'KR'),
  ('seed_user_03', date('now','-16 days'), 74, 6216, 'KR'),
  ('seed_user_03', date('now','-15 days'), 67, 5159, 'KR'),
  ('seed_user_03', date('now','-13 days'), 129, 8127, 'KR'),
  ('seed_user_03', date('now','-12 days'), 126, 7056, 'KR'),
  ('seed_user_03', date('now','-11 days'), 127, 11938, 'KR'),
  ('seed_user_03', date('now','-10 days'), 134, 11658, 'KR'),
  ('seed_user_03', date('now','-9 days'), 65, 5200, 'KR'),
  ('seed_user_03', date('now','-8 days'), 72, 5256, 'KR'),
  ('seed_user_03', date('now','-7 days'), 176, 11616, 'KR'),
  ('seed_user_03', date('now','-6 days'), 194, 11446, 'KR'),
  ('seed_user_03', date('now','-4 days'), 226, 20340, 'KR'),
  ('seed_user_03', date('now','-3 days'), 238, 19754, 'KR'),
  ('seed_user_03', date('now','-2 days'), 111, 8436, 'KR'),
  ('seed_user_03', date('now','-1 days'), 112, 7728, 'KR'),
  -- 이번 주 금·토·일 (weekend 보드)
  ('seed_user_09', date(date('now','-'||((CAST(strftime('%w',date('now')) AS INTEGER)+6)%7)||' days'),'+4 days'),  90, 12000, 'KR'),
  ('seed_user_09', date(date('now','-'||((CAST(strftime('%w',date('now')) AS INTEGER)+6)%7)||' days'),'+5 days'), 120, 16000, 'KR'),
  ('seed_user_09', date(date('now','-'||((CAST(strftime('%w',date('now')) AS INTEGER)+6)%7)||' days'),'+6 days'), 110, 14000, 'KR'),
  ('seed_user_05', date(date('now','-'||((CAST(strftime('%w',date('now')) AS INTEGER)+6)%7)||' days'),'+4 days'), 130, 15000, 'KR'),
  ('seed_user_05', date(date('now','-'||((CAST(strftime('%w',date('now')) AS INTEGER)+6)%7)||' days'),'+5 days'), 140, 17000, 'KR'),
  ('seed_user_03', date(date('now','-'||((CAST(strftime('%w',date('now')) AS INTEGER)+6)%7)||' days'),'+6 days'), 160, 18000, 'KR'),
  -- 이번 주 평일 추가 (weekly 합산 증가)
  ('seed_user_01', date(date('now','-'||((CAST(strftime('%w',date('now')) AS INTEGER)+6)%7)||' days'),'+1 days'), 200, 16000, 'KR'),
  ('seed_user_03', date(date('now','-'||((CAST(strftime('%w',date('now')) AS INTEGER)+6)%7)||' days'),'+2 days'), 180, 20000, 'KR'),
  ('seed_user_05', date(date('now','-'||((CAST(strftime('%w',date('now')) AS INTEGER)+6)%7)||' days'),'+0 days'), 150, 18000, 'KR')
-- daily_stats PK 는 0006 에서 (user_id, day, agent) 로 바뀌었다. agent 를 생략한 위 INSERT 는
-- DEFAULT 'claude-code' 로 들어가므로, 충돌 타깃도 실제 PK 3개 컬럼을 그대로 명시한다.
ON CONFLICT(user_id, day, agent) DO UPDATE SET
  prompts = daily_stats.prompts + excluded.prompts,
  chars   = daily_stats.chars   + excluded.chars;

-- ── 상세 페이지 데모용 원시 이벤트 (30일 그래프·시간별·스트릭) ──
-- 상세 페이지는 daily_stats(공용 UTC)가 아니라 events(created_at=UTC ms)를 유저 TZ(seed 유저는
-- Asia/Seoul)로 재집계해 그린다. 그래서 시드 이벤트를 Seoul-로컬 일자/시각 기준으로 심는다.
--   Seoul-오늘 자정(UTC 초) = (KST 일수) * 86400 - 32400.  (문자열 '+9 hours' 대신 정수식 —
--   아래 daily_stats 의 KST→UTC 치환 sed 에 안 걸리도록.) +일·+시 하면 그 로컬 시각의 UTC.
-- seed_user_01: 최근 16일(하루 9~22시 분포), 13일 전 하루 공백 → 스트릭 13일.
INSERT INTO events (user_id, chars, country, agent, created_at)
WITH RECURSIVE
  kmid(sec) AS (VALUES (CAST((unixepoch('now') + 32400) / 86400 AS INTEGER) * 86400 - 32400)),
  d01(o, cnt) AS (
    VALUES (0,42),(1,55),(2,60),(3,48),(4,70),(5,52),(6,38),(7,66),(8,58),(9,44),(10,72),(11,50),(12,63),(13,0),(14,40),(15,47)
  ),
  seq(o, cnt, i) AS (
    SELECT o, cnt, 1 FROM d01 WHERE cnt > 0
    UNION ALL SELECT o, cnt, i + 1 FROM seq WHERE i < cnt
  )
SELECT
  'seed_user_01',
  120 + (i * 53 + o * 17) % 900,                                     -- chars 변주(대략 120~1020)
  'KR', 'claude-code',
  ((SELECT sec FROM kmid) - o * 86400 + (9 + (i % 14)) * 3600 + (i * 137) % 3600) * 1000
FROM seq;

-- seed_user_03(새벽5시개발자): 오늘 이른 아침(4~9시) — 시간별 뷰 얼리버드 데모.
INSERT INTO events (user_id, chars, country, agent, created_at)
WITH RECURSIVE
  kmid(sec) AS (VALUES (CAST((unixepoch('now') + 32400) / 86400 AS INTEGER) * 86400 - 32400)),
  seq(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM seq WHERE i < 48)
SELECT
  'seed_user_03',
  200 + (i * 91) % 1200,
  'KR', 'claude-code',
  ((SELECT sec FROM kmid) + (4 + (i % 6)) * 3600 + (i * 211) % 3600) * 1000
FROM seq;

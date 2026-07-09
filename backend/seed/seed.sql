-- Open Code War — 로컬/데모용 시드 데이터 (재실행 가능)
-- day 값은 실행 시점의 KST 기준으로 계산되어 daily/weekly/weekend 보드에 모두 데이터가 잡힌다.
-- 날짜 식(반복 등장):
--   오늘(KST)  = date('now','+9 hours')
--   이번주 월  = date('now','+9 hours','-'||((CAST(strftime('%w',date('now','+9 hours')) AS INTEGER)+6)%7)||' days')
--   금/토/일   = 위 월요일에 +4 / +5 / +6 days

DELETE FROM daily_stats WHERE user_id LIKE 'seed_user_%';
DELETE FROM users WHERE user_id LIKE 'seed_user_%';

INSERT INTO users (user_id, nickname, country, created_at, last_seen_at) VALUES
  ('seed_user_01', '코드깎는노인',   'KR', unixepoch() * 1000, unixepoch() * 1000),
  ('seed_user_02', 'vim_귀신',       'KR', unixepoch() * 1000, unixepoch() * 1000),
  ('seed_user_03', '새벽5시개발자',  'KR', unixepoch() * 1000, unixepoch() * 1000),
  ('seed_user_04', '반포자이코더',   'KR', unixepoch() * 1000, unixepoch() * 1000),
  ('seed_user_05', '프롬프트장인',   'KR', unixepoch() * 1000, unixepoch() * 1000),
  ('seed_user_06', '리팩터_고양이',  'KR', unixepoch() * 1000, unixepoch() * 1000),
  ('seed_user_07', '세미콜론수집가', 'KR', unixepoch() * 1000, unixepoch() * 1000),
  ('seed_user_08', '버그사냥꾼',     'KR', unixepoch() * 1000, unixepoch() * 1000),
  ('seed_user_09', '토큰_수도꼭지',  'KR', unixepoch() * 1000, unixepoch() * 1000),
  ('seed_user_10', NULL,             'KR', unixepoch() * 1000, unixepoch() * 1000);

INSERT INTO daily_stats (user_id, day, prompts, chars, country) VALUES
  -- 오늘 (daily 보드)
  ('seed_user_01', date('now','+9 hours'), 247, 19840, 'KR'),
  ('seed_user_02', date('now','+9 hours'), 233, 15120, 'KR'),
  ('seed_user_03', date('now','+9 hours'), 201, 22310, 'KR'),
  ('seed_user_04', date('now','+9 hours'), 188, 12040, 'KR'),
  ('seed_user_05', date('now','+9 hours'), 174, 20880, 'KR'),
  ('seed_user_06', date('now','+9 hours'), 159,  9910, 'KR'),
  ('seed_user_07', date('now','+9 hours'), 151, 14200, 'KR'),
  ('seed_user_08', date('now','+9 hours'), 142, 11760, 'KR'),
  ('seed_user_09', date('now','+9 hours'), 129, 16650, 'KR'),
  ('seed_user_10', date('now','+9 hours'), 112,  9040, 'KR'),
  -- 이번 주 금·토·일 (weekend 보드)
  ('seed_user_09', date(date('now','+9 hours','-'||((CAST(strftime('%w',date('now','+9 hours')) AS INTEGER)+6)%7)||' days'),'+4 days'),  90, 12000, 'KR'),
  ('seed_user_09', date(date('now','+9 hours','-'||((CAST(strftime('%w',date('now','+9 hours')) AS INTEGER)+6)%7)||' days'),'+5 days'), 120, 16000, 'KR'),
  ('seed_user_09', date(date('now','+9 hours','-'||((CAST(strftime('%w',date('now','+9 hours')) AS INTEGER)+6)%7)||' days'),'+6 days'), 110, 14000, 'KR'),
  ('seed_user_05', date(date('now','+9 hours','-'||((CAST(strftime('%w',date('now','+9 hours')) AS INTEGER)+6)%7)||' days'),'+4 days'), 130, 15000, 'KR'),
  ('seed_user_05', date(date('now','+9 hours','-'||((CAST(strftime('%w',date('now','+9 hours')) AS INTEGER)+6)%7)||' days'),'+5 days'), 140, 17000, 'KR'),
  ('seed_user_03', date(date('now','+9 hours','-'||((CAST(strftime('%w',date('now','+9 hours')) AS INTEGER)+6)%7)||' days'),'+6 days'), 160, 18000, 'KR'),
  -- 이번 주 평일 추가 (weekly 합산 증가)
  ('seed_user_01', date(date('now','+9 hours','-'||((CAST(strftime('%w',date('now','+9 hours')) AS INTEGER)+6)%7)||' days'),'+1 days'), 200, 16000, 'KR'),
  ('seed_user_03', date(date('now','+9 hours','-'||((CAST(strftime('%w',date('now','+9 hours')) AS INTEGER)+6)%7)||' days'),'+2 days'), 180, 20000, 'KR'),
  ('seed_user_05', date(date('now','+9 hours','-'||((CAST(strftime('%w',date('now','+9 hours')) AS INTEGER)+6)%7)||' days'),'+0 days'), 150, 18000, 'KR')
ON CONFLICT(user_id, day) DO UPDATE SET
  prompts = daily_stats.prompts + excluded.prompts,
  chars   = daily_stats.chars   + excluded.chars;

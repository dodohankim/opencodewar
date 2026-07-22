-- 유저 타임존(IANA) — 상세 페이지를 그 유저의 로컬 시간으로 보여주기 위함.
-- 트래킹 시 request.cf.timezone(예: 'America/Los_Angeles')을 users 생성 시 저장한다.
-- 리더보드는 공용 UTC 이므로 이 값과 무관하고, 상세 페이지(30일 그래프·시간별·스트릭)만
-- 원시 events(created_at=UTC ms)를 이 TZ 로컬 일자/시각으로 재집계해 그린다.
-- 기존/미상 유저는 NULL → 코드에서 UTC 로 폴백.
ALTER TABLE users ADD COLUMN timezone TEXT;

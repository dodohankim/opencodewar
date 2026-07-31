-- 프로젝트별 프롬프트 추적 (DESIGN.md §20)
-- events 에 project 라벨 컬럼 추가. NULL = 미지정(링크 안 된 폴더 — 기존 이벤트 전부).
-- daily_stats 는 건드리지 않는다 — 상세 페이지는 원시 events 재집계라 일별 분해가 여기서 나오고,
-- 집계 차원을 늘리지 않아 쓰기 행 증가도 0(§13 write-diet).
ALTER TABLE events ADD COLUMN project TEXT;

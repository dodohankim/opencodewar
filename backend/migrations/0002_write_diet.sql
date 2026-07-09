-- 쓰기 절감 (DESIGN.md §13)
-- events는 감사/재집계용이지만 현재 조회하지 않으므로 인덱스를 제거해
-- INSERT 시 인덱스 쓰기(= 과금되는 "쓴 행")를 없앤다. 필요해지면 다시 추가.
DROP INDEX IF EXISTS idx_events_user_time;
DROP INDEX IF EXISTS idx_events_time;

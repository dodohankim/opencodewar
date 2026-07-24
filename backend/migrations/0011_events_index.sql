-- events 유저별 조회 인덱스 복구.
-- 0002 는 "events 는 조회하지 않는다" 전제로 이 인덱스를 지웠지만, 0008(타임존)부터
-- 유저 상세(/user·/user/hours)가 원시 events 를 유저별로 조회한다. 인덱스가 없으면
-- 상세 1회 열람마다 events 전체 풀스캔 — D1 은 행 단위 과금(rows_read)이라 비용이
-- 테이블 크기에 비례해 늘고(무료 500만 행/일), 응답도 느려진다.
-- INSERT 당 인덱스 쓰기 +1행은 상세 조회 절감으로 상쇄. (DESIGN.md §13)
CREATE INDEX IF NOT EXISTS idx_events_user_time ON events(user_id, created_at);

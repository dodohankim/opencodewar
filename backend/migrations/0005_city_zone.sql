-- 구역(zone) 기능: "이 구역 코드워리어".
-- - country : 이미 존재(IP 자동, users.country). 국가 구역 랭킹에 사용.
-- - city    : 유저 자기선언 도시(자유 입력). /profile 로 설정, 닉네임과 동일 신뢰 모델.
-- 도시 구역 그룹 키 = (users.country, LOWER(city)). 동명 도시(파리 FR/US) 분리 + 표시는 원문.
ALTER TABLE users ADD COLUMN city TEXT;

-- 구역 랭킹 조회(국가 필터 / 국가+도시 필터) 가속. users 쓰기는 저빈도라 인덱스 부담 무시 가능.
CREATE INDEX IF NOT EXISTS idx_users_country ON users(country);
CREATE INDEX IF NOT EXISTS idx_users_city ON users(country, city);

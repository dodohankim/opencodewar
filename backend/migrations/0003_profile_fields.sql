-- 유저 프로필 확장: 자기소개(bio)와 이메일(email) 컬럼 추가.
-- - bio  : 닉네임과 동일한 신뢰 모델(비밀 userId 소유자만 설정) → /profile 에서 설정.
-- - email: 로그인/회원가입 도입 전까지 예약 컬럼(항상 NULL). 상세 페이지는 빈 칸으로 표시.
ALTER TABLE users ADD COLUMN bio TEXT;
ALTER TABLE users ADD COLUMN email TEXT;

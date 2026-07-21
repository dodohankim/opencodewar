-- 공개 프로필 slug(public_id) 추가 — 익명(닉네임 미등록) 유저도 상세 페이지로 라우팅.
-- user_id(비밀키) 노출 없이, 노출해도 안전한 별도 공개 식별자를 유저마다 발급한다.

ALTER TABLE users ADD COLUMN public_id TEXT;

-- 기존 유저 백필: 'u-' + 10자 랜덤(hex). hex(randomblob(5)) = 10자 [0-9a-f] ⊂ [0-9a-z]
-- → 앱 정규식 /^u-[0-9a-z]{10}$/ 와 일치. randomblob 은 행마다 새로 평가되어 값이 서로 다르다.
UPDATE users SET public_id = 'u-' || lower(hex(randomblob(5))) WHERE public_id IS NULL;

-- 유일성 보장(ALTER 로 UNIQUE 제약을 못 붙이므로 UNIQUE INDEX 로 강제).
CREATE UNIQUE INDEX IF NOT EXISTS idx_users_public_id ON users(public_id);

-- 프로필 확장: 직함(role)·회사(company)·소셜 링크(links)·사이드프로젝트(projects).
-- 모두 닉네임/bio 와 동일한 신뢰 모델(비밀 userId 소유자만 /profile 로 설정).
--   role    : 직함 한 줄, 예: 'Frontend Engineer'
--   company : 회사/소속 한 줄, 예: 'Camfit'
--   links   : 소셜/개인 링크 JSON 객체 {website?, github?, x?, linkedin?} (모두 http(s) URL)
--   projects: 홍보용 사이드프로젝트 JSON 배열 [{name, desc?, url?}], 최대 5개
ALTER TABLE users ADD COLUMN role TEXT;
ALTER TABLE users ADD COLUMN company TEXT;
ALTER TABLE users ADD COLUMN links TEXT;
ALTER TABLE users ADD COLUMN projects TEXT;

-- 이메일 공개 옵트인 (DESIGN.md §14.8 — 기본 비공개).
-- 1이면 공개 프로필(/user·웹 상세)에 연동 이메일을 노출한다. 본인(/me)은 항상 볼 수 있다.
ALTER TABLE accounts ADD COLUMN email_public INTEGER NOT NULL DEFAULT 0;

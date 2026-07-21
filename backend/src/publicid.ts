// 공개 프로필 slug(public_id).
// - user_id 는 인증 비밀키라 URL·리더보드에 노출할 수 없다(plugin/README.md).
//   그래서 닉네임 미등록(익명) 유저도 상세 페이지로 라우팅할 수 있도록,
//   노출해도 안전한 별도 공개 식별자를 유저마다 하나씩 발급한다.
// - 형식: 'u-' + 10자 [0-9a-z]. 하이픈을 포함해 **닉네임과 구조적으로 구분**된다
//   (닉네임 정규식 [\w가-힣 ]에는 하이픈이 없음) → '/u/<seg>' 라우팅에서 모호성이 없다.
// - user_id 로부터 파생하지 않는다(역추론 불가) — 순수 랜덤.

const ALPHABET = '0123456789abcdefghijklmnopqrstuvwxyz';

/** public_id 형식: 'u-' + 10자 [0-9a-z]. (닉네임과 구분되는 하이픈 포함) */
export const PUBLIC_ID_RE = /^u-[0-9a-z]{10}$/;

export function isValidPublicId(v: unknown): v is string {
  return typeof v === 'string' && PUBLIC_ID_RE.test(v);
}

/**
 * 새 public_id 발급. crypto 랜덤 10자(base36) → 36^10(≈3.6e15) 공간이라 충돌은 사실상 없음.
 * (만약의 UNIQUE 충돌은 INSERT 시 batch 실패로 드러나며, 확률이 극히 낮아 재시도는 두지 않는다.)
 */
export function newPublicId(): string {
  const bytes = new Uint8Array(10);
  crypto.getRandomValues(bytes);
  let s = '';
  for (let i = 0; i < 10; i++) s += ALPHABET[bytes[i] % 36];
  return 'u-' + s;
}

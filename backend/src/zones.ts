// 구역(zone) 유틸: 국가 국기 이모지 + 자기선언 도시 정규화.
// 국가는 IP(users.country, ISO 3166-1 alpha-2), 도시는 유저 자유 입력.

/** 2글자 국가코드 → 국기 이모지(regional indicator). 유효하지 않으면 빈 문자열. */
export function countryFlag(code: unknown): string {
  if (typeof code !== 'string' || !/^[A-Za-z]{2}$/.test(code)) return '';
  const cc = code.toUpperCase();
  return String.fromCodePoint(cc.charCodeAt(0) + 0x1f1a5, cc.charCodeAt(1) + 0x1f1a5);
}

/**
 * 자유 입력 도시 → 저장용 표시 문자열.
 * 앞뒤 공백 제거 + 내부 연속 공백 1칸으로 축소(대소문자는 표시용으로 보존).
 * 빈 문자열이면 null("도시 해제").
 */
export function cleanCity(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const t = raw.trim().replace(/\s+/g, ' ');
  return t.length ? t : null;
}

/** 도시 그룹 키(소문자). 표시 도시 문자열 → 정규화 키. */
export function cityKey(city: string): string {
  return city.trim().replace(/\s+/g, ' ').toLowerCase();
}

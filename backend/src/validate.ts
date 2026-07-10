import type { BoardType, Metric } from './types';

/** 익명 userId: 영숫자/underscore/hyphen 8~64자. (플러그인이 발급하는 형식) */
const USER_ID_RE = /^[A-Za-z0-9_-]{8,64}$/;
export function isValidUserId(v: unknown): v is string {
  return typeof v === 'string' && USER_ID_RE.test(v);
}

/** 이벤트 1건당 인정 글자 수 상한 (어뷰징에 의한 폭증 방지). */
export const MAX_CHARS_PER_EVENT = 20_000;
export function clampChars(v: unknown): number {
  const n = typeof v === 'number' ? v : Number(v);
  if (!Number.isFinite(n) || n < 0) return 0;
  return Math.min(Math.floor(n), MAX_CHARS_PER_EVENT);
}

/** 닉네임: 한글/영숫자/underscore/공백, 2~20자. (공백 트림 후 검사) TODO: 비속어 필터. */
const NICKNAME_RE = /^[\w가-힣 ]{2,20}$/u;
export function isValidNickname(v: unknown): v is string {
  if (typeof v !== 'string') return false;
  const t = v.trim();
  return t.length >= 2 && t.length <= 20 && NICKNAME_RE.test(t);
}

/** 자기소개: 한 줄, 0~160자(트림 후). 빈 문자열은 "해제"로 허용. 제어문자 금지. */
export const MAX_BIO_LEN = 160;
const BIO_CONTROL_RE = /[\u0000-\u001F\u007F]/;
export function isValidBio(v: unknown): v is string {
  if (typeof v !== 'string') return false;
  const t = v.trim();
  if (t.length > MAX_BIO_LEN) return false;
  return !BIO_CONTROL_RE.test(t);
}

export function parseMetric(v: string | null): Metric {
  return v === 'chars' ? 'chars' : 'prompts';
}

export function parseType(v: string | null): BoardType {
  return v === 'weekly' || v === 'weekend' ? v : 'daily';
}

export const DEFAULT_LIMIT = 100;
export const MAX_LIMIT = 500;
export function clampLimit(v: string | null): number {
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_LIMIT;
  return Math.min(Math.floor(n), MAX_LIMIT);
}

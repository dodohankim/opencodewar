import type { BoardType, Metric } from './types';

/** 익명 userId: 영숫자/underscore/hyphen 8~64자. (플러그인이 발급하는 형식) */
const USER_ID_RE = /^[A-Za-z0-9_-]{8,64}$/;
export function isValidUserId(v: unknown): v is string {
  return typeof v === 'string' && USER_ID_RE.test(v);
}

/** 트래킹을 보낼 수 있는 에이전트(클라이언트) 화이트리스트. DB 컬럼 값으로 그대로 저장된다. */
export const AGENTS = ['claude-code', 'codex', 'opencode', 'pi'] as const;
export type Agent = (typeof AGENTS)[number];
export const DEFAULT_AGENT: Agent = 'claude-code';

/**
 * agent 값 정규화. 미지정·미지원 값은 기본값(claude-code)으로 받는다 —
 * 구버전 플러그인은 agent 필드 없이 보내며, 그 전부가 Claude Code 훅이었다.
 * (화이트리스트 강제로 임의 문자열이 DB에 쌓이는 것도 함께 차단.)
 */
export function normalizeAgent(v: unknown): Agent {
  return typeof v === 'string' && (AGENTS as readonly string[]).includes(v) ? (v as Agent) : DEFAULT_AGENT;
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

/** 직함(role)·회사(company)·도시(city): 한 줄, 0~40자(트림 후). 빈 문자열은 "해제". 제어문자 금지. */
export const MAX_ROLE_LEN = 40;
export const MAX_COMPANY_LEN = 40;
export const MAX_CITY_LEN = 40;
export function isValidShortText(v: unknown, max: number): v is string {
  if (typeof v !== 'string') return false;
  const t = v.trim();
  if (t.length > max) return false;
  return !BIO_CONTROL_RE.test(t);
}

/** 국가코드 파라미터: ISO 3166-1 alpha-2(2글자 영문). 구역 리더보드 필터용. */
const COUNTRY_RE = /^[A-Za-z]{2}$/;
export function isValidCountryCode(v: unknown): v is string {
  return typeof v === 'string' && COUNTRY_RE.test(v);
}

/** 시간별(hours) 조회 day 파라미터: 실재하는 'YYYY-MM-DD'인지(형식 + 왕복 검증). */
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
export function isValidDay(v: unknown): v is string {
  if (typeof v !== 'string' || !DAY_RE.test(v)) return false;
  const t = Date.parse(`${v}T00:00:00Z`);
  // 2026-13-40 처럼 형식은 맞지만 존재하지 않는 날짜를 배제(파싱 후 다시 문자열화해 대조).
  return Number.isFinite(t) && new Date(t).toISOString().slice(0, 10) === v;
}

/** 링크/프로젝트 URL: http(s) 절대 URL, 최대 200자. (웹에서 rel=nofollow 로 렌더) */
export const MAX_URL_LEN = 200;
export function isValidUrl(v: unknown): v is string {
  if (typeof v !== 'string') return false;
  const t = v.trim();
  if (!t || t.length > MAX_URL_LEN) return false;
  try {
    const u = new URL(t);
    return u.protocol === 'http:' || u.protocol === 'https:';
  } catch {
    return false;
  }
}

/** 허용되는 링크 키. website·blog 는 개인 사이트(웹에서 host 텍스트로 표시), 나머지는 SNS(아이콘 표시). */
export const LINK_KEYS = ['website', 'blog', 'github', 'x', 'linkedin'] as const;
export type LinkKey = (typeof LINK_KEYS)[number];
export type Links = Partial<Record<LinkKey, string>>;

/**
 * links 객체를 검증·정규화한다. 허용 키만, 값은 http(s) URL(트림).
 * 빈 문자열 값은 "해당 링크 해제"로 간주해 결과에서 제외한다.
 * 유효하지 않으면 null(요청 거절), 유효하면 정규화된 객체(빈 객체 = 전체 해제).
 */
export function normalizeLinks(v: unknown): Links | null {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return null;
  const out: Links = {};
  for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
    if (!LINK_KEYS.includes(k as LinkKey)) return null;
    if (typeof val !== 'string') return null;
    const t = val.trim();
    if (!t) continue; // 빈 값 = 해제
    if (!isValidUrl(t)) return null;
    out[k as LinkKey] = t;
  }
  return out;
}

/** 홍보용 사이드프로젝트. name 필수, desc·url 선택. */
export const MAX_PROJECTS = 5;
export const MAX_PROJECT_NAME_LEN = 40;
export const MAX_PROJECT_DESC_LEN = 80;
export interface Project {
  name: string;
  desc?: string;
  url?: string;
}

/**
 * projects 배열을 검증·정규화한다. 최대 5개, 각 항목 {name, desc?, url?}.
 * 빈 desc/url 은 결과에서 생략한다. 유효하지 않으면 null, 빈 배열은 "전체 해제".
 */
export function normalizeProjects(v: unknown): Project[] | null {
  if (!Array.isArray(v)) return null;
  if (v.length > MAX_PROJECTS) return null;
  const out: Project[] = [];
  for (const item of v) {
    if (typeof item !== 'object' || item === null) return null;
    const rec = item as Record<string, unknown>;
    if (!isValidShortText(rec.name, MAX_PROJECT_NAME_LEN)) return null;
    const name = (rec.name as string).trim();
    if (!name) return null; // name 은 필수
    const project: Project = { name };
    if (rec.desc !== undefined && rec.desc !== null && rec.desc !== '') {
      if (!isValidShortText(rec.desc, MAX_PROJECT_DESC_LEN)) return null;
      const desc = (rec.desc as string).trim();
      if (desc) project.desc = desc;
    }
    if (rec.url !== undefined && rec.url !== null && rec.url !== '') {
      if (!isValidUrl(rec.url)) return null;
      project.url = (rec.url as string).trim();
    }
    out.push(project);
  }
  return out;
}

export function parseMetric(v: string | null): Metric {
  return v === 'chars' ? 'chars' : 'prompts';
}

export function parseType(v: string | null): BoardType {
  return v === 'weekly' || v === 'weekend' || v === 'monthly' ? v : 'daily';
}

export const DEFAULT_LIMIT = 100;
export const MAX_LIMIT = 500;
export function clampLimit(v: string | null): number {
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_LIMIT;
  return Math.min(Math.floor(n), MAX_LIMIT);
}

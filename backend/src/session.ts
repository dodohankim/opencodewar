// 웹 세션 (DESIGN.md §14.9) — 브라우저에서 로그인/가입하고 자기 프로필을 고치기 위한 계층.
//
// CLI 와 자격증명이 다르다:
//   · CLI  = 비밀 userId 를 매 요청 body 에 담아 보낸다(기존 /track, /profile, /register …).
//   · 웹   = HttpOnly 쿠키 세션. **userId 를 브라우저에 절대 내려보내지 않는다** —
//            userId 는 track 권한까지 가진 bearer 비밀키라 XSS 한 번이면 통째로 털린다.
// 그래서 /api/* 는 body 의 userId 를 아예 읽지 않고 세션에서만 주체를 얻는다.

import type { Env } from './types';

/** 세션 유효기간(초). 30일 — 리더보드 서비스라 재로그인 강제는 의미가 적다. */
export const SESSION_TTL_S = 60 * 60 * 24 * 30;

const COOKIE_NAME = 'ocw_sess';
/** 세션 토큰 형식: hex 32자(128bit). KV 키에 그대로 쓰므로 형식 검증 후에만 조회한다. */
const TOKEN_RE = /^[0-9a-f]{32}$/;

export interface SessionRecord {
  /** 이 세션의 주체(canonical users.user_id). 브라우저로는 나가지 않는다. */
  userId: string;
  /** 로그인에 쓴 Google 계정 — 계정 전환 감지·표시에 쓴다. */
  googleSub: string;
  email: string | null;
  createdAt: number;
}

export function randomToken(): string {
  const buf = crypto.getRandomValues(new Uint8Array(16));
  return Array.from(buf, (b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * 웹에서 처음 가입하는 유저의 userId.
 * 플러그인(config.mjs 의 'ocw_' + uuid-hex)과 **같은 36자 형식**이어야 한다 —
 * 이 값이 나중에 CLI 병합의 canonical userId 가 되어 config.userId 로 들어가고,
 * 거기서 /track 이 isValidUserId(최대 64자)를 통과해야 하기 때문이다.
 */
export function newWebUserId(): string {
  return 'ocw_' + randomToken();
}

function sessionKey(token: string): string {
  return `sess:${token}`;
}

/** Cookie 헤더에서 세션 토큰만 뽑는다(형식 불일치면 null). */
function tokenFromRequest(request: Request): string | null {
  const raw = request.headers.get('cookie');
  if (!raw) return null;
  for (const part of raw.split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    if (part.slice(0, i).trim() !== COOKIE_NAME) continue;
    const v = part.slice(i + 1).trim();
    return TOKEN_RE.test(v) ? v : null;
  }
  return null;
}

export async function createSession(env: Env, rec: Omit<SessionRecord, 'createdAt'>): Promise<string> {
  const token = randomToken();
  await env.KV.put(sessionKey(token), JSON.stringify({ ...rec, createdAt: Date.now() } satisfies SessionRecord), {
    expirationTtl: SESSION_TTL_S,
  });
  return token;
}

export async function getSession(request: Request, env: Env): Promise<(SessionRecord & { token: string }) | null> {
  const token = tokenFromRequest(request);
  if (!token) return null;
  const rec = await env.KV.get<SessionRecord>(sessionKey(token), 'json');
  return rec ? { ...rec, token } : null;
}

export async function destroySession(request: Request, env: Env): Promise<void> {
  const token = tokenFromRequest(request);
  if (token) await env.KV.delete(sessionKey(token));
}

/**
 * 세션 쿠키 헤더 값.
 * - HttpOnly: JS 가 못 읽는다(위 주석의 XSS 시나리오 차단).
 * - SameSite=Lax: 크로스사이트 POST 에 쿠키가 실리지 않는다 → /api/* 의 1차 CSRF 방어.
 * - Secure: localhost 는 브라우저가 secure origin 으로 취급하므로 로컬 개발에도 그대로 붙인다.
 */
export function sessionCookie(token: string): string {
  return `${COOKIE_NAME}=${token}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=${SESSION_TTL_S}`;
}

export function clearSessionCookie(): string {
  return `${COOKIE_NAME}=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0`;
}

/**
 * 상태를 바꾸는 /api/* 요청의 Origin 검사(SameSite=Lax 위에 얹는 2차 방어).
 * Origin 이 없는 요청(구형 브라우저·일부 fetch 경로)은 통과시키지 않는다 — 웹 UI 는 항상 붙여 보낸다.
 */
export function isSameOrigin(request: Request, url: URL): boolean {
  const origin = request.headers.get('origin');
  return origin === url.origin;
}

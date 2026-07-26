// Google 계정 연동 (DESIGN.md §14).
// 플로우: CLI(/ocw signup) → POST /auth/start(링크 코드 발급) → 브라우저 GET /auth/link/<code>
//   → Google OAuth → GET /auth/callback → 확인 페이지(link-jacking 방지) → POST /auth/confirm(연동+병합)
//   → CLI가 다음 실행 때 GET /auth/status 로 결과 회수(pendingLinkCode 패턴 — 슬래시 커맨드는 폴링 불가).
// 로컬(플러그인)에는 Google 토큰을 저장하지 않는다 — 자격증명은 계속 userId 하나다.

import type { Env } from './types';
import { json, readJson } from './http';
import { isValidUserId } from './validate';
import { isValidTimezone } from './tz';
import { displayNickname } from './nickname';
import { newPublicId } from './publicid';
import {
  createSession,
  clearSessionCookie,
  destroySession,
  newWebUserId,
  randomToken,
  sessionCookie,
} from './session';

/** 링크 코드 유효기간(초) — 브라우저에서 Google 로그인을 마칠 때까지의 여유. */
const PENDING_TTL_S = 600;
/** 완료 기록 보존(초) — CLI가 한참 뒤에 /ocw 를 실행해도 결과를 회수할 수 있게. */
const DONE_TTL_S = 60 * 60 * 24;

const GOOGLE_AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';

/** 링크 코드/nonce/확인 토큰 형식: hex 32자(128bit) — 브루트포스 불가. */
const TOKEN_RE = /^[0-9a-f]{32}$/;

interface AuthLinkRecord {
  /** 연동을 시작한 기기의 userId. /auth/status 조회 시 본인 확인에도 쓴다. */
  userId: string;
  /** OAuth state CSRF nonce. */
  nonce: string;
  status: 'pending' | 'awaiting_confirm' | 'done';
  createdAt: number;
  // awaiting_confirm 이후
  googleSub?: string;
  email?: string | null;
  confirmToken?: string;
  // done 이후
  canonicalUserId?: string;
  firstSignup?: boolean;
  merged?: { prompts: number; chars: number } | null;
}

function kvKey(code: string): string {
  return `auth:${code}`;
}

async function loadRecord(env: Env, code: string | null): Promise<AuthLinkRecord | null> {
  if (typeof code !== 'string' || !TOKEN_RE.test(code)) return null;
  return env.KV.get<AuthLinkRecord>(kvKey(code), 'json');
}

async function saveRecord(env: Env, code: string, rec: AuthLinkRecord, ttlS: number): Promise<void> {
  await env.KV.put(kvKey(code), JSON.stringify(rec), { expirationTtl: ttlS });
}

// ── HTML 페이지 (브라우저 구간 전용, 최소 스타일) ─────────────────────────────

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function page(title: string, inner: string, status = 200): Response {
  const html = `<!doctype html>
<html lang="ko"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex"><title>${escapeHtml(title)} · Open Code War</title>
<style>
  body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;
    background:#1a1915;color:#e8e6dc;font-family:ui-monospace,SFMono-Regular,Menlo,monospace}
  .card{max-width:26rem;padding:2rem;border:1px solid #3a382f;border-radius:12px;background:#211f1a}
  h1{font-size:1.05rem;margin:0 0 .75rem}
  p{font-size:.85rem;line-height:1.6;color:#b8b5a7;margin:.5rem 0}
  b{color:#e8e6dc}
  button{margin-top:1rem;padding:.6rem 1.2rem;border:0;border-radius:8px;background:#d97757;color:#fff;
    font:inherit;font-weight:700;cursor:pointer;width:100%}
  code{background:#2b2922;padding:.1rem .35rem;border-radius:4px}
</style></head><body><div class="card">${inner}</div></body></html>`;
  return new Response(html, { status, headers: { 'Content-Type': 'text/html; charset=utf-8' } });
}

function errorPage(msg: string): Response {
  return page('연동 실패', `<h1>✗ 연동 실패</h1><p>${msg}</p><p>터미널에서 <code>/ocw signup</code> 을 다시 실행해 새 링크를 받으세요.</p>`, 400);
}

// ── 병합 ─────────────────────────────────────────────────────────────────────

/**
 * old 유저의 데이터를 canonical 로 이관(멱등). 반환값은 이번에 옮긴 사용량.
 * events 는 user_id 만 바꾸고, daily_stats 는 (user_id, day, agent) 충돌 시 합산한다.
 * 프로필 충돌은 canonical 우선 — old 의 users 행은 삭제한다(§14.4).
 */
async function mergeUserData(env: Env, oldId: string, canonicalId: string): Promise<{ prompts: number; chars: number }> {
  const totals = await env.DB.prepare(
    'SELECT COALESCE(SUM(prompts), 0) AS p, COALESCE(SUM(chars), 0) AS c FROM daily_stats WHERE user_id = ?',
  )
    .bind(oldId)
    .first<{ p: number; c: number }>();
  const moved = { prompts: Number(totals?.p) || 0, chars: Number(totals?.c) || 0 };

  await env.DB.batch([
    // canonical users 행 보장(기기 초기화 등으로 없을 수 있음) — 있으면 무시.
    env.DB.prepare('INSERT OR IGNORE INTO users (user_id, public_id, created_at) VALUES (?, ?, ?)').bind(
      canonicalId,
      newPublicId(),
      Date.now(),
    ),
    env.DB.prepare('UPDATE events SET user_id = ? WHERE user_id = ?').bind(canonicalId, oldId),
    env.DB.prepare(
      `INSERT INTO daily_stats (user_id, day, agent, prompts, chars, country)
         SELECT ?, day, agent, prompts, chars, country FROM daily_stats WHERE user_id = ?
       ON CONFLICT(user_id, day, agent) DO UPDATE SET
         prompts = prompts + excluded.prompts,
         chars   = chars   + excluded.chars`,
    ).bind(canonicalId, oldId),
    env.DB.prepare('DELETE FROM daily_stats WHERE user_id = ?').bind(oldId),
    env.DB.prepare('DELETE FROM users WHERE user_id = ?').bind(oldId),
  ]);
  return moved;
}

// ── 핸들러 ───────────────────────────────────────────────────────────────────

/** POST /auth/start {userId} — 링크 코드 발급. CLI(/ocw signup)가 호출한다. */
export async function handleAuthStart(request: Request, env: Env): Promise<Response> {
  // /track 과 같은 IP rate-limiter 를 공유 — 코드 발급 남발(KV 쓰기 폭증) 방지.
  const ip = request.headers.get('cf-connecting-ip') ?? 'unknown';
  const { success } = await env.TRACK_RATE_LIMITER.limit({ key: ip });
  if (!success) return json({ error: 'rate_limited' }, 429);

  const body = await readJson(request);
  if (!body || !isValidUserId(body.userId)) return json({ error: 'invalid_userId' }, 400);

  const code = randomToken();
  const rec: AuthLinkRecord = { userId: body.userId, nonce: randomToken(), status: 'pending', createdAt: Date.now() };
  await saveRecord(env, code, rec, PENDING_TTL_S);

  const origin = new URL(request.url).origin;
  return json({ code, url: `${origin}/auth/link/${code}`, expiresIn: PENDING_TTL_S });
}

/** GET /auth/link/:code — Google OAuth 로 302. 브라우저 구간의 진입점. */
export async function handleAuthLink(url: URL, env: Env, code: string): Promise<Response> {
  if (!env.GOOGLE_CLIENT_ID) return errorPage('서버에 Google 로그인이 아직 설정되지 않았습니다.');
  const rec = await loadRecord(env, code);
  if (!rec || rec.status !== 'pending') return errorPage('링크가 만료되었거나 이미 사용되었습니다.');

  const auth = new URL(GOOGLE_AUTH_URL);
  auth.searchParams.set('client_id', env.GOOGLE_CLIENT_ID);
  auth.searchParams.set('redirect_uri', `${url.origin}/auth/callback`);
  auth.searchParams.set('response_type', 'code');
  auth.searchParams.set('scope', 'openid email');
  auth.searchParams.set('state', `${code}.${rec.nonce}`);
  auth.searchParams.set('prompt', 'select_account');
  return Response.redirect(auth.toString(), 302);
}

/**
 * authorization code → id_token 교환 후 클레임 반환.
 * TLS 로 Google 에서 직접 받으므로 서명(JWKS) 검증은 생략하고 iss·aud 만 확인한다(§14.5).
 */
async function exchangeCode(url: URL, env: Env, gcode: string): Promise<GoogleClaims | null> {
  const tokenRes = await fetch(GOOGLE_TOKEN_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      code: gcode,
      client_id: env.GOOGLE_CLIENT_ID!,
      client_secret: env.GOOGLE_CLIENT_SECRET!,
      redirect_uri: `${url.origin}/auth/callback`,
    }),
  });
  const token = (await tokenRes.json().catch(() => null)) as { id_token?: string } | null;
  const idToken = token?.id_token;
  if (!tokenRes.ok || !idToken) return null;

  const claims = parseIdToken(idToken);
  if (!claims || claims.aud !== env.GOOGLE_CLIENT_ID || !/^(https:\/\/)?accounts\.google\.com$/.test(claims.iss)) {
    return null;
  }
  return claims;
}

/** GET /auth/callback — Google 리다이렉트 수신 → id_token 검증 → 연동 확인 페이지(웹 로그인은 세션 발급). */
export async function handleAuthCallback(request: Request, url: URL, env: Env): Promise<Response> {
  if (url.searchParams.get('error')) return errorPage('Google 로그인이 취소되었습니다.');
  if (!env.GOOGLE_CLIENT_ID || !env.GOOGLE_CLIENT_SECRET) return errorPage('서버에 Google 로그인이 아직 설정되지 않았습니다.');

  const state = url.searchParams.get('state') ?? '';
  // 두 플로우가 같은 redirect_uri 를 쓴다(GCP 콘솔에 하나만 등록돼 있으므로) — state 접두사로 가른다.
  //   'web.<code>.<nonce>' = 브라우저 로그인,  '<code>.<nonce>' = CLI 연동(§14.3).
  if (state.startsWith(`${WEB_STATE_PREFIX}.`)) return handleWebCallback(request, url, env, state);

  const [code, nonce] = state.split('.');
  const rec = await loadRecord(env, code);
  if (!rec || rec.status !== 'pending' || !nonce || rec.nonce !== nonce) {
    return errorPage('링크가 만료되었거나 요청이 올바르지 않습니다.');
  }
  const gcode = url.searchParams.get('code');
  if (!gcode) return errorPage('Google 응답이 올바르지 않습니다.');

  const claims = await exchangeCode(url, env, gcode);
  if (!claims) return errorPage('Google 인증에 실패했습니다.');

  // 즉시 연동하지 않고 확인 페이지를 거친다 — 남의 링크를 눌러 내 Google 이 엉뚱한 계정에
  // 붙는 것(link-jacking, §14.6)을 사용자가 눈으로 확인하고 막을 수 있게.
  const confirmToken = randomToken();
  await saveRecord(
    env,
    code,
    { ...rec, status: 'awaiting_confirm', googleSub: claims.sub, email: claims.email ?? null, confirmToken },
    PENDING_TTL_S,
  );

  const row = await env.DB.prepare('SELECT nickname FROM users WHERE user_id = ?')
    .bind(rec.userId)
    .first<{ nickname: string | null }>();
  const nick = displayNickname(row?.nickname ?? null, rec.userId);
  return page(
    '계정 연동 확인',
    `<h1>계정 연동 확인</h1>
     <p>Open Code War 계정 <b>${escapeHtml(nick)}</b> 에<br>Google 계정 <b>${escapeHtml(claims.email ?? claims.sub)}</b> 을(를) 연동합니다.</p>
     <p>본인이 방금 터미널에서 <code>/ocw signup</code> 을 실행한 게 아니라면 이 창을 닫으세요.</p>
     <form method="post" action="/auth/confirm">
       <input type="hidden" name="code" value="${escapeHtml(code)}">
       <input type="hidden" name="token" value="${escapeHtml(confirmToken)}">
       <button type="submit">연동하기</button>
     </form>`,
  );
}

interface GoogleClaims {
  iss: string;
  aud: string;
  sub: string;
  email?: string;
}

function parseIdToken(idToken: string): GoogleClaims | null {
  try {
    const payload = idToken.split('.')[1];
    const jsonStr = atob(payload.replace(/-/g, '+').replace(/_/g, '/'));
    const claims = JSON.parse(jsonStr);
    return typeof claims?.iss === 'string' && typeof claims?.aud === 'string' && typeof claims?.sub === 'string'
      ? claims
      : null;
  } catch {
    return null;
  }
}

/** POST /auth/confirm — 확인 페이지 제출. 실제 연동/병합을 수행한다. */
export async function handleAuthConfirm(request: Request, env: Env): Promise<Response> {
  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return errorPage('요청이 올바르지 않습니다.');
  }
  const code = String(form.get('code') ?? '');
  const token = String(form.get('token') ?? '');
  const rec = await loadRecord(env, code);
  if (!rec || rec.status !== 'awaiting_confirm' || !rec.confirmToken || rec.confirmToken !== token || !rec.googleSub) {
    return errorPage('링크가 만료되었거나 이미 사용되었습니다.');
  }

  const existing = await env.DB.prepare('SELECT account_id, user_id FROM accounts WHERE google_sub = ?')
    .bind(rec.googleSub)
    .first<{ account_id: string; user_id: string }>();

  let canonicalUserId = rec.userId;
  let firstSignup = false;
  let merged: { prompts: number; chars: number } | null = null;

  if (!existing) {
    // 첫 가입 — 현재 userId 가 그대로 canonical. 데이터 이동 없음(§14.4).
    firstSignup = true;
    await env.DB.batch([
      env.DB.prepare('INSERT OR IGNORE INTO users (user_id, public_id, created_at) VALUES (?, ?, ?)').bind(
        rec.userId,
        newPublicId(),
        Date.now(),
      ),
      env.DB.prepare('INSERT INTO accounts (account_id, google_sub, email, user_id, created_at) VALUES (?, ?, ?, ?, ?)').bind(
        'acc_' + randomToken(),
        rec.googleSub,
        rec.email ?? null,
        rec.userId,
        Date.now(),
      ),
    ]);
  } else if (existing.user_id === rec.userId) {
    // 같은 기기 재연동 — 아무것도 안 함.
    await env.DB.prepare('UPDATE accounts SET email = ? WHERE account_id = ?').bind(rec.email ?? null, existing.account_id).run();
  } else {
    // 기존 계정으로 재로그인(다른 기기/재설치) — canonical 로 옮겨 타고 이 기기 사용량을 병합.
    canonicalUserId = existing.user_id;
    merged = await mergeUserData(env, rec.userId, canonicalUserId);
    await env.DB.prepare('UPDATE accounts SET email = ? WHERE account_id = ?').bind(rec.email ?? null, existing.account_id).run();
  }

  await saveRecord(
    env,
    code,
    { ...rec, status: 'done', confirmToken: undefined, canonicalUserId, firstSignup, merged },
    DONE_TTL_S,
  );
  return page(
    '연동 완료',
    `<h1>✓ 연동 완료</h1>
     <p><b>${escapeHtml(rec.email ?? '')}</b> 계정이 연동되었습니다.</p>
     <p>터미널로 돌아가 아무 <code>/ocw</code> 명령이나 실행하면 반영됩니다 (예: <code>/ocw status</code>).</p>`,
  );
}

/** POST /account {userId, emailPublic} — 연동 이메일 공개 여부(옵트인, 기본 비공개). Google 연동 계정만. */
export async function handleAccountUpdate(request: Request, env: Env): Promise<Response> {
  const body = await readJson(request);
  if (!body || !isValidUserId(body.userId)) return json({ error: 'invalid_userId' }, 400);
  return setEmailPublic(env, body.userId, body.emailPublic);
}

/** 이메일 공개 여부 갱신 본체(주체 확인은 호출자 몫 — CLI 는 비밀 userId, 웹은 세션). */
export async function setEmailPublic(env: Env, userId: string, emailPublic: unknown): Promise<Response> {
  if (typeof emailPublic !== 'boolean') return json({ error: 'invalid_emailPublic' }, 400);

  const r = await env.DB.prepare('UPDATE accounts SET email_public = ? WHERE user_id = ?')
    .bind(emailPublic ? 1 : 0, userId)
    .run();
  if (!r.meta.changes) return json({ error: 'not_linked' }, 404);
  return json({ ok: true, emailPublic });
}

// ── 웹 로그인/회원가입 (DESIGN.md §14.9) ─────────────────────────────────────
//
// CLI 연동(§14.3)과 목적이 다르다. 저기는 "이미 있는 익명 userId 에 Google 을 붙이는" 플로우라
// link-jacking 확인 페이지가 필요했지만, 여기는 브라우저에서 시작해 브라우저에서 끝나는 평범한
// 로그인이다 — 붙일 대상(남의 userId)이 애초에 없으므로 확인 단계가 없다.

/** 웹 로그인 state 접두사. CLI 연동 state('<code>.<nonce>')와 구분하는 유일한 표식. */
const WEB_STATE_PREFIX = 'web';
/** 로그인 왕복(구글 동의 화면 체류) 유효기간(초). */
const WEB_LOGIN_TTL_S = 600;

interface WebLoginRecord {
  nonce: string;
  /** 로그인 후 돌아갈 우리 사이트 내부 경로. */
  next: string;
  createdAt: number;
}

function webKey(code: string): string {
  return `authweb:${code}`;
}

/**
 * 리다이렉트 목적지를 우리 오리진 내부 경로로 제한한다(open redirect 방지).
 * '//evil.com' 과 '/\evil.com' 은 브라우저가 스킴상대 URL 로 읽으므로 함께 막는다.
 */
function safeNext(raw: string | null): string {
  if (!raw || !raw.startsWith('/') || raw.startsWith('//') || raw.startsWith('/\\')) return '/';
  return raw;
}

/** 유저의 공개 프로필 경로 — 등록 닉네임이 있으면 닉네임, 없으면 public_id slug. */
function profilePathFor(nickname: string | null, publicId: string | null): string {
  if (nickname) return `/u/${encodeURIComponent(nickname)}`;
  if (publicId) return `/u/${publicId}`;
  return '/';
}

/** GET /auth/login?next=/u/foo — 브라우저 로그인 시작. 302 로 Google 동의 화면으로 보낸다. */
export async function handleWebLogin(url: URL, env: Env): Promise<Response> {
  if (!env.GOOGLE_CLIENT_ID) return errorPage('서버에 Google 로그인이 아직 설정되지 않았습니다.');

  const code = randomToken();
  const nonce = randomToken();
  const rec: WebLoginRecord = { nonce, next: safeNext(url.searchParams.get('next')), createdAt: Date.now() };
  await env.KV.put(webKey(code), JSON.stringify(rec), { expirationTtl: WEB_LOGIN_TTL_S });

  const auth = new URL(GOOGLE_AUTH_URL);
  auth.searchParams.set('client_id', env.GOOGLE_CLIENT_ID);
  auth.searchParams.set('redirect_uri', `${url.origin}/auth/callback`);
  auth.searchParams.set('response_type', 'code');
  auth.searchParams.set('scope', 'openid email');
  auth.searchParams.set('state', `${WEB_STATE_PREFIX}.${code}.${nonce}`);
  auth.searchParams.set('prompt', 'select_account');
  return Response.redirect(auth.toString(), 302);
}

/** 웹 로그인 콜백 — 계정 조회(없으면 생성) → 세션 쿠키 → 원래 보던 경로로 302. */
async function handleWebCallback(request: Request, url: URL, env: Env, state: string): Promise<Response> {
  const [, code, nonce] = state.split('.');
  if (!code || !TOKEN_RE.test(code) || !nonce) return errorPage('요청이 올바르지 않습니다.');
  const rec = await env.KV.get<WebLoginRecord>(webKey(code), 'json');
  if (!rec || rec.nonce !== nonce) return errorPage('로그인 링크가 만료되었거나 요청이 올바르지 않습니다.');
  await env.KV.delete(webKey(code)); // 1회용 — 재생 공격 차단

  const gcode = url.searchParams.get('code');
  if (!gcode) return errorPage('Google 응답이 올바르지 않습니다.');
  const claims = await exchangeCode(url, env, gcode);
  if (!claims) return errorPage('Google 인증에 실패했습니다.');

  const existing = await env.DB.prepare('SELECT account_id, user_id FROM accounts WHERE google_sub = ?')
    .bind(claims.sub)
    .first<{ account_id: string; user_id: string }>();

  let userId: string;
  let firstSignup = false;
  if (existing) {
    userId = existing.user_id;
    // 구글 쪽에서 이메일이 바뀌었을 수 있다 — 로그인마다 최신값으로 맞춘다(CLI 연동과 동일).
    await env.DB.prepare('UPDATE accounts SET email = ? WHERE account_id = ?')
      .bind(claims.email ?? null, existing.account_id)
      .run();
  } else {
    // 웹 단독 가입 — CLI 를 깔지 않은 사람도 여기서 계정을 만든다. 기록은 0에서 시작하고,
    // 나중에 그 사람이 /ocw signup 을 하면 기존 병합 로직(§14.4)이 기기 사용량을 이 userId 로 합친다.
    firstSignup = true;
    userId = newWebUserId();
    // 국가·타임존을 가입 시점에 남긴다. /track 은 매 이벤트마다 채우지만 이 사람은 아직 이벤트가
    // 없다 — 안 넣으면 리더보드에 국기 없이 서고, 상세 페이지가 UTC 로 떨어진다.
    const cfTz = request.cf?.timezone;
    await env.DB.batch([
      env.DB.prepare(
        'INSERT INTO users (user_id, public_id, country, timezone, created_at) VALUES (?, ?, ?, ?, ?)',
      ).bind(
        userId,
        newPublicId(),
        request.cf?.country ?? null,
        isValidTimezone(cfTz) ? cfTz : null,
        Date.now(),
      ),
      env.DB.prepare(
        'INSERT INTO accounts (account_id, google_sub, email, user_id, created_at) VALUES (?, ?, ?, ?, ?)',
      ).bind('acc_' + randomToken(), claims.sub, claims.email ?? null, userId, Date.now()),
    ]);
  }

  const token = await createSession(env, { userId, googleSub: claims.sub, email: claims.email ?? null });

  // 갓 가입한 사람은 돌아갈 곳이 없다 — 자기 프로필로 보내 닉네임부터 정하게 한다(?setup=1).
  let dest = rec.next;
  if (firstSignup) {
    const row = await env.DB.prepare('SELECT nickname, public_id FROM users WHERE user_id = ?')
      .bind(userId)
      .first<{ nickname: string | null; public_id: string | null }>();
    dest = profilePathFor(row?.nickname ?? null, row?.public_id ?? null) + '?setup=1';
  }

  return new Response(null, {
    status: 302,
    headers: { Location: new URL(dest, url).toString(), 'Set-Cookie': sessionCookie(token) },
  });
}

/** POST /auth/logout — 세션 파기 + 쿠키 삭제. */
export async function handleWebLogout(request: Request, env: Env): Promise<Response> {
  await destroySession(request, env);
  return json({ ok: true }, 200, { 'Set-Cookie': clearSessionCookie() });
}

/** GET /auth/status?code&userId — CLI 가 다음 실행 때 결과를 회수한다(pendingLinkCode 패턴). */
export async function handleAuthStatus(url: URL, env: Env): Promise<Response> {
  const userId = url.searchParams.get('userId');
  if (!isValidUserId(userId)) return json({ error: 'invalid_userId' }, 400);
  const rec = await loadRecord(env, url.searchParams.get('code'));
  if (!rec) return json({ status: 'expired' });
  if (rec.userId !== userId) return json({ error: 'forbidden' }, 403);

  if (rec.status !== 'done') return json({ status: 'pending' });

  // 브라우저 완료 후 이 기기가 옛 userId 로 계속 track 했을 수 있다 — 회수 시점에 잔여분을 한 번 더
  // 병합해 유실을 막는다(멱등). 첫 병합 결과(rec.merged)에 합산해서 알린다.
  let merged = rec.merged ?? null;
  if (rec.canonicalUserId && rec.canonicalUserId !== rec.userId) {
    const extra = await mergeUserData(env, rec.userId, rec.canonicalUserId);
    if (extra.prompts || extra.chars) {
      merged = { prompts: (merged?.prompts ?? 0) + extra.prompts, chars: (merged?.chars ?? 0) + extra.chars };
      await saveRecord(env, url.searchParams.get('code')!, { ...rec, merged }, DONE_TTL_S);
    }
  }
  return json({
    status: 'done',
    canonicalUserId: rec.canonicalUserId ?? rec.userId,
    email: rec.email ?? null,
    firstSignup: rec.firstSignup ?? false,
    merged,
  });
}

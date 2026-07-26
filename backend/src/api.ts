// 세션(쿠키) 기반 웹 API — DESIGN.md §14.9.
//
// /profile, /register, /account 와 하는 일은 같지만 **주체를 body 가 아니라 쿠키에서** 얻는다.
// 그래서 여기 어떤 핸들러도 body.userId 를 읽지 않는다. 브라우저가 userId 를 알 필요도, 알 수도 없다.

import type { Env } from './types';
import { json, readJson } from './http';
import { getSession, isSameOrigin, type SessionRecord } from './session';
import { setEmailPublic } from './auth';
import { setNickname, updateProfile } from './handlers';
import { displayNickname } from './nickname';

type Guarded = { sess: SessionRecord & { token: string }; error?: undefined } | { error: Response; sess?: undefined };

/** 세션 + CSRF 관문. 통과하면 {sess}, 막히면 {error: Response}. */
async function requireSession(request: Request, url: URL, env: Env): Promise<Guarded> {
  // 상태 변경 요청은 Origin 이 우리 것일 때만 받는다(SameSite=Lax 위의 2차 CSRF 방어).
  if (request.method !== 'GET' && !isSameOrigin(request, url)) {
    return { error: json({ error: 'bad_origin' }, 403) };
  }
  const sess = await getSession(request, env);
  if (!sess) return { error: json({ error: 'unauthorized' }, 401) };
  return { sess };
}

/**
 * GET /api/session — 지금 브라우저가 누구인지. 로그아웃 상태면 {loggedIn:false}.
 * userId 는 절대 넣지 않는다 — 웹이 자기 프로필을 식별할 때 쓰는 값은 공개 slug(publicId)다.
 */
export async function handleApiSession(request: Request, env: Env): Promise<Response> {
  const sess = await getSession(request, env);
  if (!sess) return json({ loggedIn: false });

  const row = await env.DB.prepare(
    `SELECT u.nickname, u.public_id, a.email, a.email_public
       FROM users u LEFT JOIN accounts a ON a.user_id = u.user_id
      WHERE u.user_id = ?`,
  )
    .bind(sess.userId)
    .first<{ nickname: string | null; public_id: string | null; email: string | null; email_public: number | null }>();

  // 세션은 살아있는데 유저 행이 없다 = /delete 로 계정을 지운 뒤 남은 쿠키. 로그아웃으로 취급한다.
  if (!row) return json({ loggedIn: false });

  return json({
    loggedIn: true,
    nickname: displayNickname(row.nickname, sess.userId),
    /** 닉네임을 직접 등록했는지. false 면 웹이 "닉네임을 정하세요" 안내를 띄운다. */
    registered: !!row.nickname,
    publicId: row.public_id ?? null,
    email: sess.email ?? row.email ?? null,
    emailPublic: !!row.email_public,
  });
}

/** POST /api/profile — 세션 주인의 프로필 필드 갱신. body 는 /profile 과 동일(단 userId 없음). */
export async function handleApiProfile(request: Request, url: URL, env: Env): Promise<Response> {
  const r = await requireSession(request, url, env);
  if (r.error) return r.error;
  const body = await readJson(request);
  if (!body) return json({ error: 'invalid_body' }, 400);
  return updateProfile(env, r.sess.userId, body);
}

/** POST /api/nickname {nickname} — 세션 주인의 닉네임 등록/변경. */
export async function handleApiNickname(request: Request, url: URL, env: Env): Promise<Response> {
  const r = await requireSession(request, url, env);
  if (r.error) return r.error;
  const body = await readJson(request);
  if (!body) return json({ error: 'invalid_body' }, 400);
  return setNickname(env, r.sess.userId, body.nickname);
}

/** POST /api/account {emailPublic} — 연동 이메일 공개 여부(옵트인). */
export async function handleApiAccount(request: Request, url: URL, env: Env): Promise<Response> {
  const r = await requireSession(request, url, env);
  if (r.error) return r.error;
  const body = await readJson(request);
  if (!body) return json({ error: 'invalid_body' }, 400);
  return setEmailPublic(env, r.sess.userId, body.emailPublic);
}

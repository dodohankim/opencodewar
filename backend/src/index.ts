import type { Env } from './types';
import { CORS_HEADERS, json } from './http';
import {
  handleDelete,
  handleLeaderboard,
  handleMe,
  handleProfile,
  handleRegister,
  handleTrack,
  handleUser,
  handleZones,
} from './handlers';
import { buildSnapshot, putSnapshot } from './snapshot';
import { handleOgImage, handleProfilePage, nicknameFromPath, ogImageIdFromPath, profilePath } from './og';
import { isValidNickname } from './validate';

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    const { pathname } = url;

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }

    try {
      // 루트는 run_worker_first 로 Worker가 먼저 받는다.
      // 구 공유 링크(/?user=)는 정식 주소(/u/<nick>)로 301 — 이미 뿌려진 링크를 살린다.
      if (pathname === '/') {
        const legacy = url.searchParams.get('user');
        if (isValidNickname(legacy)) {
          // 같은 오리진으로 보낸다(로컬 dev·프리뷰 URL 에서도 동작).
          return Response.redirect(new URL(profilePath(legacy.trim()), url).toString(), 301);
        }
        return await handleProfilePage(request, url, env, null);
      }
      // /og/<public_id>.png — 유저별 공유 이미지(R2, 미스 시 공통 og.png 폴백).
      const ogId = ogImageIdFromPath(pathname);
      if (ogId !== null && request.method === 'GET') {
        return await handleOgImage(request, url, env, ogId);
      }
      // /u/<nickname> — 프로필 페이지(에셋에 없는 경로라 Worker 폴백으로 도달).
      const pathNick = nicknameFromPath(pathname);
      if (pathNick !== null && request.method === 'GET') {
        return await handleProfilePage(request, url, env, pathNick);
      }
      if (pathname === '/health') {
        return json({ ok: true, service: 'open-code-war-api', ts: Date.now() });
      }
      if (pathname === '/track' && request.method === 'POST') {
        return await handleTrack(request, env);
      }
      if (pathname === '/register' && request.method === 'POST') {
        return await handleRegister(request, env);
      }
      if (pathname === '/profile' && request.method === 'POST') {
        return await handleProfile(request, env);
      }
      if (pathname === '/delete' && request.method === 'POST') {
        return await handleDelete(request, env);
      }
      if (pathname === '/leaderboard' && request.method === 'GET') {
        return await handleLeaderboard(url, env, ctx);
      }
      if (pathname === '/zones' && request.method === 'GET') {
        return await handleZones(env);
      }
      if (pathname === '/me' && request.method === 'GET') {
        return await handleMe(url, env);
      }
      if (pathname === '/user' && request.method === 'GET') {
        return await handleUser(url, env);
      }
      return json({ error: 'not_found' }, 404);
    } catch (err) {
      console.error(
        JSON.stringify({ level: 'error', msg: 'unhandled', method: request.method, path: pathname, err: String(err) }),
      );
      return json({ error: 'internal_error' }, 500);
    }
  },

  // Cron Trigger: 리더보드 스냅샷을 주기적으로 재빌드 (wrangler.jsonc triggers.crons)
  async scheduled(_event: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(
      (async () => {
        try {
          const snap = await buildSnapshot(env);
          await putSnapshot(env, snap);
        } catch (err) {
          console.error(JSON.stringify({ level: 'error', msg: 'snapshot_cron_failed', err: String(err) }));
        }
      })(),
    );
  },
} satisfies ExportedHandler<Env>;

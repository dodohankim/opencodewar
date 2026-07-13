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
} from './handlers';
import { buildSnapshot, putSnapshot } from './snapshot';

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    const { pathname } = url;

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }

    try {
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

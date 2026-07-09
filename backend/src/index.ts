import type { Env } from './types';
import { CORS_HEADERS, json } from './http';
import { handleLeaderboard, handleMe, handleRegister, handleTrack } from './handlers';

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
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
      if (pathname === '/leaderboard' && request.method === 'GET') {
        return await handleLeaderboard(url, env);
      }
      if (pathname === '/me' && request.method === 'GET') {
        return await handleMe(url, env);
      }
      return json({ error: 'not_found' }, 404);
    } catch (err) {
      console.error(
        JSON.stringify({ level: 'error', msg: 'unhandled', method: request.method, path: pathname, err: String(err) }),
      );
      return json({ error: 'internal_error' }, 500);
    }
  },
} satisfies ExportedHandler<Env>;

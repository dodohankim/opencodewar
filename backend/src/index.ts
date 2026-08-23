import type { Env } from './types';
import { CORS_HEADERS, json } from './http';
import {
  handleBriefing,
  handleDelete,
  handleLeaderboard,
  handleMe,
  handleProfile,
  handleRegister,
  handleRandom,
  handleTrack,
  handleUser,
  handleUserHours,
  handleZones,
} from './handlers';
import { buildSnapshot, putSnapshot } from './snapshot';
import {
  handleAccountUpdate,
  handleAuthCallback,
  handleAuthConfirm,
  handleAuthLink,
  handleAuthStart,
  handleAuthStatus,
  handleWebLogin,
  handleWebLogout,
} from './auth';
import { handleApiAccount, handleApiNickname, handleApiProfile, handleApiSession } from './api';
import {
  handleBattleGet,
  handleBattleJoin,
  handleBattleLeave,
  handleBattleMine,
  handleBattleNew,
  handleBattlePage,
} from './battle';
import {
  handleOgImage,
  handleProfilePage,
  nicknameFromPath,
  ogImageIdFromPath,
  profilePath,
  visitorCountry,
  withVisitorCountry,
} from './og';
import { isValidNickname } from './validate';
import { handleAgentDocs, markdownForPage, notFound, wantsMarkdownPage, withVaryAccept } from './agents';

/** 페이지·이미지 라우트는 GET/HEAD 둘 다 받는다 — HEAD 로 찔러보는 크롤러·링크체커가 404 를 받지 않도록. */
const isPageRead = (method: string): boolean => method === 'GET' || method === 'HEAD';

/** 운영 도메인. 평문 http 로 들어온 요청을 https 로 올릴 때만 쓴다(로컬 dev·프리뷰는 제외). */
const SITE_HOST = 'opencodewar.dev';

/** Worker 를 먼저 타는 정적 문서 페이지(wrangler.jsonc assets.run_worker_first 와 같은 목록). */
const TRUST_PAGES = new Set(['/privacy', '/privacy.html', '/about', '/about.html', '/contact', '/contact.html']);

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    const { pathname } = url;

    // http://opencodewar.dev/... → https 301. 안 하면 크롤러가 두 스킴을 각각 긁어
    // Search Console 에 “적절한 표준 태그가 포함된 대체 페이지”로 쌓인다(canonical 로 막고는 있지만).
    if (url.protocol === 'http:' && url.hostname === SITE_HOST) {
      url.protocol = 'https:';
      return Response.redirect(url.toString(), 301);
    }

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }

    try {
      // 에이전트 표면(§24): Accept: text/markdown 협상 — HTML 페이지의 마크다운 판을 같은 URL 로.
      if (wantsMarkdownPage(pathname, request)) {
        const md = markdownForPage(pathname);
        if (md) return md;
      }
      // /llms.txt · /llms-full.txt · /docs/api · /openapi.json
      const agentDoc = handleAgentDocs(pathname, request);
      if (agentDoc) return agentDoc;

      // 루트는 run_worker_first 로 Worker가 먼저 받는다.
      // 구 공유 링크(/?user=)는 정식 주소(/u/<nick>)로 301 — 이미 뿌려진 링크를 살린다.
      if (pathname === '/') {
        const legacy = url.searchParams.get('user');
        if (isValidNickname(legacy)) {
          // 같은 오리진으로 보낸다(로컬 dev·프리뷰 URL 에서도 동작).
          return Response.redirect(new URL(profilePath(legacy.trim()), url).toString(), 301);
        }
        return withVaryAccept(await handleProfilePage(request, url, env, null));
      }
      // /privacy — 정적 페이지지만 방문자 국가를 심어야 해서 Worker 를 먼저 태운다
      // (wrangler.jsonc 의 assets.run_worker_first). 직접 들어와도 기본 언어가 맞도록.
      // /about · /contact 도 같은 경로(정적 HTML + 국가 주입 + Vary: Accept — 마크다운 판이 있으므로).
      if (TRUST_PAGES.has(pathname) && isPageRead(request.method)) {
        const res = await env.ASSETS.fetch(request);
        return withVaryAccept(withVisitorCountry(res, visitorCountry(request)));
      }
      // /og/<public_id>.png — 유저별 공유 이미지(R2, 미스 시 공통 og.png 폴백).
      const ogId = ogImageIdFromPath(pathname);
      if (ogId !== null && isPageRead(request.method)) {
        return await handleOgImage(request, url, env, ogId, ctx);
      }
      // /u/<nickname> — 프로필 페이지(에셋에 없는 경로라 Worker 폴백으로 도달).
      const pathNick = nicknameFromPath(pathname);
      if (pathNick !== null && isPageRead(request.method)) {
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
      // 세션 브리핑(§19) — 플러그인이 세션 시작 시 1회만 호출한다.
      if (pathname === '/briefing' && request.method === 'GET') {
        return await handleBriefing(url, env, ctx);
      }
      // 교전(§22) — 최대 10명 개인전.
      if (pathname === '/battle/new' && request.method === 'POST') {
        return await handleBattleNew(request, env);
      }
      if (pathname === '/battle/join' && request.method === 'POST') {
        return await handleBattleJoin(request, env);
      }
      if (pathname === '/battle/leave' && request.method === 'POST') {
        return await handleBattleLeave(request, env);
      }
      if (pathname === '/battle/mine' && request.method === 'GET') {
        return await handleBattleMine(url, env);
      }
      if (pathname === '/battle' && request.method === 'GET') {
        return await handleBattleGet(url, env);
      }
      // /b/<code> — 교전 페이지(SPA 셸 + OG 메타 재작성 — 초대 링크 미리보기가 참전 전환의 첫 화면).
      const bm = /^\/b\/([23456789abcdefghjkmnpqrstuvwxyz]{6})$/.exec(pathname);
      if (bm && isPageRead(request.method)) {
        return await handleBattlePage(request, url, env, bm[1]);
      }
      // Google 계정 연동 (DESIGN.md §14)
      if (pathname === '/auth/start' && request.method === 'POST') {
        return await handleAuthStart(request, env);
      }
      if (pathname.startsWith('/auth/link/') && request.method === 'GET') {
        return await handleAuthLink(url, env, pathname.slice('/auth/link/'.length));
      }
      if (pathname === '/auth/callback' && request.method === 'GET') {
        return await handleAuthCallback(request, url, env);
      }
      if (pathname === '/auth/confirm' && request.method === 'POST') {
        return await handleAuthConfirm(request, env);
      }
      if (pathname === '/auth/status' && request.method === 'GET') {
        return await handleAuthStatus(url, env);
      }
      if (pathname === '/account' && request.method === 'POST') {
        return await handleAccountUpdate(request, env);
      }
      // 웹 로그인/회원가입 + 세션 API (DESIGN.md §14.9). /auth/callback 은 위 CLI 라우트와 공유한다.
      if (pathname === '/auth/login' && isPageRead(request.method)) {
        return await handleWebLogin(url, env);
      }
      if (pathname === '/auth/logout' && request.method === 'POST') {
        return await handleWebLogout(request, env);
      }
      if (pathname === '/api/session' && request.method === 'GET') {
        return await handleApiSession(request, env);
      }
      if (pathname === '/api/profile' && request.method === 'POST') {
        return await handleApiProfile(request, url, env);
      }
      if (pathname === '/api/nickname' && request.method === 'POST') {
        return await handleApiNickname(request, url, env);
      }
      if (pathname === '/api/account' && request.method === 'POST') {
        return await handleApiAccount(request, url, env);
      }
      if (pathname === '/user/hours' && request.method === 'GET') {
        return await handleUserHours(url, env, request);
      }
      if (pathname === '/user' && request.method === 'GET') {
        return await handleUser(url, env, request);
      }
      if (pathname === '/random' && request.method === 'GET') {
        return await handleRandom(env);
      }
      // 없는 경로: 진짜 404 + 마크다운 사이트맵(JSON 을 원하는 클라이언트엔 JSON).
      return notFound(request, pathname);
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

// shipping 프로젝트 파비콘 프록시 (DESIGN.md §26)
//
// 왜 구글/DDG 파비콘 API 를 안 쓰나: 그건 방문자 브라우저가 제3자에 직접 요청하게 만든다.
// 누가 우리 보드를 보고 있는지가 그쪽에 남는다 — "내용은 수집하지 않는다"를 1번 규칙으로 파는
// 서비스가 할 일이 아니다. 그래서 우리가 한 번 받아서 KV 에 굽고, 방문자는 우리 도메인만 때린다.
//
// 실측(2026-08-26): /favicon.ico 한 방으로는 안 된다. 등록된 두 프로젝트 모두 404 였고
// (opencodewar.dev → /favicon.svg, gaemilab.com → /icon.png) HTML 의 <link rel="icon"> 을 읽어야 했다.

import type { Env } from './types';

/** 우리 도메인. 자기 자신을 fetch 하면 Worker 가 자기 subrequest 를 도는 꼴이라 막힌다 — ASSETS 로 직접 읽는다. */
const SITE_HOST = 'opencodewar.dev';
const SITE_ICON_PATH = '/favicon.svg';

const KEY_PREFIX = 'icon:v1:';
const TTL_OK = 30 * 24 * 60 * 60; // 30일
const TTL_FAIL = 24 * 60 * 60; // 실패는 하루만 기억 — 상대가 고치면 다음 날 다시 시도
const MAX_BYTES = 100 * 1024;
const FETCH_TIMEOUT_MS = 3000;
const OK_TYPES = ['image/png', 'image/x-icon', 'image/vnd.microsoft.icon', 'image/svg+xml', 'image/jpeg', 'image/webp', 'image/gif'];

/** /icon/<host>.png 에서 호스트를 뽑는다. 소문자 도메인만 통과(포트·경로·자격증명 불가). */
export function iconHostFromPath(pathname: string): string | null {
  const m = /^\/icon\/([a-z0-9.-]{3,253})\.png$/.exec(pathname);
  if (!m) return null;
  const host = m[1];
  if (host.startsWith('-') || host.endsWith('-') || host.startsWith('.') || host.endsWith('.')) return null;
  if (host.includes('..')) return null;
  if (!host.includes('.')) return null; // 단일 라벨(localhost 등) 차단
  return host;
}

/**
 * HTML 에서 아이콘 후보를 뽑는다(HTMLRewriter — 엣지에서 스트리밍 파싱이라 싸다).
 * sizes 가 큰 것을 선호하되, 32px 이상이면 충분하다. rel 은 icon / shortcut icon / apple-touch-icon.
 */
async function iconLinksFrom(res: Response, base: URL): Promise<string[]> {
  const found: Array<{ href: string; score: number }> = [];
  const rewriter = new HTMLRewriter().on('link', {
    element(el) {
      const rel = (el.getAttribute('rel') || '').toLowerCase();
      if (!/(^|\s)(icon|shortcut icon|apple-touch-icon)(\s|$)/.test(rel)) return;
      const href = el.getAttribute('href');
      if (!href) return;
      const sizes = el.getAttribute('sizes') || '';
      const px = Number(/(\d+)x\d+/.exec(sizes)?.[1] ?? 0);
      // 너무 큰 원본은 굳이 — 화면엔 32px 로 그린다. 64~180 을 가장 높게 친다.
      const score = px === 0 ? 40 : px >= 64 && px <= 256 ? 100 : px >= 32 ? 80 : 20;
      try {
        found.push({ href: new URL(href, base).toString(), score });
      } catch {
        /* 상대경로 파싱 실패는 무시 */
      }
    },
  });
  await rewriter.transform(res).arrayBuffer();
  return found.sort((a, b) => b.score - a.score).map((f) => f.href);
}

function timeout(ms: number): AbortSignal {
  const c = new AbortController();
  setTimeout(() => c.abort(), ms);
  return c.signal;
}

async function fetchIconBytes(url: string): Promise<{ body: ArrayBuffer; ct: string } | null> {
  let res: Response;
  try {
    res = await fetch(url, { redirect: 'follow', signal: timeout(FETCH_TIMEOUT_MS) });
  } catch {
    return null;
  }
  if (!res.ok) return null;
  const ct = (res.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
  if (!OK_TYPES.includes(ct)) return null;
  const len = Number(res.headers.get('content-length') || 0);
  if (len > MAX_BYTES) return null;
  const body = await res.arrayBuffer();
  if (body.byteLength === 0 || body.byteLength > MAX_BYTES) return null;
  return { body, ct };
}

/** 그 호스트가 실제로 누군가의 shipping 에 등록돼 있나 — 임의 이미지 프록시로 쓰이지 않게. */
async function isRegisteredHost(env: Env, host: string): Promise<boolean> {
  const row = await env.DB.prepare(`SELECT 1 AS ok FROM users WHERE projects LIKE ? LIMIT 1`)
    .bind(`%//${host}%`)
    .first<{ ok: number }>();
  return row != null;
}

/**
 * GET /icon/<host>.png — shipping 도메인의 파비콘.
 * KV 히트면 그대로, 미스면 그때 한 번 원본을 받아 굽는다. 실패는 404 —
 * 웹이 첫 글자 모노그램으로 폴백한다(줄이 무너지지 않게).
 */
export async function handleIcon(request: Request, env: Env, host: string, ctx?: ExecutionContext): Promise<Response> {
  // 우리 사이트 아이콘은 정적 에셋에 이미 있다. 네트워크로 나가면 self-subrequest 라 실패한다.
  if (host === SITE_HOST) {
    const res = await env.ASSETS.fetch(new Request(new URL(SITE_ICON_PATH, request.url).toString()));
    if (!res.ok) return notFoundIcon();
    return iconResponse(await res.arrayBuffer(), res.headers.get('content-type') || 'image/svg+xml');
  }

  const key = KEY_PREFIX + host;
  const cached = await env.KV.getWithMetadata<{ ct?: string; fail?: number }>(key, 'arrayBuffer');
  if (cached.value && cached.metadata?.ct) {
    return iconResponse(cached.value, cached.metadata.ct);
  }
  if (cached.metadata?.fail) return notFoundIcon();

  if (!(await isRegisteredHost(env, host))) return notFoundIcon();

  const base = new URL(`https://${host}/`);
  const candidates: string[] = [];
  try {
    const page = await fetch(base.toString(), { redirect: 'follow', signal: timeout(FETCH_TIMEOUT_MS) });
    if (page.ok && (page.headers.get('content-type') || '').includes('text/html')) {
      candidates.push(...(await iconLinksFrom(page, base)));
    }
  } catch {
    /* 페이지를 못 받아도 /favicon.ico 는 시도해 본다 */
  }
  candidates.push(new URL('/favicon.ico', base).toString());

  for (const url of candidates.slice(0, 4)) {
    const got = await fetchIconBytes(url);
    if (!got) continue;
    const write = env.KV.put(key, got.body, { metadata: { ct: got.ct }, expirationTtl: TTL_OK });
    if (ctx) ctx.waitUntil(write);
    else await write;
    return iconResponse(got.body, got.ct);
  }

  const writeFail = env.KV.put(key, '', { metadata: { fail: 1 }, expirationTtl: TTL_FAIL });
  if (ctx) ctx.waitUntil(writeFail);
  else await writeFail;
  return notFoundIcon();
}

function iconResponse(body: ArrayBuffer, ct: string): Response {
  return new Response(body, {
    headers: {
      'Content-Type': ct,
      'Cache-Control': 'public, max-age=86400',
      'Access-Control-Allow-Origin': '*',
    },
  });
}

function notFoundIcon(): Response {
  return new Response(null, { status: 404, headers: { 'Cache-Control': 'public, max-age=3600' } });
}

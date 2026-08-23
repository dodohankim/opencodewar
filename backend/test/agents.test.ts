import { describe, expect, it } from 'vitest';
import {
  ABOUT_MD,
  API_DOC_MD,
  CONTACT_MD,
  LLMS_FULL_TXT,
  LLMS_TXT,
  OPENAPI,
  SITE_MAP,
  handleAgentDocs,
  markdownForPage,
  notFound,
  notFoundMarkdown,
  prefersMarkdown,
  wantsMarkdownPage,
  withVaryAccept,
} from '../src/agents';
import worker from '../src/index';
import type { Env } from '../src/types';

describe('prefersMarkdown — Accept 협상 (acceptmarkdown.com)', () => {
  it('text/markdown 만 있으면 마크다운', () => {
    expect(prefersMarkdown('text/markdown')).toBe(true);
  });

  it('html 보다 q 가 같거나 높으면 마크다운', () => {
    expect(prefersMarkdown('text/markdown, text/html;q=0.9')).toBe(true);
    expect(prefersMarkdown('text/html;q=0.5, text/markdown;q=0.5')).toBe(true);
  });

  it('html 을 더 선호하면 HTML', () => {
    expect(prefersMarkdown('text/html, text/markdown;q=0.8')).toBe(false);
  });

  it('브라우저 기본 Accept(와일드카드)는 HTML 유지', () => {
    expect(prefersMarkdown('text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8')).toBe(false);
    expect(prefersMarkdown('*/*')).toBe(false);
    expect(prefersMarkdown(null)).toBe(false);
  });

  it('q=0 은 거부로 본다', () => {
    expect(prefersMarkdown('text/markdown;q=0')).toBe(false);
  });
});

describe('wantsMarkdownPage — 협상 대상 경로만', () => {
  const md = (path: string, method = 'GET') =>
    new Request(`https://opencodewar.dev${path}`, { method, headers: { Accept: 'text/markdown' } });

  it('/ /about /contact /privacy 는 협상한다', () => {
    for (const p of ['/', '/about', '/contact', '/privacy']) expect(wantsMarkdownPage(p, md(p))).toBe(true);
  });

  it('JSON API·프로필 경로는 협상하지 않는다', () => {
    expect(wantsMarkdownPage('/leaderboard', md('/leaderboard'))).toBe(false);
    expect(wantsMarkdownPage('/u/someone', md('/u/someone'))).toBe(false);
  });

  it('POST 는 협상하지 않는다', () => {
    expect(wantsMarkdownPage('/', md('/', 'POST'))).toBe(false);
  });
});

describe('마크다운 응답 헤더', () => {
  it('Content-Type text/markdown + Vary: Accept', () => {
    const res = markdownForPage('/about')!;
    expect(res.headers.get('Content-Type')).toBe('text/markdown; charset=utf-8');
    expect(res.headers.get('Vary')).toContain('Accept');
  });

  it('withVaryAccept 는 기존 Vary 를 보존하며 Accept 를 더한다', () => {
    const res = withVaryAccept(new Response('x', { headers: { Vary: 'Cookie' } }));
    const vary = res.headers.get('Vary')!;
    expect(vary).toContain('Cookie');
    expect(vary).toContain('Accept');
    expect(vary.split(',').map((s) => s.trim()).filter((s) => s === 'Accept')).toHaveLength(1);
  });

  it('모든 협상 페이지에 마크다운 판이 있고 H1 으로 시작한다', () => {
    for (const p of ['/', '/about', '/contact', '/privacy']) {
      const res = markdownForPage(p);
      expect(res, p).not.toBeNull();
    }
    for (const doc of [ABOUT_MD, CONTACT_MD, API_DOC_MD, LLMS_TXT]) expect(doc.startsWith('# ')).toBe(true);
  });
});

describe('404 — 진짜 404 + 복구 안내', () => {
  it('기본(curl·크롤러)은 마크다운 본문에 사이트맵 링크', async () => {
    const req = new Request('https://opencodewar.dev/nope');
    const res = notFound(req, '/nope');
    expect(res.status).toBe(404);
    expect(res.headers.get('Content-Type')).toBe('text/markdown; charset=utf-8');
    const body = await res.text();
    expect(body).toContain('# 404');
    expect(body).toContain('https://opencodewar.dev/llms.txt');
    expect(body).toContain('https://opencodewar.dev/sitemap.xml');
    for (const e of SITE_MAP) expect(body).toContain(`https://opencodewar.dev${e.path}`);
  });

  it('Accept: application/json 이면 기존 JSON 계약 유지', async () => {
    const req = new Request('https://opencodewar.dev/nope', { headers: { Accept: 'application/json' } });
    const res = notFound(req, '/nope');
    expect(res.status).toBe(404);
    expect(res.headers.get('Content-Type')).toContain('application/json');
    expect(await res.json()).toMatchObject({ error: 'not_found' });
  });

  it('경로의 위험 문자는 본문에 에코하지 않는다', () => {
    const body = notFoundMarkdown('/<script>alert(1)</script>');
    expect(body).not.toContain('<script>');
    expect(body).toContain('`/scriptalert1/script`');
  });
});

describe('에이전트 문서 경로', () => {
  const get = (p: string) => handleAgentDocs(p, new Request(`https://opencodewar.dev${p}`));

  it('/llms.txt 는 llmstxt.org 형식: H1 → 인용 요약 → H2 섹션 + 링크 목록', () => {
    const res = get('/llms.txt')!;
    expect(res.headers.get('Content-Type')).toBe('text/markdown; charset=utf-8');
    const lines = LLMS_TXT.split('\n');
    expect(lines[0]).toBe('# Open Code War');
    expect(lines[2].startsWith('> ')).toBe(true);
    expect(LLMS_TXT).toMatch(/^## When to use Open Code War$/m);
    expect(LLMS_TXT).toMatch(/^## How an agent should call it$/m);
    expect(LLMS_TXT).toMatch(/^## Docs$/m);
    expect(LLMS_TXT).toMatch(/^## Optional$/m);
    expect(LLMS_TXT).toMatch(/^- \[API reference\]\(https:\/\/opencodewar\.dev\/docs\/api\): /m);
  });

  it('/llms-full.txt 는 요약·소개·API·문의·프라이버시를 모두 담는다', () => {
    expect(get('/llms-full.txt')).not.toBeNull();
    for (const piece of [LLMS_TXT, ABOUT_MD, API_DOC_MD, CONTACT_MD]) expect(LLMS_FULL_TXT).toContain(piece);
  });

  it('/docs/api 마크다운은 공개 엔드포인트를 전부 적는다', () => {
    expect(get('/docs/api')).not.toBeNull();
    expect(get('/docs')).not.toBeNull();
    for (const ep of ['/leaderboard', '/user', '/user/hours', '/zones', '/random', '/battle', '/health']) {
      expect(API_DOC_MD).toContain(`GET ${ep}`);
    }
  });

  it('/openapi.json 은 OpenAPI 3.1 이고 문서의 읽기 경로와 일치한다', async () => {
    const res = get('/openapi.json')!;
    expect(res.headers.get('Content-Type')).toContain('application/json');
    const spec = (await res.json()) as typeof OPENAPI & { paths: Record<string, unknown> };
    expect(spec.openapi).toBe('3.1.0');
    expect(Object.keys(spec.paths).sort()).toEqual(
      ['/battle', '/health', '/leaderboard', '/random', '/user', '/user/hours', '/zones'].sort(),
    );
  });

  it('모르는 경로·비 GET 은 null', () => {
    expect(get('/leaderboard')).toBeNull();
    expect(handleAgentDocs('/llms.txt', new Request('https://opencodewar.dev/llms.txt', { method: 'POST' }))).toBeNull();
  });
});

// ---- 라우터 통합: 실제 worker.fetch 를 스텁 env 로 태운다 ----
const ABOUT_HTML = '<!doctype html><html><head><meta name="ocw-country" content="" /></head><body><h1>About</h1></body></html>';
const stubEnv = (): Env =>
  ({
    ASSETS: {
      fetch: async (req: Request) => {
        const p = new URL(req.url).pathname;
        if (p === '/about' || p === '/contact' || p === '/privacy' || p === '/') {
          return new Response(ABOUT_HTML, { headers: { 'Content-Type': 'text/html' } });
        }
        return new Response('nf', { status: 404 });
      },
    },
  }) as unknown as Env;
const ctx = { waitUntil() {}, passThroughOnException() {} } as unknown as ExecutionContext;

describe('router — 에이전트 표면 통합', () => {
  it('없는 경로 → 404 마크다운', async () => {
    const res = await worker.fetch(new Request('https://opencodewar.dev/some-path-that-does-not-exist'), stubEnv(), ctx);
    expect(res.status).toBe(404);
    expect(res.headers.get('Content-Type')).toBe('text/markdown; charset=utf-8');
  });

  it('/ + Accept: text/markdown → 마크다운, Vary: Accept', async () => {
    const res = await worker.fetch(
      new Request('https://opencodewar.dev/', { headers: { Accept: 'text/markdown' } }),
      stubEnv(),
      ctx,
    );
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toBe('text/markdown; charset=utf-8');
    expect(res.headers.get('Vary')).toContain('Accept');
    expect((await res.text()).startsWith('# Open Code War')).toBe(true);
  });

  it('/about 기본 요청은 HTML 그대로 + Vary: Accept', async () => {
    const res = await worker.fetch(new Request('https://opencodewar.dev/about'), stubEnv(), ctx);
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toBe('text/html; charset=utf-8');
    expect(res.headers.get('Vary')).toContain('Accept');
    expect(await res.text()).toContain('<h1>About</h1>');
  });

  it('/contact + Accept: text/markdown → 마크다운 문의 페이지', async () => {
    const res = await worker.fetch(
      new Request('https://opencodewar.dev/contact', { headers: { Accept: 'text/markdown' } }),
      stubEnv(),
      ctx,
    );
    expect(res.headers.get('Content-Type')).toBe('text/markdown; charset=utf-8');
    expect(await res.text()).toContain('contact@opencodewar.dev');
  });

  it('/llms.txt · /openapi.json 은 env 없이 서빙된다', async () => {
    const a = await worker.fetch(new Request('https://opencodewar.dev/llms.txt'), stubEnv(), ctx);
    const b = await worker.fetch(new Request('https://opencodewar.dev/openapi.json'), stubEnv(), ctx);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
  });

  it('JSON API 의 404 계약은 그대로(Accept: application/json)', async () => {
    const res = await worker.fetch(
      new Request('https://opencodewar.dev/nope', { headers: { Accept: 'application/json' } }),
      stubEnv(),
      ctx,
    );
    expect(res.status).toBe(404);
    expect(await res.json()).toMatchObject({ error: 'not_found' });
  });
});

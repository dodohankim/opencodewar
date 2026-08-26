/**
 * 에이전트·크롤러용 표면 (DESIGN.md §24).
 *  · Accept: text/markdown 협상(acceptmarkdown.com) — HTML 페이지의 마크다운 판을 같은 URL 로 준다.
 *  · 마크다운 404 — 없는 경로에 사이트맵 링크를 실어 에이전트가 복구할 수 있게.
 *  · /llms.txt · /llms-full.txt (llmstxt.org) — "언제 쓰나" 안내 + 문서 색인.
 *  · /docs/api (마크다운) · /openapi.json — 공개 읽기 API 명세.
 * 전부 정적 문자열이라 D1·KV 를 건드리지 않는다(무료 티어 CPU 예산에 영향 0).
 */
import { CORS_HEADERS } from './http';

export const SITE_ORIGIN = 'https://opencodewar.dev';
export const CONTACT_EMAIL = 'contact@opencodewar.dev';
export const PRIVACY_EMAIL = 'privacy@opencodewar.dev';
export const REPO_URL = 'https://github.com/dodohankim/opencodewar';

/** 사람·에이전트 공용 사이트맵. 404 본문·llms.txt·sitemap.xml 이 같은 목록을 본다. */
export const SITE_MAP: ReadonlyArray<{ path: string; title: string; note: string }> = [
  { path: '/', title: 'Leaderboard', note: 'live ranking of coding-agent prompt activity' },
  { path: '/about', title: 'About', note: 'what Open Code War is, how it works, who runs it' },
  { path: '/contact', title: 'Contact', note: 'email, GitHub issues, response times' },
  { path: '/privacy', title: 'Privacy Policy', note: 'what is collected (counts only), retention, deletion' },
  { path: '/docs/api', title: 'API reference', note: 'public JSON endpoints (markdown)' },
  { path: '/openapi.json', title: 'OpenAPI 3.1 spec', note: 'machine-readable API description' },
  { path: '/llms.txt', title: 'llms.txt', note: 'agent guide — when to use, how to call' },
  { path: '/llms-full.txt', title: 'llms-full.txt', note: 'everything above in one document' },
  { path: '/sitemap.xml', title: 'sitemap.xml', note: 'XML sitemap' },
];

/** 마크다운 판이 존재하는 HTML 페이지. 여기 있는 경로만 Accept 협상을 한다. */
const MARKDOWN_PAGES = new Set(['/', '/about', '/contact', '/privacy']);

/**
 * Accept 헤더를 파싱해 text/markdown 을 text/html 보다 선호하는지 판정한다.
 * acceptmarkdown.com: `Accept: text/markdown` 이 있으면 마크다운을 준다. 와일드카드(* / *, text/*)만으로는
 * 전환하지 않는다 — 브라우저 기본 Accept 가 마크다운으로 새지 않도록.
 */
export function prefersMarkdown(accept: string | null): boolean {
  if (!accept) return false;
  let md = -1;
  let html = -1;
  for (const part of accept.split(',')) {
    const [rawType, ...params] = part.trim().split(';');
    const type = rawType.trim().toLowerCase();
    let q = 1;
    for (const p of params) {
      const [k, v] = p.trim().split('=');
      if (k === 'q') {
        const n = Number(v);
        q = Number.isFinite(n) ? n : 0;
      }
    }
    if (type === 'text/markdown') md = Math.max(md, q);
    else if (type === 'text/html') html = Math.max(html, q);
  }
  return md > 0 && md >= html;
}

/** 협상 대상 페이지이고 요청이 마크다운을 원하면 true. */
export function wantsMarkdownPage(pathname: string, request: Request): boolean {
  if (request.method !== 'GET' && request.method !== 'HEAD') return false;
  return MARKDOWN_PAGES.has(pathname) && prefersMarkdown(request.headers.get('Accept'));
}

/** 마크다운 응답. Vary: Accept 는 필수 — CDN 이 HTML 변종을 마크다운 요청에 돌려주지 않게. */
export function markdown(body: string, status = 200, extra: Record<string, string> = {}): Response {
  return new Response(body, {
    status,
    headers: {
      'Content-Type': 'text/markdown; charset=utf-8',
      Vary: 'Accept, Accept-Encoding',
      'Cache-Control': 'public, max-age=300',
      ...CORS_HEADERS,
      ...extra,
    },
  });
}

/** HTML 응답에도 Vary: Accept 를 붙인다 — 같은 URL 이 두 표현을 가지므로 양쪽 다 표시해야 한다. */
export function withVaryAccept(res: Response): Response {
  const headers = new Headers(res.headers);
  const prev = headers.get('Vary');
  const parts = new Set(
    (prev ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
  );
  parts.add('Accept');
  parts.add('Accept-Encoding');
  headers.set('Vary', [...parts].join(', '));
  return new Response(res.body, { status: res.status, headers });
}

const siteMapList = (): string => SITE_MAP.map((e) => `- [${e.title}](${SITE_ORIGIN}${e.path}) — ${e.note}`).join('\n');

/** 404 본문(마크다운). 요청 경로를 그대로 에코하지 않는다(반사형 내용 주입 방지) — 길이만. */
export function notFoundMarkdown(pathname: string): string {
  const safe = pathname.replace(/[^\w\-./~%]/g, '').slice(0, 120) || '/';
  return `# 404 — Not Found

\`${safe}\` does not exist on opencodewar.dev.

## Where to look next

${siteMapList()}

User profile pages live at \`/u/<nickname>\` and battle pages at \`/b/<code>\`; a 404 there means that user or battle does not exist.
Agent guide: ${SITE_ORIGIN}/llms.txt
`;
}

/**
 * 404 응답. JSON 을 명시적으로 요구한 클라이언트(플러그인·API 소비자)는 기존 JSON 그대로,
 * 나머지(curl·크롤러·브라우저)는 마크다운 본문으로 복구 경로를 안내한다.
 */
export function notFound(request: Request, pathname: string): Response {
  const accept = request.headers.get('Accept') ?? '';
  if (/application\/json/i.test(accept)) {
    return new Response(JSON.stringify({ error: 'not_found', see: `${SITE_ORIGIN}/llms.txt` }), {
      status: 404,
      headers: { 'Content-Type': 'application/json; charset=utf-8', Vary: 'Accept', ...CORS_HEADERS },
    });
  }
  return markdown(notFoundMarkdown(pathname), 404, { 'Cache-Control': 'no-store' });
}

// ---------------------------------------------------------------------------
// 문서 본문
// ---------------------------------------------------------------------------

const WHEN_TO_USE = `## When to use Open Code War

Reach for Open Code War when a task is about **how much a developer works with coding agents**, not about what they wrote:

- A developer wants to **track daily coding-agent activity** (prompt count, character count, per-project time) across Claude Code, Codex, OpenCode and pi — install the plugin (below), nothing else to configure.
- A developer asks for a **public profile / developer card** that shows their agent-era activity, rank, streak and links — profiles live at \`/u/<nickname>\`; the OG image at \`/og/<public_id>.png\` is a shareable card.
- Someone wants a **leaderboard** of coding-agent usage — global, per country, or per city — use \`GET /leaderboard\`.
- A team wants a **short competition** ("battle", up to 10 people, 24 h – 7 days) on prompt volume — \`/battle/new\` via the plugin, page at \`/b/<code>\`.
- An agent needs to **look up a user's public stats by nickname** — \`GET /user?nickname=<nick>\`.

Do **not** use it for: storing or retrieving prompt text or code (never collected), measuring code quality or output, billing/cost accounting (only counts are stored), or anything requiring a private API key (there is none — the public read API is unauthenticated).

## How an agent should call it

- Base URL: \`${SITE_ORIGIN}\`. All public read endpoints are \`GET\`, return JSON, allow CORS (\`*\`) and need no auth.
- Send \`Accept: text/markdown\` to \`/\`, \`/about\`, \`/contact\` or \`/privacy\` to get a markdown rendering instead of HTML.
- Nonexistent paths return HTTP 404 with a markdown body that links back here.
- Rate limit: \`POST /track\` is capped at 60 requests / 60 s per client IP. Read endpoints are served from a 5-minute snapshot cache.
- Install for a user (Claude Code): \`/plugin marketplace add dodohankim/opencodewar\` then \`/plugin install open-code-war@opencodewar\`. Codex: \`codex plugin marketplace add dodohankim/opencodewar\` + \`codex plugin add open-code-war@opencodewar\`. OpenCode / pi: npm package \`open-code-war\`.
`;

export const API_DOC_MD = `# Open Code War API reference

Base URL \`${SITE_ORIGIN}\`. JSON over HTTPS, CORS \`*\`, no authentication for reads. Machine-readable spec: [${SITE_ORIGIN}/openapi.json](${SITE_ORIGIN}/openapi.json).
Writes (\`/track\`, \`/register\`, \`/profile\`, \`/delete\`, \`/battle/*\`) identify the caller by the anonymous \`userId\` the plugin generates on the device; they are documented for transparency, not as a public write API.

## Read endpoints

### GET /leaderboard
Ranking snapshot (rebuilt every 5 minutes).

| Query | Values | Default |
|---|---|---|
| \`type\` | \`all\` · \`daily\` · \`weekly\` · \`weekend\` · \`monthly\` | \`daily\` |
| \`metric\` | \`prompts\` · \`chars\` | \`prompts\` |
| \`limit\` | 1–500 | 100 |
| \`scope\` | \`global\` · \`country\` · \`city\` | \`global\` |
| \`country\` | ISO 3166-1 alpha-2 (with \`scope=country\`/\`city\`) | — |
| \`city\` | city name (with \`scope=city\`) | — |

Example: \`curl "${SITE_ORIGIN}/leaderboard?type=all&metric=prompts&limit=10"\`

### GET /user
Public profile + last-30-day daily usage. \`?nickname=<registered nickname>\` or \`?id=<public_id>\`. Never returns the secret \`userId\`.

### GET /user/hours
Hour-of-day histogram for one user. Same identifier query as \`/user\`, optional \`day=YYYY-MM-DD\`.

### GET /activity
Recent prompt activity, grouped per user × agent × minute (cached 60 s). Counts only — prompt text is never collected.
Returns \`{ events: [{ at, nickname, registered, public_id, agent, country, prompts }], builtAt }\`.

### GET /icon/&lt;host&gt;.png
Favicon of a domain registered as someone's shipping project. Fetched once and cached; 404 when the domain is not
registered or has no usable icon.

### GET /zones
Countries and cities that have registered users (for scope filters).

### GET /random
One random public profile (for discovery).

### GET /battle?code=<code>
Public state of a battle (members, period, standings).

### GET /health
\`{ "ok": true }\` liveness probe.

## Plugin endpoints (called by the installed plugin)

- \`POST /track\` — \`{ userId, chars, agent, project? }\`. Counts only; prompt text is never sent. 60 req/60 s per IP.
- \`POST /register\` — \`{ userId, nickname }\` set a display name (2–15 chars, letters/digits/Korean/underscore/space).
- \`POST /profile\` — \`{ userId, bio?, role?, company?, city?, country?, links?, projects? }\`.
- \`POST /delete\` — \`{ userId }\` erase everything for that id.
- \`GET /briefing?userId=\` — one-line session briefing shown in the terminal.
- \`POST /battle/new\` · \`/battle/join\` · \`/battle/leave\`, \`GET /battle/mine\` — battles (max 10 members, 24 h – 7 d).

## Pages

- \`/u/<nickname>\` — profile page (HTML; OG tags rewritten per user).
- \`/og/<public_id>.png\` — 1200×630 developer card image.
- \`/b/<code>\` — battle page.

## Errors

Every error is JSON \`{ "error": "<snake_case_code>" }\` with a 4xx/5xx status (\`invalid_nickname\`, \`not_found\`, \`rate_limited\`, …). Unknown paths return 404 with a markdown body unless the request has \`Accept: application/json\`.
`;

export const ABOUT_MD = `# About Open Code War

Open Code War (OCW) is **the contribution graph for the agent era**. It records every day a developer works with a coding agent — Claude Code, Codex, OpenCode, pi — as prompt counts, character counts and per-project time, and turns that record into a rank, a streak, a shareable developer card and a public leaderboard at ${SITE_ORIGIN}.

## How it works

1. A small plugin hooks the agent's prompt-submit event (\`UserPromptSubmit\` in Claude Code / Codex; an extension in OpenCode and pi).
2. On every submit it sends **only numbers** — an anonymous device id, the character count, the agent name, an optional project label — to a Cloudflare Worker. It is fail-open: a short timeout and fire-and-forget, so it never slows the agent.
3. The Worker stores daily aggregates in D1 (SQLite) and publishes a ranking snapshot every 5 minutes.
4. The web app renders the leaderboard, profiles (\`/u/<nickname>\`), a developer card image, ranks (a 12-step ladder driven by lifetime prompts), streaks (UTC days with ≥10 prompts and >500 characters) and battles (up to 10 people, 24 h – 7 d).

## Privacy stance

Prompt **content** is never collected — not by the plugin, not by the server. No code, file paths, IP storage or real names. The entire codebase is open source so the claim can be verified: ${REPO_URL}. Full policy: ${SITE_ORIGIN}/privacy.

## Who runs it

Open Code War is an independent, open-source project built and operated from Seoul, South Korea by its maintainer (GitHub: dodohankim). It is not affiliated with Anthropic, OpenAI, OpenCode or pi. It is free to use; there is no paid tier. Source license: BUSL-1.1.

## Links

- Leaderboard: ${SITE_ORIGIN}/
- Contact: ${SITE_ORIGIN}/contact
- API reference: ${SITE_ORIGIN}/docs/api · OpenAPI: ${SITE_ORIGIN}/openapi.json
- Agent guide: ${SITE_ORIGIN}/llms.txt
- Source: ${REPO_URL} · npm package \`open-code-war\`
`;

export const CONTACT_MD = `# Contact Open Code War

- **General / partnership / press:** ${CONTACT_EMAIL}
- **Privacy requests (access, deletion, complaints):** ${PRIVACY_EMAIL} — see ${SITE_ORIGIN}/privacy for the identity check we perform
- **Bugs & feature requests:** ${REPO_URL}/issues (public, preferred for anything technical)
- **Security reports:** email ${PRIVACY_EMAIL} with "security" in the subject; please do not open a public issue for exploitable bugs
- **Maintainer:** dodohankim on GitHub · operated from Seoul, South Korea (KST, UTC+9)

We aim to answer email within 5 business days and privacy requests within the 10-day window required by Korean law. Deletion can also be done instantly and without contacting us: run \`/ocw delete\` in your agent, or \`POST /delete\` with your device id.

Open Code War has no phone line and no physical office open to the public; email and GitHub are the only official channels.
`;

export const HOME_MD = `# Open Code War — the contribution graph for the agent era

> A live leaderboard of coding-agent activity. Tracks prompts, characters and time per project for Claude Code, Codex, OpenCode and pi — never the content.

Your agent writes the code. So where does your work show up? Open Code War records every day you work with a coding agent and turns it into a rank, a streak, a developer card and, if you want, a war.

## Rules

1. **Input = a prompt submit.** +1 per Enter; characters counted too.
2. **No content collected.** Only the character count (a number) is sent.
3. **Total & daily boards.** Every prompt ever counts on total; daily resets at 00:00 UTC.

## Install

- Claude Code: \`/plugin marketplace add dodohankim/opencodewar\` → \`/plugin install open-code-war@opencodewar\`
- Codex: \`codex plugin marketplace add dodohankim/opencodewar\` → \`codex plugin add open-code-war@opencodewar\`
- pi: \`pi install npm:open-code-war\`
- OpenCode: add \`"open-code-war"\` to the \`plugin\` array in \`opencode.json\`

## Live data

- Top 10 all-time: \`GET ${SITE_ORIGIN}/leaderboard?type=all&metric=prompts&limit=10\`
- A user: \`GET ${SITE_ORIGIN}/user?nickname=<nick>\` — profile page \`${SITE_ORIGIN}/u/<nick>\`

## More

- About: ${SITE_ORIGIN}/about · Contact: ${SITE_ORIGIN}/contact · Privacy: ${SITE_ORIGIN}/privacy
- API: ${SITE_ORIGIN}/docs/api · Agent guide: ${SITE_ORIGIN}/llms.txt
`;

/** /privacy 의 마크다운 판 — 핵심 요약 + 전문 링크(전문은 HTML 이 단일 원본). */
export const PRIVACY_MD = `# Open Code War Privacy Policy (summary)

Full text (English and Korean, effective 2026-08-10): ${SITE_ORIGIN}/privacy — this summary is for agents and is not a substitute for the full policy.

## What is collected
- Anonymous device id generated at install (random; not linked to a person unless Google is linked).
- Usage counts: number of prompt submits and their character counts, the agent name, a timestamp.
- Country (2-letter code) and IANA timezone derived by Cloudflare from the IP — the IP itself is not stored.
- Optional: a project label you chose, a nickname, bio/role/company/links you enter, and — if you link Google — your Google account id and email (private by default).

## What is never collected
Prompt content, code, file names or paths, IP addresses (transient only), real name, phone, postal address, anything from Google beyond id and email.

## Retention & deletion
Kept while the record exists. \`/ocw delete\` in the agent or \`POST /delete\` erases everything immediately. Email ${PRIVACY_EMAIL} for requests that need a human.

## Processors
Cloudflare (Workers, D1, KV — hosting), Google (OAuth only when you link), a VPS rendering the developer-card image. No sale or sharing of personal data for advertising.

## Contact
${PRIVACY_EMAIL} · Korean users may also contact the Personal Information Infringement Report Center (privacy.kisa.or.kr, ☎118).
`;

export const LLMS_TXT = `# Open Code War

> The contribution graph for the agent era: a privacy-first leaderboard and developer card that records how much a developer works with coding agents (Claude Code, Codex, OpenCode, pi) — prompt counts and character counts only, never prompt content. Site: ${SITE_ORIGIN}

${WHEN_TO_USE}
## Docs

- [About](${SITE_ORIGIN}/about): what it is, how it works, who runs it
- [API reference](${SITE_ORIGIN}/docs/api): every public endpoint with parameters
- [OpenAPI spec](${SITE_ORIGIN}/openapi.json): OpenAPI 3.1, read endpoints
- [Privacy policy](${SITE_ORIGIN}/privacy): what is collected and how to delete it
- [Contact](${SITE_ORIGIN}/contact): email, GitHub issues, security reports
- [Source code](${REPO_URL}): Cloudflare Worker backend, plugin, web — BUSL-1.1
- [npm package open-code-war](https://www.npmjs.com/package/open-code-war): OpenCode / pi adapter

## Optional

- [llms-full.txt](${SITE_ORIGIN}/llms-full.txt): all of the above in one file
- [Sitemap](${SITE_ORIGIN}/sitemap.xml)
`;

export const LLMS_FULL_TXT = [LLMS_TXT, ABOUT_MD, API_DOC_MD, CONTACT_MD, PRIVACY_MD].join('\n\n---\n\n');

/** OpenAPI 3.1 — 공개 읽기 엔드포인트만. 쓰기 계열은 플러그인 전용이라 뺀다. */
export const OPENAPI: Record<string, unknown> = {
  openapi: '3.1.0',
  info: {
    title: 'Open Code War API',
    version: '1.0.0',
    summary: 'Public read API for the Open Code War coding-agent leaderboard',
    description:
      'Unauthenticated JSON endpoints. Only counts are stored — no prompt content. See https://opencodewar.dev/docs/api for the full reference including plugin-only write endpoints.',
    contact: { name: 'Open Code War', email: CONTACT_EMAIL, url: `${SITE_ORIGIN}/contact` },
    license: { name: 'BUSL-1.1', url: `${REPO_URL}/blob/main/LICENSE` },
  },
  servers: [{ url: SITE_ORIGIN }],
  paths: {
    '/leaderboard': {
      get: {
        operationId: 'getLeaderboard',
        summary: 'Ranking snapshot',
        parameters: [
          { name: 'type', in: 'query', schema: { type: 'string', enum: ['all', 'daily', 'weekly', 'weekend', 'monthly'], default: 'daily' } },
          { name: 'metric', in: 'query', schema: { type: 'string', enum: ['prompts', 'chars'], default: 'prompts' } },
          { name: 'limit', in: 'query', schema: { type: 'integer', minimum: 1, maximum: 500, default: 100 } },
          { name: 'scope', in: 'query', schema: { type: 'string', enum: ['global', 'country', 'city'], default: 'global' } },
          { name: 'country', in: 'query', schema: { type: 'string', pattern: '^[A-Za-z]{2}$' } },
          { name: 'city', in: 'query', schema: { type: 'string' } },
        ],
        responses: { '200': { description: 'Ranking', content: { 'application/json': { schema: { type: 'object' } } } } },
      },
    },
    '/user': {
      get: {
        operationId: 'getUser',
        summary: 'Public profile and last-30-day daily usage',
        parameters: [
          { name: 'nickname', in: 'query', schema: { type: 'string', minLength: 2, maxLength: 15 } },
          { name: 'id', in: 'query', description: 'public_id slug (alternative to nickname)', schema: { type: 'string' } },
        ],
        responses: {
          '200': { description: 'Profile', content: { 'application/json': { schema: { type: 'object' } } } },
          '400': { $ref: '#/components/responses/Error' },
          '404': { $ref: '#/components/responses/Error' },
        },
      },
    },
    '/user/hours': {
      get: {
        operationId: 'getUserHours',
        summary: 'Hour-of-day histogram for one user',
        parameters: [
          { name: 'nickname', in: 'query', schema: { type: 'string' } },
          { name: 'id', in: 'query', schema: { type: 'string' } },
          { name: 'day', in: 'query', schema: { type: 'string', format: 'date' } },
        ],
        responses: { '200': { description: 'Histogram', content: { 'application/json': { schema: { type: 'object' } } } } },
      },
    },
    '/activity': {
      get: {
        operationId: 'getActivity',
        summary: 'Recent prompt activity (per user × agent × minute, 60s cache)',
        responses: { '200': { description: 'Activity', content: { 'application/json': { schema: { type: 'object' } } } } },
      },
    },
    '/zones': {
      get: {
        operationId: 'getZones',
        summary: 'Countries and cities with registered users',
        responses: { '200': { description: 'Zones', content: { 'application/json': { schema: { type: 'object' } } } } },
      },
    },
    '/random': {
      get: {
        operationId: 'getRandomProfile',
        summary: 'One random public profile',
        responses: { '200': { description: 'Profile', content: { 'application/json': { schema: { type: 'object' } } } } },
      },
    },
    '/battle': {
      get: {
        operationId: 'getBattle',
        summary: 'Public state of a battle',
        parameters: [{ name: 'code', in: 'query', required: true, schema: { type: 'string', pattern: '^[23456789abcdefghjkmnpqrstuvwxyz]{6}$' } }],
        responses: {
          '200': { description: 'Battle', content: { 'application/json': { schema: { type: 'object' } } } },
          '404': { $ref: '#/components/responses/Error' },
        },
      },
    },
    '/health': {
      get: {
        operationId: 'getHealth',
        summary: 'Liveness probe',
        responses: { '200': { description: 'OK', content: { 'application/json': { schema: { type: 'object', properties: { ok: { type: 'boolean' } } } } } } },
      },
    },
  },
  components: {
    responses: {
      Error: {
        description: 'Error',
        content: {
          'application/json': {
            schema: { type: 'object', required: ['error'], properties: { error: { type: 'string' } } },
          },
        },
      },
    },
  },
};

/** 라우터에서 먼저 호출 — 에이전트 문서 경로면 응답, 아니면 null. */
export function handleAgentDocs(pathname: string, request: Request): Response | null {
  if (request.method !== 'GET' && request.method !== 'HEAD') return null;
  switch (pathname) {
    case '/llms.txt':
      return markdown(LLMS_TXT);
    case '/llms-full.txt':
      return markdown(LLMS_FULL_TXT);
    case '/docs/api':
    case '/docs/api.md':
    case '/docs':
      return markdown(API_DOC_MD);
    case '/openapi.json':
      return new Response(JSON.stringify(OPENAPI, null, 2), {
        headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'public, max-age=300', ...CORS_HEADERS },
      });
    default:
      return null;
  }
}

/** 협상 대상 HTML 페이지의 마크다운 판. */
export function markdownForPage(pathname: string): Response | null {
  switch (pathname) {
    case '/':
      return markdown(HOME_MD);
    case '/about':
      return markdown(ABOUT_MD);
    case '/contact':
      return markdown(CONTACT_MD);
    case '/privacy':
      return markdown(PRIVACY_MD);
    default:
      return null;
  }
}

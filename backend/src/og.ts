import type { Env } from './types';
import { isValidNickname } from './validate';
import { isValidPublicId } from './publicid';
import { autoNickname } from './nickname';

/** 공유 링크가 가리키는 정식 오리진(카톡·슬랙·X 미리보기의 og:url·canonical). */
const SITE_ORIGIN = 'https://opencodewar.dev';

/** 소셜 미리보기·검색결과에서 잘리지 않는 설명 길이 상한. */
export const MAX_OG_DESC = 150;

export interface ProfileMetaRow {
  nickname: string;
  bio: string | null;
  role: string | null;
  company: string | null;
}

/**
 * 프로필 공유 미리보기용 설명을 만든다.
 * role·company·bio 가 있으면 그걸로, 없으면 기본 문구. MAX_OG_DESC 초과 시 말줄임.
 */
export function buildOgDescription(row: ProfileMetaRow, rank?: number | null): string {
  const who = [row.role, row.company].filter(Boolean).join(' @ ');
  const bio = (row.bio ?? '').trim();
  // 전체 순위가 있으면 맨 앞에 붙인다(공유 미리보기에서 순위가 먼저 보이게).
  const rankBit = typeof rank === 'number' && rank > 0 ? `#${rank} on the board` : '';
  const intro = [rankBit, who, bio].filter(Boolean).join(' · ');
  const desc = intro
    ? `${intro} — coding agent activity on Open Code War.`
    : 'Coding agent activity — prompts & chars over the last 30 days on Open Code War.';
  if (desc.length <= MAX_OG_DESC) return desc;
  return desc.slice(0, MAX_OG_DESC - 1).trimEnd() + '…';
}

/** Cloudflare 가 국가를 특정하지 못한 경우의 값 — 실제 국가가 아니므로 '모름'으로 다룬다. */
const UNKNOWN_COUNTRY = new Set(['XX', 'T1']);

/**
 * 방문자 국가(ISO 3166-1 alpha-2). Cloudflare 가 IP 로 붙여주는 값.
 * 로컬 개발·Tor·판별 실패면 null → 웹이 브라우저 언어로 내려간다.
 */
export function visitorCountry(request: Request): string | null {
  const cc = request.cf?.country;
  if (typeof cc !== 'string' || !/^[A-Z]{2}$/.test(cc) || UNKNOWN_COUNTRY.has(cc)) return null;
  return cc;
}

/**
 * 정적 HTML 의 <meta name="ocw-country"> 에 방문자 국가를 심는다.
 * 웹은 이 값으로 첫 방문 기본 언어를 고른다(KR → 한국어, 그 외 → 영어).
 * 국가를 모르면 빈 값 그대로 둔다(웹이 브라우저 언어로 판단).
 */
export function withVisitorCountry(res: Response, country: string | null): Response {
  if (!country || !(res.headers.get('Content-Type') ?? '').includes('text/html')) return res;
  return asPrivate(
    new HTMLRewriter()
      .on('meta[name="ocw-country"]', {
        element(el) {
          el.setAttribute('content', country);
        },
      })
      .transform(res),
  );
}

/**
 * 방문자 국가가 섞인 HTML 은 사람마다 다르다 → 공유 캐시(CDN·프록시)에 담기지 않게 private 로 낮춘다.
 * 안 그러면 한 나라 방문자가 받은 페이지가 다른 나라 방문자에게 그대로 나갈 수 있다.
 * 브라우저 캐시는 그대로 두되 매번 재검증(must-revalidate)한다.
 */
function asPrivate(res: Response): Response {
  const headers = new Headers(res.headers);
  headers.set('Cache-Control', 'private, max-age=0, must-revalidate');
  return new Response(res.body, { status: res.status, headers });
}

/** 프로필 경로 접두어. 닉네임이 API·페이지 경로와 충돌하지 않도록 네임스페이스를 분리한다. */
export const PROFILE_PREFIX = '/u/';

/** '/u/<nickname>' 에서 닉네임을 꺼낸다(퍼센트 디코딩). 형식이 아니면 null. */
export function nicknameFromPath(pathname: string): string | null {
  if (!pathname.startsWith(PROFILE_PREFIX)) return null;
  const raw = pathname.slice(PROFILE_PREFIX.length);
  if (!raw || raw.includes('/')) return null;
  try {
    return decodeURIComponent(raw);
  } catch {
    return null; // 잘못된 퍼센트 인코딩
  }
}

/** 프로필 경로(오리진 없음). 리다이렉트처럼 같은 오리진을 유지해야 할 때 쓴다. */
export function profilePath(nickname: string): string {
  return `${PROFILE_PREFIX}${encodeURIComponent(nickname)}`;
}

/** 프로필 정식 URL(공유·canonical). 크롤러용이라 항상 운영 오리진을 쓴다. */
export function profileUrl(nickname: string): string {
  return `${SITE_ORIGIN}${profilePath(nickname)}`;
}

/** 유저별 OG 이미지 경로/URL·저장 키. 파일명은 public_id 기준(항상 ASCII, 유저마다 존재). */
export const OG_IMAGE_PREFIX = '/og/';
/** KV 저장 키(스냅샷 키 lb:… 와 네임스페이스 분리). CI 업로드와 이 서빙이 공유한다. */
export function ogImageKey(publicId: string): string {
  return `og:img:${publicId}`;
}
export function ogImageUrl(publicId: string): string {
  // ?d=YYYYMMDD — 카톡·X 등 플랫폼의 이미지 캐시를 일 단위로 우회한다(데일리 카드 컨셉 유지).
  // /og/ 라우팅·KV 캐시는 pathname 만 보므로 서버 동작엔 영향 없다.
  const d = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  return `${SITE_ORIGIN}${OG_IMAGE_PREFIX}${publicId}.png?d=${d}`;
}
/** '/og/<public_id>.png' 에서 public_id 를 꺼낸다. 형식이 아니면 null. */
export function ogImageIdFromPath(pathname: string): string | null {
  if (!pathname.startsWith(OG_IMAGE_PREFIX) || !pathname.endsWith('.png')) return null;
  const id = pathname.slice(OG_IMAGE_PREFIX.length, -'.png'.length);
  return isValidPublicId(id) ? id : null;
}

/** KV 이미지 신선도(TTL). 만료되면 다음 접근 시 재렌더 → "몇 분 전" 신선도. */
const OG_KV_TTL_S = 1800; // 30분

/**
 * GET /og/<public_id>.png — 유저별 공유 이미지(온디맨드).
 *  1) KV(og:img:<public_id>) 히트 → 즉시 서빙(30분 내 재접근은 캐시)
 *  2) 미스 → 렌더 서비스(VPS)에 요청해 그 자리에서 만들고, KV 에 TTL 로 캐시한 뒤 서빙
 *  3) 렌더 서비스가 없거나 실패 → 공통 og.png 폴백
 * → og:image URL 은 항상 유효하고, 아무도 안 보는 유저는 렌더되지 않는다(낭비 0).
 * 저장소로 KV 를 쓰는 이유: 무료 티어에서 R2(카드 등록)를 요구하지 않고, 이미지가 값 한도(25MB) 안.
 */
export async function handleOgImage(
  request: Request,
  url: URL,
  env: Env,
  publicId: string,
  ctx?: ExecutionContext,
): Promise<Response> {
  const CACHE = 'public, max-age=300, s-maxage=300';
  const key = ogImageKey(publicId);

  // 1) KV 히트
  try {
    const png = await env.KV.get(key, 'arrayBuffer');
    if (png) {
      return new Response(png, { headers: { 'Content-Type': 'image/png', 'Cache-Control': CACHE } });
    }
  } catch (err) {
    console.error(JSON.stringify({ level: 'error', msg: 'og_image_kv_failed', err: String(err) }));
  }

  // 2) 미스 → 렌더 서비스(VPS) 온디맨드
  if (env.RENDER_ORIGIN) {
    try {
      const rendered = await fetch(`${env.RENDER_ORIGIN}/og/${publicId}.png`, {
        headers: env.RENDER_KEY ? { 'X-OCW-Render-Key': env.RENDER_KEY } : {},
        signal: AbortSignal.timeout(10_000),
      });
      if (rendered.ok) {
        const buf = await rendered.arrayBuffer();
        const put = env.KV.put(key, buf, { expirationTtl: OG_KV_TTL_S });
        if (ctx) ctx.waitUntil(put);
        else await put;
        return new Response(buf, { headers: { 'Content-Type': 'image/png', 'Cache-Control': CACHE } });
      }
      console.error(JSON.stringify({ level: 'warn', msg: 'og_render_bad_status', status: rendered.status }));
    } catch (err) {
      console.error(JSON.stringify({ level: 'error', msg: 'og_render_failed', err: String(err) }));
    }
  }

  // 3) 폴백: 공통 og.png 정적 에셋
  const fallback = await env.ASSETS.fetch(new Request(new URL('/og.png', url), request));
  return new Response(fallback.body, {
    status: 200,
    headers: { 'Content-Type': 'image/png', 'Cache-Control': CACHE },
  });
}

/**
 * GET /u/<nickname> — index.html 의 제목·OG·트위터 메타를 해당 유저로 재작성해 서빙.
 * 등록 유저가 아니거나(404) 조회 실패 시 원본 에셋을 그대로 반환한다(fail open).
 * SPA 라우팅·데이터 로딩은 기존처럼 클라이언트가 담당하고, 여긴 크롤러용 메타만 바꾼다.
 * @param seg 경로에서 뽑은 식별자(등록 닉네임 또는 공개 slug). null 이면 루트 요청(에셋 그대로).
 */
export async function handleProfilePage(
  request: Request,
  url: URL,
  env: Env,
  seg: string | null,
): Promise<Response> {
  // /u/<seg> 는 정적 에셋이 아니므로 루트(index.html)를 대신 가져온다.
  const assetReq = url.pathname === '/' ? request : new Request(new URL('/', url), request);
  // 방문자 국가는 프로필 유무와 무관하게 항상 심는다(루트 '/' 도 이 경로로 들어온다).
  const country = visitorCountry(request);

  // seg 는 등록 닉네임이거나 공개 slug(public_id). 둘 다 아니면 재작성 없이 에셋 그대로(fail open).
  const byNick = isValidNickname(seg);
  const byId = !byNick && isValidPublicId(seg);

  type MetaLookupRow = {
    nickname: string | null;
    bio: string | null;
    role: string | null;
    company: string | null;
    public_id: string | null;
    user_id?: string;
  };
  // 에셋 fetch 와 메타 재작성용 D1 조회를 병렬로 — 직렬이면 D1 왕복(~150ms)만큼 첫 바이트가 늦어진다.
  // 조회 실패는 'error' 센티널로 구분한다(null 은 "유저 없음" → 404, 실패는 재작성 없이 fail open).
  const assetPromise = env.ASSETS.fetch(assetReq);
  const rowPromise: Promise<MetaLookupRow | null | 'error'> =
    byNick || byId
      ? (byNick
          ? env.DB.prepare('SELECT nickname, bio, role, company, public_id FROM users WHERE nickname = ?')
              .bind((seg as string).trim())
              .first<MetaLookupRow>()
          : env.DB.prepare('SELECT user_id, nickname, bio, role, company, public_id FROM users WHERE public_id = ?')
              .bind(seg as string)
              .first<MetaLookupRow>()
        ).catch((err) => {
          console.error(JSON.stringify({ level: 'error', msg: 'og_lookup_failed', err: String(err) }));
          return 'error' as const;
        })
      : Promise.resolve(null);

  // 전체 순위(공유 미리보기용, 전 기간 prompts). daily_stats 전체 집계 — 규모 커지면 리더보드 스냅샷 재사용 고려.
  // 에셋·메타 조회와 병렬. 조회 실패/미활동이면 null → 순위 표기 생략(fail open).
  const rankCol = byNick ? 'nickname' : 'public_id';
  const rankPromise: Promise<number | null> =
    byNick || byId
      ? env.DB.prepare(
          `WITH tot AS (SELECT user_id AS uid, SUM(prompts) AS p FROM daily_stats GROUP BY user_id),
                me AS (SELECT t.p AS p FROM tot t JOIN users u ON u.user_id = t.uid WHERE u.${rankCol} = ?)
           SELECT (SELECT COUNT(*) FROM me) AS hasme, (SELECT COUNT(*) + 1 FROM tot WHERE p > (SELECT p FROM me)) AS grank`,
        )
          .bind(byNick ? (seg as string).trim() : (seg as string))
          .first<{ hasme: number; grank: number }>()
          .then((r) => (r && Number(r.hasme) > 0 ? Number(r.grank) || null : null))
          .catch(() => null)
      : Promise.resolve(null);

  const assetRes = await assetPromise;
  const contentType = assetRes.headers.get('Content-Type') ?? '';
  if ((!byNick && !byId) || !contentType.includes('text/html')) return withVisitorCountry(assetRes, country);

  const row = await rowPromise;
  if (row === 'error') return withVisitorCountry(assetRes, country);
  // 없는 프로필은 앱 UI(“User not found.”)를 그대로 보여주되 상태코드는 404 —
  // 크롤러가 존재하지 않는 유저 주소를 색인하지 않도록(soft 404 방지).
  if (!row) {
    return withVisitorCountry(new Response(assetRes.body, { status: 404, headers: assetRes.headers }), country);
  }

  // 표시 이름: 등록 닉네임이 있으면 그대로, 없으면(익명·slug 조회) userId 파생 자동 닉네임.
  const displayName = row.nickname ?? (row.user_id ? autoNickname(row.user_id) : '');
  // canonical: 등록 유저는 닉네임 정식 URL로 통일(중복 색인 방지), 익명 유저는 slug URL.
  const canonicalSeg = row.nickname ?? (seg as string);
  const metaRow: ProfileMetaRow = { nickname: displayName, bio: row.bio, role: row.role, company: row.company };

  // 공유 링크: 전체 top-3 만 순위를 앞세운다(카드 메달과 동일 규칙, 4위↓는 기존 문구).
  const rank = await rankPromise;
  const topRank = rank && rank <= 3 ? rank : null;
  const title = topRank ? `${displayName} · #${topRank} on Open Code War` : `${displayName} · Open Code War`;
  const desc = buildOgDescription(metaRow, topRank);
  const pageUrl = profileUrl(canonicalSeg);
  // 유저별 OG 이미지(public_id 기준). public_id 가 없으면(구 데이터) 공통 og.png 유지.
  const publicId = byId ? (seg as string) : row.public_id;
  const imageUrl = publicId ? ogImageUrl(publicId) : `${SITE_ORIGIN}/og.png`;
  const setContent = (value: string) => ({
    element(el: Element) {
      el.setAttribute('content', value);
    },
  });

  // 운영에서는 에셋에 없는 경로(/u/…)로 들어온 요청의 상태코드가 404로 물려온다.
  // 존재하는 프로필이므로 200으로 명시해 서빙한다(크롤러가 정상 페이지로 인식).
  const pageRes = assetRes.status === 200 ? assetRes : new Response(assetRes.body, { status: 200, headers: assetRes.headers });

  const rewritten = new HTMLRewriter()
    .on('meta[name="ocw-country"]', setContent(country ?? ''))
    .on('title', {
      element(el) {
        el.setInnerContent(title);
      },
    })
    .on('link[rel="canonical"]', {
      element(el) {
        el.setAttribute('href', pageUrl);
      },
    })
    .on('meta[name="description"]', setContent(desc))
    .on('meta[property="og:type"]', setContent('profile'))
    .on('meta[property="og:title"]', setContent(title))
    .on('meta[property="og:description"]', setContent(desc))
    .on('meta[property="og:url"]', setContent(pageUrl))
    .on('meta[property="og:image"]', setContent(imageUrl))
    .on('meta[property="og:image:alt"]', setContent(title))
    .on('meta[name="twitter:title"]', setContent(title))
    .on('meta[name="twitter:description"]', setContent(desc))
    .on('meta[name="twitter:image"]', setContent(imageUrl))
    .transform(pageRes);
  return country ? asPrivate(rewritten) : rewritten;
}

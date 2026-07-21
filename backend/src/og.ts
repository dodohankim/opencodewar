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
export function buildOgDescription(row: ProfileMetaRow): string {
  const who = [row.role, row.company].filter(Boolean).join(' @ ');
  const bio = (row.bio ?? '').trim();
  const intro = [who, bio].filter(Boolean).join(' · ');
  const desc = intro
    ? `${intro} — coding agent activity on Open Code War.`
    : 'Coding agent activity — prompts & chars over the last 30 days on Open Code War.';
  if (desc.length <= MAX_OG_DESC) return desc;
  return desc.slice(0, MAX_OG_DESC - 1).trimEnd() + '…';
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
  return `${SITE_ORIGIN}${OG_IMAGE_PREFIX}${publicId}.png`;
}
/** '/og/<public_id>.png' 에서 public_id 를 꺼낸다. 형식이 아니면 null. */
export function ogImageIdFromPath(pathname: string): string | null {
  if (!pathname.startsWith(OG_IMAGE_PREFIX) || !pathname.endsWith('.png')) return null;
  const id = pathname.slice(OG_IMAGE_PREFIX.length, -'.png'.length);
  return isValidPublicId(id) ? id : null;
}

/**
 * GET /og/<public_id>.png — 유저별 공유 이미지.
 * CI가 미리 렌더해 KV(og:img:<public_id>)에 올려둔 PNG를 서빙하고, 아직 없으면 공통 og.png로 폴백한다.
 * → og:image URL은 항상 유효하므로 신규 유저도 미리보기가 깨지지 않는다.
 * 저장소로 KV를 쓰는 이유: 무료 티어에서 R2(카드 등록)를 요구하지 않고 즉시 가능하며,
 * 이미지(~70KB)가 KV 값 한도(25MB) 안에 충분히 들어가기 때문. 신선도는 max-age=300(5분).
 */
export async function handleOgImage(
  request: Request,
  url: URL,
  env: Env,
  publicId: string,
): Promise<Response> {
  const CACHE = 'public, max-age=300, s-maxage=300';
  try {
    const png = await env.KV.get(ogImageKey(publicId), 'arrayBuffer');
    if (png) {
      return new Response(png, { headers: { 'Content-Type': 'image/png', 'Cache-Control': CACHE } });
    }
  } catch (err) {
    console.error(JSON.stringify({ level: 'error', msg: 'og_image_kv_failed', err: String(err) }));
  }
  // 폴백: 공통 og.png 정적 에셋
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
  const assetRes = await env.ASSETS.fetch(assetReq);

  // seg 는 등록 닉네임이거나 공개 slug(public_id). 둘 다 아니면 재작성 없이 에셋 그대로(fail open).
  const byNick = isValidNickname(seg);
  const byId = !byNick && isValidPublicId(seg);
  const contentType = assetRes.headers.get('Content-Type') ?? '';
  if ((!byNick && !byId) || !contentType.includes('text/html')) return assetRes;

  let row:
    | { nickname: string | null; bio: string | null; role: string | null; company: string | null; public_id: string | null; user_id?: string }
    | null = null;
  try {
    row = byNick
      ? await env.DB.prepare('SELECT nickname, bio, role, company, public_id FROM users WHERE nickname = ?')
          .bind((seg as string).trim())
          .first()
      : await env.DB.prepare('SELECT user_id, nickname, bio, role, company, public_id FROM users WHERE public_id = ?')
          .bind(seg as string)
          .first();
  } catch (err) {
    console.error(JSON.stringify({ level: 'error', msg: 'og_lookup_failed', err: String(err) }));
    return assetRes;
  }
  // 없는 프로필은 앱 UI(“User not found.”)를 그대로 보여주되 상태코드는 404 —
  // 크롤러가 존재하지 않는 유저 주소를 색인하지 않도록(soft 404 방지).
  if (!row) return new Response(assetRes.body, { status: 404, headers: assetRes.headers });

  // 표시 이름: 등록 닉네임이 있으면 그대로, 없으면(익명·slug 조회) userId 파생 자동 닉네임.
  const displayName = row.nickname ?? (row.user_id ? autoNickname(row.user_id) : '');
  // canonical: 등록 유저는 닉네임 정식 URL로 통일(중복 색인 방지), 익명 유저는 slug URL.
  const canonicalSeg = row.nickname ?? (seg as string);
  const metaRow: ProfileMetaRow = { nickname: displayName, bio: row.bio, role: row.role, company: row.company };

  const title = `${displayName} · Open Code War`;
  const desc = buildOgDescription(metaRow);
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

  return new HTMLRewriter()
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
}

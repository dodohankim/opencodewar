import type { Env } from './types';
import { isValidNickname } from './validate';

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

/**
 * GET /u/<nickname> — index.html 의 제목·OG·트위터 메타를 해당 유저로 재작성해 서빙.
 * 등록 유저가 아니거나(404) 조회 실패 시 원본 에셋을 그대로 반환한다(fail open).
 * SPA 라우팅·데이터 로딩은 기존처럼 클라이언트가 담당하고, 여긴 크롤러용 메타만 바꾼다.
 * @param nick 경로에서 뽑은 닉네임. null 이면 루트 요청(메타 재작성 없이 에셋 그대로).
 */
export async function handleProfilePage(
  request: Request,
  url: URL,
  env: Env,
  nick: string | null,
): Promise<Response> {
  // /u/<nick> 은 정적 에셋이 아니므로 루트(index.html)를 대신 가져온다.
  const assetReq = url.pathname === '/' ? request : new Request(new URL('/', url), request);
  const assetRes = await env.ASSETS.fetch(assetReq);
  if (!isValidNickname(nick)) return assetRes;
  const contentType = assetRes.headers.get('Content-Type') ?? '';
  if (!contentType.includes('text/html')) return assetRes;

  let row: ProfileMetaRow | null = null;
  try {
    row = await env.DB.prepare('SELECT nickname, bio, role, company FROM users WHERE nickname = ?')
      .bind(nick.trim())
      .first<ProfileMetaRow>();
  } catch (err) {
    console.error(JSON.stringify({ level: 'error', msg: 'og_lookup_failed', err: String(err) }));
    return assetRes;
  }
  // 없는 프로필은 앱 UI(“User not found.”)를 그대로 보여주되 상태코드는 404 —
  // 크롤러가 존재하지 않는 유저 주소를 색인하지 않도록(soft 404 방지).
  if (!row) return new Response(assetRes.body, { status: 404, headers: assetRes.headers });

  const title = `${row.nickname} · Open Code War`;
  const desc = buildOgDescription(row);
  const pageUrl = profileUrl(row.nickname);
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
    .on('meta[property="og:image:alt"]', setContent(title))
    .on('meta[name="twitter:title"]', setContent(title))
    .on('meta[name="twitter:description"]', setContent(desc))
    .transform(pageRes);
}

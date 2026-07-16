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
    ? `${intro} — Claude Code activity on Open Code War.`
    : 'Claude Code activity — prompts & chars over the last 30 days on Open Code War.';
  if (desc.length <= MAX_OG_DESC) return desc;
  return desc.slice(0, MAX_OG_DESC - 1).trimEnd() + '…';
}

/**
 * GET /?user=<nickname> — index.html 의 제목·OG·트위터 메타를 해당 유저로 재작성해 서빙.
 * 등록 유저가 아니거나(404) 조회 실패 시 원본 에셋을 그대로 반환한다(fail open).
 * SPA 라우팅·데이터 로딩은 기존처럼 클라이언트가 담당하고, 여기선 크롤러용 메타만 바꾼다.
 */
export async function handleProfilePage(request: Request, url: URL, env: Env): Promise<Response> {
  const assetRes = await env.ASSETS.fetch(request);
  const nick = url.searchParams.get('user');
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
  if (!row) return assetRes;

  const title = `${row.nickname} · Open Code War`;
  const desc = buildOgDescription(row);
  const pageUrl = `${SITE_ORIGIN}/?user=${encodeURIComponent(row.nickname)}`;
  const setContent = (value: string) => ({
    element(el: Element) {
      el.setAttribute('content', value);
    },
  });

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
    .transform(assetRes);
}

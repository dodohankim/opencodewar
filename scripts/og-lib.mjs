// 유저 OG 이미지 공통 로직 — 데이터 조립 + 템플릿 주입.
// CLI 렌더러(render-og.mjs, chrome --screenshot)와 VPS 온디맨드 서버(render-service, puppeteer)가
// 둘 다 이걸 import 해서 "무엇을 그릴지"를 한 곳에서만 정의한다(템플릿은 web/og-user.html 단일 소스).

// public_id(slug)는 'u-'+10자[0-9a-z] — 닉네임엔 하이픈이 없어 구조로 구분된다.
export const PUBLIC_ID_RE = /^u-[0-9a-z]{10}$/;

export async function fetchJson(url) {
  const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
  if (!res.ok) throw new Error(`${url} → HTTP ${res.status}`);
  return res.json();
}

/** KST(UTC+9) 'YYYY-MM-DD · KST' 스탬프. */
export function kstStamp() {
  const d = new Date(Date.now() + 9 * 3600 * 1000);
  return `${d.toISOString().slice(0, 10)} · KST`;
}

/**
 * 식별자(닉네임 또는 public_id)로 카드 데이터 조립.
 * 순위·프로필·오늘/30일 집계·30일 시리즈를 API에서 모아 템플릿이 읽는 형태로 만든다.
 */
export async function buildData(api, seg) {
  const API = api.replace(/\/+$/, '');
  const isPid = PUBLIC_ID_RE.test(seg);
  const query = isPid ? `id=${encodeURIComponent(seg)}` : `nickname=${encodeURIComponent(seg)}`;
  const profile = await fetchJson(`${API}/user?${query}`);
  const days = profile.days || [];
  const last = days[days.length - 1] || { prompts: 0, chars: 0 };
  const totals = profile.totals || { prompts: 0, chars: 0 };
  const nick = profile.nickname || seg; // 익명 유저는 응답의 자동 닉네임을 표시명으로

  // 오늘 순위: daily 리더보드에서 식별자 매칭. 실패해도 이미지는 만든다.
  let rank = 0;
  let total = 0;
  try {
    const lb = await fetchJson(`${API}/leaderboard?type=daily&metric=prompts&limit=100`);
    total = lb.count || (lb.ranking || []).length;
    const row = (lb.ranking || []).find((r) => (isPid ? r.public_id === seg : r.nickname === seg));
    if (row) rank = row.rank;
  } catch {
    // 순위 조회 실패는 무시
  }

  return {
    nick,
    rank,
    total,
    country: profile.country || '',
    flag: profile.flag || '',
    city: profile.city || '',
    today: { prompts: last.prompts || 0, chars: last.chars || 0 },
    d30: { prompts: totals.prompts || 0, chars: totals.chars || 0 },
    series: days.map((d) => d.prompts || 0),
    stamp: kstStamp(),
  };
}

// 템플릿의 OCW_DATA 주석 마커를 실제 JSON 으로 치환한다(쿼리 인코딩 문제 회피).
export function injectTemplate(templateHtml, data) {
  return templateHtml.replace(
    /\/\*OCW_DATA\*\/[\s\S]*?\/\*END\*\//,
    `/*OCW_DATA*/${JSON.stringify(data)}/*END*/`,
  );
}

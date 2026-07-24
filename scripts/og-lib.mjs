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

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
/** 'YYYY-MM-DD' → 'M/DD' (그래프 축용). */
function mdLabel(iso) {
  const [, m, d] = iso.split('-').map(Number);
  return `${m}/${String(d).padStart(2, '0')}`;
}
/** 'YYYY-MM-DD' → 'Mon D' (스트릭 since·히어로 날짜용). */
function monthDayLabel(iso) {
  const [, m, d] = iso.split('-').map(Number);
  return `${MONTHS[m - 1]} ${d}`;
}
/** 'YYYY-MM-DD' → 요일 약어. */
function dowLabel(iso) {
  const [y, m, d] = iso.split('-').map(Number);
  return DOW[new Date(Date.UTC(y, m - 1, d)).getUTCDay()];
}

/** 최근 14일 그래프에서 한 칸이 차지할 지분(막대 개수). */
const GRAPH_DAYS = 14;

/**
 * 식별자(닉네임 또는 public_id)로 V2 카드 데이터 조립.
 * 히어로 = 가장 최근 '활동한 날'의 글자수(자정에 0으로 안 비게), 뱃지 = 연속 스트릭,
 * 그래프 = 최근 14일(막대 높이=글자수, 스트릭 구간 강조). 순위는 쓰지 않는다(Phase 2).
 * 참고: 스트릭은 /user 가 주는 30일 창에서 계산 → 30일 초과 연속은 30으로 캡(런치 시엔 무의미).
 */
export async function buildData(api, seg) {
  const API = api.replace(/\/+$/, '');
  const isPid = PUBLIC_ID_RE.test(seg);
  const query = isPid ? `id=${encodeURIComponent(seg)}` : `nickname=${encodeURIComponent(seg)}`;
  const profile = await fetchJson(`${API}/user?${query}`);
  const days = profile.days || [];
  const n = days.length;
  const nick = profile.nickname || seg; // 익명 유저는 응답의 자동 닉네임을 표시명으로

  const isActive = (d) => (d?.prompts || 0) > 0; // 프롬프트 1개 이상 = 그날 활동함
  const todayIso = n ? days[n - 1].day : kstStamp().slice(0, 10);

  // 그래프 초록 구간(현재 스트릭 범위)을 days 창에서 찾는다. 오늘이 비어도 어제까지 인정(자정 유예).
  let end = n - 1;
  if (n && !isActive(days[end])) end -= 1;
  let streakLocal = 0;
  let startIdx = -1;
  for (let j = end; j >= 0; j--) {
    if (isActive(days[j])) {
      streakLocal += 1;
      startIdx = j;
    } else break;
  }
  const sinceLocal = startIdx >= 0 ? days[startIdx].day : '';
  // 표시용 스트릭 수/시작일은 /user 값(60일 창, 더 정확) 우선. days 가 없으면 위 로컬 계산으로 폴백.
  const streak = typeof profile.streak === 'number' ? profile.streak : streakLocal;
  const sinceIso = profile.streakSince || sinceLocal;

  // 히어로 = 가장 최근 활동일의 글자수(보통 오늘, 자정 직후엔 어제) → 큰 숫자가 0으로 안 비게.
  let heroIdx = -1;
  for (let j = n - 1; j >= 0; j--) {
    if (isActive(days[j])) {
      heroIdx = j;
      break;
    }
  }
  const hero = heroIdx >= 0 ? days[heroIdx] : { day: todayIso, prompts: 0, chars: 0 };
  const heroIsToday = heroIdx === n - 1;

  // 최근 14일: 막대 높이=글자수, 활동/스트릭/오늘 플래그.
  const win = days.slice(-GRAPH_DAYS);
  const offset = n - win.length;
  const series = win.map((d, i) => {
    const gi = offset + i;
    return {
      chars: d.chars || 0,
      active: isActive(d),
      streak: startIdx >= 0 && gi >= startIdx && gi <= end,
      today: gi === n - 1,
    };
  });
  const axis = win.length
    ? { l: mdLabel(win[0].day), m: mdLabel(win[Math.floor((win.length - 1) / 2)].day), r: mdLabel(win[win.length - 1].day) }
    : { l: '', m: '', r: '' };

  // 병정 초상 군복색 = 30일 합산 prompts 최다 에이전트. 없으면 null(템플릿이 claude 폴백).
  const agentSum = {};
  for (const d of days) for (const a in d.agents || {}) agentSum[a] = (agentSum[a] || 0) + (d.agents[a].prompts || 0);
  let agent = null;
  for (const a in agentSum) if (!agent || agentSum[a] > agentSum[agent]) agent = a;

  return {
    nick,
    country: profile.country || '',
    flag: profile.flag || '',
    city: profile.city || '',
    date: todayIso,
    dow: dowLabel(todayIso),
    heroChars: hero.chars || 0,
    heroPrompts: hero.prompts || 0,
    heroIsToday,
    heroDayLabel: heroIsToday ? '' : monthDayLabel(hero.day),
    streak,
    since: sinceIso ? monthDayLabel(sinceIso) : '',
    series,
    axis,
    stamp: kstStamp(),
    // ── 픽셀 병정·계급용(신규 /user 필드 없으면 null → 템플릿이 표시 생략) ──
    agent, // 주력 에이전트 id ('claude-code' 등)
    activeToday: n ? isActive(days[n - 1]) : false, // 초상 포즈(타이핑/보초)
    allTimePrompts: profile.allTime && typeof profile.allTime.prompts === 'number' ? profile.allTime.prompts : null,
  };
}

// 템플릿의 OCW_DATA 주석 마커를 실제 JSON 으로 치환한다(쿼리 인코딩 문제 회피).
export function injectTemplate(templateHtml, data) {
  return templateHtml.replace(
    /\/\*OCW_DATA\*\/[\s\S]*?\/\*END\*\//,
    `/*OCW_DATA*/${JSON.stringify(data)}/*END*/`,
  );
}

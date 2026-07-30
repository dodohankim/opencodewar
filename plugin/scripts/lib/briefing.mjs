// 세션 브리핑 — 캐시 + 문구 조립 (DESIGN.md §19).
//
// 서버(/briefing)는 숫자만 준다. 무엇을 보여줄지(우선순위)와 어떤 문장으로 쓸지(i18n)는 전부 여기 있다.
// 표시 경로는 에이전트마다 다르지만(systemMessage / notify / toast) 이 파일이 만든 "한 줄"을 그대로 쓴다.

import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { CONFIG_DIR } from './config.mjs';

export const BRIEFING_FILE = join(CONFIG_DIR, 'briefing.json');

/** 캐시가 이보다 오래되면 표시하지 않는다 — 지난 순위를 오늘인 척 보여주면 거짓말이 된다. */
export const MAX_AGE_MS = 6 * 60 * 60 * 1000;

/** 다음 계급까지 이 비율 이하로 남으면 "임박"으로 본다(§19.5 3순위). */
const NEAR_RANK_RATIO = 0.1;

/** 바로 위 경쟁자와의 격차가 이 이하일 때만 알린다 — 따라잡을 수 있어야 동기가 된다. */
const GAP_THRESHOLD = 20;

/** 계급 이름(§16). 임계값은 서버에만 있고 여기는 이름만 갖는다 — 인덱스로 매칭. */
const RANK_NAMES = {
  ko: ['이병', '일병', '상병', '병장', '하사', '중사', '상사', '소위', '대위', '소령', '대령', '장군'],
  en: [
    'Private',
    'PFC',
    'Corporal',
    'Sergeant',
    'Staff Sgt',
    'Sgt 1st Class',
    'Master Sgt',
    '2nd Lt',
    'Captain',
    'Major',
    'Colonel',
    'General',
  ],
};

/**
 * 로컬 달력 기준 날짜(YYYY-MM-DD). "하루 1회" 판정용.
 *
 * 스트릭 집계(§17)는 공용 UTC 지만 이건 표시 빈도라 **사람이 느끼는 하루**를 따라야 한다.
 * 로케일 포맷터를 쓰지 않는 건 환경마다 결과가 달라지면 안 되기 때문.
 */
export function localDay(now) {
  const d = new Date(now);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/**
 * 이 문구를 지금 띄워도 되는가 — 하루 1회, 그리고 지난번과 같은 얘기면 금지.
 *
 * 왜 세션 단위가 아닌가: 캐시 파일은 홈에 하나뿐인데 이 유저는 프로젝트별로 세션을 수십 개
 * 띄운다(실측: 85분에 서로 다른 세션 9개). "세션당 1회"는 그 패턴에서 하루 수십 번이 된다.
 *
 * 왜 문구 종류(key)까지 보나: 계급 임박·격차 같은 줄은 *변화*가 아니라 *상태*라, 조건이
 * 유지되는 몇 주 내내 숫자 하나만 바뀐 같은 문장이 매일 나온다. §19.2-3("보여줄 변화가
 * 없으면 침묵")을 지키려면 종류가 바뀌었을 때만 띄워야 한다.
 */
export function canShow(state, key, now) {
  if (!state || !key) return false;
  if (state.lastShownDay === localDay(now)) return false;
  return state.lastKey !== key;
}

export function loadBriefing() {
  try {
    if (!existsSync(BRIEFING_FILE)) return null;
    const state = JSON.parse(readFileSync(BRIEFING_FILE, 'utf8'));
    if (!state || typeof state !== 'object') return null;
    // 구버전 표시 기록 키(shownFor / shownBySession)는 버린다 — 하루 1회 가드로 대체됐다.
    const { shownFor: _a, shownBySession: _b, ...rest } = state;
    return rest;
  } catch {
    return null;
  }
}

export function saveBriefing(state) {
  // 여러 세션이 같은 파일을 동시에 쓴다 — 임시 파일 + rename 으로 반쯤 쓰인 JSON 이 읽히는 걸 막는다.
  const tmp = `${BRIEFING_FILE}.${process.pid}.tmp`;
  try {
    mkdirSync(CONFIG_DIR, { recursive: true });
    writeFileSync(tmp, JSON.stringify(state, null, 2) + '\n');
    renameSync(tmp, BRIEFING_FILE);
  } catch {
    // 캐시 저장 실패가 에이전트 사용을 막아선 안 된다
    try {
      rmSync(tmp, { force: true });
    } catch {
      // 임시 파일 정리 실패도 무시
    }
  }
}

/**
 * 표시 언어. 웹(§15)과 같은 순서로 정한다: 직접 지정 → 국가 → 로케일.
 *
 * 셸 로케일을 먼저 보면 안 된다 — macOS 기본이 `en_US.UTF-8` 이라 한국 유저도 영어가 되어버린다.
 * 서버가 IP 로 판정한 국가(users.country)가 훨씬 정확하므로 그걸 먼저 쓴다.
 */
export function detectLang(cfg, data) {
  if (cfg && (cfg.lang === 'ko' || cfg.lang === 'en')) return cfg.lang;
  const country = data && data.rank ? data.rank.countryCode : null;
  if (country) return country === 'KR' ? 'ko' : 'en';
  const env = process.env.LC_ALL || process.env.LC_MESSAGES || process.env.LANG || '';
  return /^ko/i.test(env) ? 'ko' : 'en';
}

function rankName(index, lang) {
  const names = RANK_NAMES[lang] ?? RANK_NAMES.en;
  return names[index] ?? names[names.length - 1];
}

/** 국가 코드가 있으면 "KR 7위", 없으면 "전체 7위" 형태의 앞머리. */
function placeLabel(rank, code, lang) {
  if (lang === 'ko') return code ? `${code} ${rank}위` : `전체 ${rank}위`;
  return code ? `${code} #${rank}` : `#${rank}`;
}

/**
 * 띄울 수 있는 문구 후보를 **우선순위 순서대로** 만든다. 각 항목은 `{ key, line }`.
 *
 * `key` 는 "같은 얘기인가"를 판정하는 식별자다 — 숫자가 아니라 종류로 잡는다.
 * `rank:2` 는 상병인 동안 내내 같은 key 라, 한 번 띄우면 병장을 달기 전까지 다시 안 뜬다.
 * 하나만 고르지 않고 목록으로 내는 이유는, 1순위가 "이미 본 얘기"라 막혔을 때 침묵하는 대신
 * 다음 순위로 넘어가기 위해서다.
 *
 * ⚠️ Claude Code·Codex 는 이 문구 앞에 `SessionStart says: ` 같은 접두사를 강제로 붙인다(§19.8).
 * 그래서 인사말이나 주어로 시작하지 않고 상태·지시로 바로 들어간다.
 *
 * @param data  서버 /briefing 응답
 * @param prevRank 지난번 "표시" 시점의 순위 { global, country } | null
 * @param lang 'ko' | 'en'
 */
export function briefingCandidates(data, prevRank, lang) {
  if (!data) return [];
  const ko = lang === 'ko';
  const out = [];

  // 1순위 — 닉네임 미등록. 익명이면 리더보드에 이름이 없어 재방문·공유 동기가 0 이다.
  if (!data.registered) {
    out.push({
      key: 'nick',
      line: ko
        ? '익명으로 집계 중 — /ocw nickname <이름> 으로 리더보드에 이름을 올리세요'
        : 'Tracking anonymously — run /ocw nickname <name> to claim your spot',
    });
  }

  // 2순위 — 스트릭이 걸려 있는데 오늘 아직 미달(손실 회피가 가장 강한 리텐션 신호).
  // key 에 연속일수를 넣는다 — 매일 달라지므로 이 줄만은 하루 한 번 다시 뜬다(그게 맞다).
  const streak = data.streak ?? {};
  const today = data.today ?? {};
  if ((streak.current ?? 0) >= 3 && !today.qualified) {
    const needPrompts = Math.max(0, (streak.minPrompts ?? 0) - (today.prompts ?? 0));
    const line =
      needPrompts > 0
        ? ko
          ? `🔥 ${streak.current}일 연속 · 오늘 ${today.prompts ?? 0}/${streak.minPrompts} — ${needPrompts}개 더 치면 유지`
          : `🔥 ${streak.current}-day streak · ${today.prompts ?? 0}/${streak.minPrompts} today — ${needPrompts} more to keep it`
        : // 프롬프트 수는 채웠는데 글자수가 모자란 경우
          ko
          ? `🔥 ${streak.current}일 연속 · 오늘 ${today.chars ?? 0}자 — ${streak.minChars}자 넘겨야 유지`
          : `🔥 ${streak.current}-day streak · ${today.chars ?? 0} chars — need over ${streak.minChars} to keep it`;
    out.push({ key: `streak:${streak.current}`, line });
  }

  // 3순위 — 다음 계급 임박. 끝이 보이는 목표가 행동을 끌어낸다.
  // key 는 계급 인덱스 — 상병인 동안 계속 임박 상태라도 딱 한 번만 알린다.
  const rt = data.rankTitle ?? {};
  if (rt.remaining != null && rt.span > 0 && rt.remaining <= rt.span * NEAR_RANK_RATIO) {
    const next = rankName((rt.index ?? 0) + 1, lang);
    out.push({
      key: `rank:${rt.index ?? 0}`,
      line: ko ? `🎖 ${next}까지 ${rt.remaining} 프롬프트` : `🎖 ${rt.remaining} prompts to ${next}`,
    });
  }

  // 4순위 — 지난 브리핑 대비 순위 변동. 국가 순위를 우선한다(같은 리그라 체감이 크다).
  const rank = data.rank ?? {};
  const scope = rank.country != null ? 'country' : 'global';
  const cur = rank[scope];
  const prev = prevRank ? prevRank[scope] : null;
  if (cur != null && prev != null && cur !== prev) {
    const up = prev - cur; // 양수면 상승
    const arrow = up > 0 ? `↑${up}` : `↓${-up}`;
    out.push({
      key: `move:${scope}:${cur}`,
      line: `${placeLabel(cur, scope === 'country' ? rank.countryCode : null, lang)} (${arrow})`,
    });
  }

  // 5순위 — 바로 위 경쟁자와의 격차. 리더보드 전체보다 이 한 명이 더 강하게 작동한다.
  // key 는 상대 닉네임 — 같은 사람을 쫓는 동안 격차 숫자만 바뀌는 반복을 막는다.
  const ahead = data.ahead;
  if (cur != null && ahead && ahead.gap > 0 && ahead.gap <= GAP_THRESHOLD) {
    const place = placeLabel(cur, scope === 'country' ? rank.countryCode : null, lang);
    out.push({
      key: `gap:${ahead.nickname}`,
      line: ko
        ? `${place} · ${cur - 1}위 ${ahead.nickname} 와 ${ahead.gap} 차이`
        : `${place} · ${ahead.gap} behind #${cur - 1} ${ahead.nickname}`,
    });
  }

  return out;
}

/**
 * 지금 띄울 문구 하나. 없으면 null(침묵).
 * 우선순위대로 훑되 하루 1회·같은 얘기 금지 가드에 걸리는 후보는 건너뛴다.
 */
export function pickBriefing(state, data, prevRank, lang, now) {
  for (const c of briefingCandidates(data, prevRank, lang)) {
    if (canShow(state, c.key, now)) return c;
  }
  // 보여줄 변화가 없으면 침묵한다. 매 세션 배너는 3일이면 소음이 된다.
  return null;
}

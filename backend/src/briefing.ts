// 세션 브리핑(DESIGN.md §19) 계산 — 전부 순수 함수라 단위 테스트로 검증한다.
//
// 비용 원칙: 순위·이웃은 이미 있는 리더보드 스냅샷(KV)에서 뽑고, 개인 지표(계급·스트릭·오늘)는
// "그 유저의 daily_stats" 한 쿼리로만 구한다. 세션당 1회 호출이라 이 정도면 한도에 영향이 없다.

import type { RankEntry, Snapshot } from './types';
import { STREAK_MIN_CHARS, STREAK_MIN_PROMPTS, computeStreak, qualifies, type DayStat } from './streak';
import { utcToday } from './time';

/**
 * 계급 임계값(§16) — 누적 prompts 하한. 인덱스가 곧 계급이다.
 * ⚠️ 웹 `web/index.html`·OG `web/og-user.html` 의 RANKS 와 **같은 순서·같은 값**이어야 한다.
 * 브리핑은 계급 "이름"을 보내지 않고 이 인덱스만 보낸다 → 클라이언트(track.mjs)는 이름 배열만
 * 가지면 되고 임계값을 또 복제하지 않는다.
 */
export const RANK_MINS = [0, 200, 1000, 3000, 7000, 15000, 30000, 60000, 120000, 250000, 500000, 1000000];

/** 누적 prompts → 계급 인덱스(0=이병 … 11=장군). */
export function rankIndexOf(prompts: number): number {
  let i = 0;
  while (i + 1 < RANK_MINS.length && prompts >= RANK_MINS[i + 1]) i++;
  return i;
}

/** 다음 계급까지 남은 prompts. 최고 계급이면 null. */
export function remainingToNextRank(prompts: number): number | null {
  const i = rankIndexOf(prompts);
  if (i + 1 >= RANK_MINS.length) return null;
  return Math.max(0, RANK_MINS[i + 1] - prompts);
}

/**
 * 현재 계급 구간의 크기(이번 계급 하한 → 다음 계급 하한). 최고 계급이면 null.
 * 클라이언트가 "다음 계급 임박(≤10%)"을 판정하려면 remaining 만으로는 부족하고 분모가 필요하다.
 * 임계값 자체는 서버에만 두고 비율 판정만 클라이언트가 하도록 이 값을 함께 내려준다.
 */
export function rankSpan(prompts: number): number | null {
  const i = rankIndexOf(prompts);
  if (i + 1 >= RANK_MINS.length) return null;
  return RANK_MINS[i + 1] - RANK_MINS[i];
}

export interface Briefing {
  /** 닉네임을 직접 등록했는지. false면 브리핑 1순위가 "닉네임 등록 유도"가 된다(§19.5). */
  registered: boolean;
  allTime: { prompts: number };
  today: { prompts: number; chars: number; qualified: boolean };
  /** minPrompts/minChars 는 "친 날" 요건(§17). 클라이언트가 "오늘 3/10" 같은 문구를 만들 때 쓴다. */
  streak: { current: number; longest: number; minPrompts: number; minChars: number };
  /** index=계급(0=이병), remaining=다음 계급까지 남은 prompts, span=현재 구간 크기(비율 판정용). */
  rankTitle: { index: number; remaining: number | null; span: number | null };
  /** 스냅샷 top-N 밖이면 전부 null (순위를 모른다 ≠ 순위가 없다). */
  rank: { global: number | null; country: number | null; countryCode: string | null };
  /** 바로 위 경쟁자. 같은 국가 우선, 없으면 글로벌 기준. */
  ahead: { nickname: string; gap: number } | null;
  generatedAt: number;
}

export interface BuildBriefingInput {
  snapshot: Snapshot;
  /** 스냅샷 항목 매칭 키. RankEntry 에는 user_id(비밀키)가 없으므로 public_id 로 찾는다. */
  publicId: string | null;
  country: string | null;
  registered: boolean;
  /** 유저의 UTC 일자별 집계(daily_stats 를 day 단위로 agent 합산). */
  dayStats: DayStat[];
  now: number;
}

/** 스냅샷 'all' 보드(전 기간 prompts)에서 내 위치·국가순위·바로 위 경쟁자를 뽑는다. */
function positionIn(
  board: RankEntry[],
  publicId: string | null,
  country: string | null,
): Pick<Briefing, 'rank' | 'ahead'> {
  const idx = publicId ? board.findIndex((e) => e.public_id === publicId) : -1;
  if (idx < 0) {
    return { rank: { global: null, country: null, countryCode: country }, ahead: null };
  }
  const me = board[idx];

  // 국가 순위: 정렬된 보드에서 나까지 중 같은 국가 인원 수가 곧 내 국가 등수.
  const countryRank = country ? board.slice(0, idx + 1).filter((e) => e.country === country).length : null;

  // 바로 위: 같은 국가 우선(같은 리그라 체감이 크다), 없으면 글로벌 바로 위.
  let aheadEntry: RankEntry | null = null;
  if (country) {
    for (let i = idx - 1; i >= 0; i--) {
      if (board[i].country === country) {
        aheadEntry = board[i];
        break;
      }
    }
  }
  if (!aheadEntry && idx > 0) aheadEntry = board[idx - 1];

  return {
    rank: { global: me.rank, country: countryRank, countryCode: country },
    ahead: aheadEntry
      ? { nickname: aheadEntry.nickname ?? '', gap: Math.max(0, aheadEntry.prompts - me.prompts) }
      : null,
  };
}

export function buildBriefing(input: BuildBriefingInput): Briefing {
  const { snapshot, publicId, country, registered, dayStats, now } = input;

  const allTimePrompts = dayStats.reduce((sum, d) => sum + d.prompts, 0);

  const todayKey = utcToday(now);
  const todayRow = dayStats.find((d) => d.day === todayKey);
  const todayPrompts = todayRow?.prompts ?? 0;
  const todayChars = todayRow?.chars ?? 0;

  const streak = computeStreak(dayStats, now);
  const { rank, ahead } = positionIn(snapshot.boards?.all?.prompts ?? [], publicId, country);

  return {
    registered,
    allTime: { prompts: allTimePrompts },
    today: { prompts: todayPrompts, chars: todayChars, qualified: qualifies(todayPrompts, todayChars) },
    streak: {
      current: streak.current,
      longest: streak.longest,
      minPrompts: STREAK_MIN_PROMPTS,
      minChars: STREAK_MIN_CHARS,
    },
    rankTitle: {
      index: rankIndexOf(allTimePrompts),
      remaining: remainingToNextRank(allTimePrompts),
      span: rankSpan(allTimePrompts),
    },
    rank,
    ahead,
    generatedAt: now,
  };
}

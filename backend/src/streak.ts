// 스트릭(연속 기록) 계산 — DESIGN.md §17. 공용 UTC 하루 기준(로컬 보정 안 함).
// 리더보드(§7)·계급(§16)과 같은 UTC 시계를 써서 "하루" 정의를 전 기능에서 통일한다.
import { dayNumFromStr, dayStr, utcDayNum } from './time';

/** "친 날" 최소 프롬프트 수(이상, ≥). */
export const STREAK_MIN_PROMPTS = 10;
/** "친 날" 최소 총 글자수(초과, >). 500 자신은 미달. */
export const STREAK_MIN_CHARS = 500;

/** 하루 집계(prompts, chars)가 "친 날" 조건을 만족하는가(둘 다, AND). */
export function qualifies(prompts: number, chars: number): boolean {
  return prompts >= STREAK_MIN_PROMPTS && chars > STREAK_MIN_CHARS;
}

/** UTC 일자별 집계 한 행(daily_stats 를 day 단위로 agent 합산한 결과). */
export interface DayStat {
  day: string; // UTC 'YYYY-MM-DD'
  prompts: number;
  chars: number;
}

export interface StreakResult {
  current: number; // 현재 연속(오늘/어제까지 유예). 끊겼으면 0
  longest: number; // 역대 최장 연속
  since: string | null; // 현재 연속 시작 UTC 'YYYY-MM-DD' | null
}

/**
 * daily_stats 를 day 단위로 합산한 목록에서 현재·최장 스트릭을 구한다(§17).
 * - 친 날 = qualifies(prompts, chars)
 * - current 는 마지막 친 날이 오늘 또는 어제(UTC)일 때만 살아있다(자정 유예).
 *   오늘이 아직 미달이어도 "진행 중"으로 보아 어제까지의 연속을 인정한다.
 */
export function computeStreak(rows: DayStat[], nowMs: number): StreakResult {
  const today = utcDayNum(nowMs);
  // 조건 통과 날짜만 day-number 로 바꿔 오름차순 정렬. (GROUP BY day 라 중복 일자는 없다)
  const days = rows
    .filter((r) => qualifies(r.prompts, r.chars))
    .map((r) => dayNumFromStr(r.day))
    .sort((a, b) => a - b);
  if (days.length === 0) return { current: 0, longest: 0, since: null };

  // 최장: 연속 런의 최대 길이.
  let longest = 1;
  let run = 1;
  for (let i = 1; i < days.length; i++) {
    run = days[i] === days[i - 1] + 1 ? run + 1 : 1;
    if (run > longest) longest = run;
  }

  // 현재: 마지막 친 날이 오늘/어제가 아니면 끊긴 것.
  const last = days[days.length - 1];
  if (last !== today && last !== today - 1) return { current: 0, longest, since: null };
  let current = 1;
  let sinceNum = last;
  for (let i = days.length - 2; i >= 0; i--) {
    if (days[i] !== days[i + 1] - 1) break;
    current += 1;
    sinceNum = days[i];
  }
  return { current, longest, since: dayStr(sinceNum) };
}

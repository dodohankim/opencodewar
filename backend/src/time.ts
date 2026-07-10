// KST(UTC+9, 서머타임 없음) 기준 날짜 계산 유틸.
// Worker는 UTC로 동작하므로 offset을 더해 정수 day-number로 환산해 다룬다.

const DAY_MS = 86_400_000;
const KST_OFFSET_MS = 9 * 60 * 60 * 1000;

/** epoch ms → KST 기준 "1970-01-01부터의 일수". */
export function kstDayNum(ts: number): number {
  return Math.floor((ts + KST_OFFSET_MS) / DAY_MS);
}

/** day-number → 'YYYY-MM-DD'. (day-number * DAY_MS는 해당 KST 날짜의 UTC 자정) */
export function dayStr(dayNum: number): string {
  return new Date(dayNum * DAY_MS).toISOString().slice(0, 10);
}

/** epoch ms → KST 오늘 'YYYY-MM-DD'. */
export function kstToday(ts: number): string {
  return dayStr(kstDayNum(ts));
}

/** day-number의 요일. 0=일 .. 6=토. (1970-01-01은 목요일=4) */
export function dowOf(dayNum: number): number {
  return (((dayNum % 7) + 4) % 7 + 7) % 7;
}

/** 해당 주(월~일)의 월요일 day-number. */
export function mondayOf(dayNum: number): number {
  return dayNum - ((dowOf(dayNum) + 6) % 7);
}

/** epoch ms가 속한 주의 월~일 7일치 'YYYY-MM-DD' 배열. */
export function weekDays(ts: number): string[] {
  const mon = mondayOf(kstDayNum(ts));
  return Array.from({ length: 7 }, (_, i) => dayStr(mon + i));
}

/** epoch ms가 속한 주의 금·토·일 3일치 'YYYY-MM-DD' 배열. */
export function weekendDays(ts: number): string[] {
  const mon = mondayOf(kstDayNum(ts));
  return [dayStr(mon + 4), dayStr(mon + 5), dayStr(mon + 6)];
}

/** epoch ms 기준 최근 n일(KST)의 'YYYY-MM-DD' 배열. 오래된 날 → 오늘 순. */
export function recentDays(ts: number, n: number): string[] {
  const today = kstDayNum(ts);
  return Array.from({ length: n }, (_, i) => dayStr(today - (n - 1 - i)));
}

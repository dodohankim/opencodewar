// 공용 시계 = UTC. 리더보드(일간·주간·주말·월간)의 기간 경계를 전 세계 동일하게 잡기 위함이다.
// (경쟁은 모두의 '오늘'이 같은 구간이어야 공정하다.) 개인 상세 페이지의 로컬 시간 처리는 tz.ts 참고.

const DAY_MS = 86_400_000;

/** epoch ms → UTC 기준 "1970-01-01부터의 일수". */
export function utcDayNum(ts: number): number {
  return Math.floor(ts / DAY_MS);
}

/** day-number → 'YYYY-MM-DD'. (day-number * DAY_MS 는 그 UTC 날짜의 자정) */
export function dayStr(dayNum: number): string {
  return new Date(dayNum * DAY_MS).toISOString().slice(0, 10);
}

/** epoch ms → UTC 오늘 'YYYY-MM-DD'. */
export function utcToday(ts: number): string {
  return dayStr(utcDayNum(ts));
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
  const mon = mondayOf(utcDayNum(ts));
  return Array.from({ length: 7 }, (_, i) => dayStr(mon + i));
}

/** epoch ms가 속한 주의 금·토·일 3일치 'YYYY-MM-DD' 배열. */
export function weekendDays(ts: number): string[] {
  const mon = mondayOf(utcDayNum(ts));
  return [dayStr(mon + 4), dayStr(mon + 5), dayStr(mon + 6)];
}

/** epoch ms가 속한 UTC 달의 1일~말일 'YYYY-MM-DD' 배열. */
export function monthDays(ts: number): string[] {
  const today = utcDayNum(ts);
  const d = new Date(today * DAY_MS);
  const year = d.getUTCFullYear();
  const month = d.getUTCMonth();
  const firstDayNum = today - (d.getUTCDate() - 1);
  const count = new Date(Date.UTC(year, month + 1, 0)).getUTCDate(); // 다음달 0일 = 이번달 말일
  return Array.from({ length: count }, (_, i) => dayStr(firstDayNum + i));
}

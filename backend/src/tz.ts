// IANA 타임존 인식 유틸 — 상세 페이지를 "그 유저의 로컬 시간"으로 재집계할 때 쓴다.
// events 는 UTC epoch ms 로 저장되므로, 어떤 IANA TZ 로든 로컬 일자/시각을 뽑아 버킷팅한다.
// 고정 오프셋(+9 등)은 DST(서머타임)에서 틀리므로, Cloudflare Workers 가 지원하는
// Intl.DateTimeFormat({ timeZone }) 로 순간마다 실제 오프셋을 구해 처리한다.

const DAY_MS = 86_400_000;

// Intl.DateTimeFormat 은 생성 비용이 커서(이벤트 행마다 만들면 CPU 예산을 잠식 — 무료 티어 10ms)
// TZ별로 한 번만 만들어 재사용한다. TZ 값은 cf.timezone/users.timezone 유래라 종류가 유한하다.
const dtfCache = new Map<string, Intl.DateTimeFormat>();
function dtf(tz: string): Intl.DateTimeFormat {
  let f = dtfCache.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hourCycle: 'h23',
    });
    dtfCache.set(tz, f);
  }
  return f;
}

/** IANA 타임존 문자열이 유효한지(Intl 이 인식하는지). 유효하면 포매터도 캐시에 남는다. */
export function isValidTimezone(tz: unknown): tz is string {
  if (typeof tz !== 'string' || !tz) return false;
  try {
    dtf(tz);
    return true;
  } catch {
    return false;
  }
}

/** 순간 ts(UTC ms)에서 tz 의 (로컬 벽시계 − UTC) 오프셋 ms. local = UTC + offset. DST 반영. */
export function tzOffsetMs(ts: number, tz: string): number {
  const parts = dtf(tz).formatToParts(new Date(ts));
  const g = (t: string) => Number(parts.find((p) => p.type === t)!.value);
  let h = g('hour');
  if (h === 24) h = 0; // 일부 환경의 자정 표기 방어
  const asUtc = Date.UTC(g('year'), g('month') - 1, g('day'), h, g('minute'), g('second'));
  return asUtc - ts;
}

/** ts(UTC ms) → tz 로컬 'YYYY-MM-DD'. */
export function localDay(ts: number, tz: string): string {
  return new Date(ts + tzOffsetMs(ts, tz)).toISOString().slice(0, 10);
}

/** ts(UTC ms) → tz 로컬 시(0~23). */
export function localHour(ts: number, tz: string): number {
  return new Date(ts + tzOffsetMs(ts, tz)).getUTCHours();
}

/** 로컬 날짜(y, m0-based, d)의 시작 UTC ms. 오프셋을 근처에서 두 번 재서 DST 경계를 보정. */
function zonedStart(y: number, m0: number, d: number, tz: string): number {
  const guess = Date.UTC(y, m0, d);
  const start = guess - tzOffsetMs(guess, tz);
  return guess - tzOffsetMs(start, tz);
}

/** 로컬 날짜 'YYYY-MM-DD'(tz)에 해당하는 UTC 범위 [start, end). DST 로 23/25h 여도 정확. */
export function zonedDayRange(day: string, tz: string): { start: number; end: number } {
  const [y, m, d] = day.split('-').map(Number);
  return { start: zonedStart(y, m - 1, d, tz), end: zonedStart(y, m - 1, d + 1, tz) };
}

/** now(UTC ms) 기준, tz 로컬 최근 n일의 'YYYY-MM-DD' 배열. 오래된 날 → 오늘 순. */
export function recentLocalDays(now: number, tz: string, n: number): string[] {
  const [y, m, d] = localDay(now, tz).split('-').map(Number);
  const base = Date.UTC(y, m - 1, d); // 날짜만 다루는 달력 산술(UTC 자정 기준) — DST 무관
  return Array.from({ length: n }, (_, i) => new Date(base - (n - 1 - i) * DAY_MS).toISOString().slice(0, 10));
}

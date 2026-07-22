import { describe, expect, it } from 'vitest';
import { isValidTimezone, localDay, localHour, recentLocalDays, tzOffsetMs, zonedDayRange } from '../src/tz';

const H = 3_600_000;
const DAY = 86_400_000;

describe('isValidTimezone', () => {
  it('유효한 IANA TZ 만 통과', () => {
    expect(isValidTimezone('Asia/Seoul')).toBe(true);
    expect(isValidTimezone('America/Los_Angeles')).toBe(true);
    expect(isValidTimezone('UTC')).toBe(true);
    expect(isValidTimezone('Not/AZone')).toBe(false);
    expect(isValidTimezone('')).toBe(false);
    expect(isValidTimezone(null)).toBe(false);
    expect(isValidTimezone(123)).toBe(false);
  });
});

describe('localDay / localHour (DST 포함)', () => {
  it('Asia/Seoul (UTC+9, DST 없음)', () => {
    const noon = Date.UTC(2026, 6, 8, 3, 0, 0); // 12:00 KST
    expect(localDay(noon, 'Asia/Seoul')).toBe('2026-07-08');
    expect(localHour(noon, 'Asia/Seoul')).toBe(12);

    const cross = Date.UTC(2026, 6, 8, 15, 30, 0); // 익일 00:30 KST
    expect(localDay(cross, 'Asia/Seoul')).toBe('2026-07-09');
    expect(localHour(cross, 'Asia/Seoul')).toBe(0);
  });

  it('America/Los_Angeles: 같은 UTC 시각도 DST 여부로 로컬 시가 다르다', () => {
    // 여름(PDT, UTC-7): 2026-07-08 06:00Z → 07-07 23:00
    const summer = Date.UTC(2026, 6, 8, 6, 0, 0);
    expect(localDay(summer, 'America/Los_Angeles')).toBe('2026-07-07');
    expect(localHour(summer, 'America/Los_Angeles')).toBe(23);

    // 겨울(PST, UTC-8): 2026-01-08 06:00Z → 01-07 22:00
    const winter = Date.UTC(2026, 0, 8, 6, 0, 0);
    expect(localDay(winter, 'America/Los_Angeles')).toBe('2026-01-07');
    expect(localHour(winter, 'America/Los_Angeles')).toBe(22);
  });
});

describe('tzOffsetMs', () => {
  it('Seoul 은 항상 +9h', () => {
    expect(tzOffsetMs(Date.UTC(2026, 6, 8, 3, 0, 0), 'Asia/Seoul')).toBe(9 * H);
  });
  it('LA 는 DST 로 -7h(여름)/-8h(겨울)', () => {
    expect(tzOffsetMs(Date.UTC(2026, 6, 8, 6, 0, 0), 'America/Los_Angeles')).toBe(-7 * H);
    expect(tzOffsetMs(Date.UTC(2026, 0, 8, 6, 0, 0), 'America/Los_Angeles')).toBe(-8 * H);
  });
});

describe('zonedDayRange', () => {
  it('Asia/Seoul 하루 = 전날 15:00Z ~ 당일 15:00Z', () => {
    const r = zonedDayRange('2026-07-08', 'Asia/Seoul');
    expect(r.start).toBe(Date.UTC(2026, 6, 7, 15, 0, 0));
    expect(r.end).toBe(Date.UTC(2026, 6, 8, 15, 0, 0));
    expect(r.end - r.start).toBe(DAY);
  });

  it('DST 시작일(LA 2026-03-08)은 23시간', () => {
    const r = zonedDayRange('2026-03-08', 'America/Los_Angeles');
    // 03-08 00:00 PST(-8) = 08:00Z, 03-09 00:00 PDT(-7) = 07:00Z → 23h
    expect(r.start).toBe(Date.UTC(2026, 2, 8, 8, 0, 0));
    expect(r.end).toBe(Date.UTC(2026, 2, 9, 7, 0, 0));
    expect(r.end - r.start).toBe(23 * H);
  });

  it('DST 종료일(LA 2026-11-01)은 25시간', () => {
    const r = zonedDayRange('2026-11-01', 'America/Los_Angeles');
    // 11-01 00:00 PDT(-7) = 07:00Z, 11-02 00:00 PST(-8) = 08:00Z → 25h
    expect(r.end - r.start).toBe(25 * H);
  });
});

describe('recentLocalDays', () => {
  it('로컬 최근 n일을 오래된→오늘 순으로', () => {
    const now = Date.UTC(2026, 6, 8, 3, 0, 0); // Seoul 2026-07-08
    expect(recentLocalDays(now, 'Asia/Seoul', 3)).toEqual(['2026-07-06', '2026-07-07', '2026-07-08']);
  });

  it('TZ 에 따라 "오늘"이 다르다', () => {
    const now = Date.UTC(2026, 6, 8, 6, 0, 0); // Seoul 07-08 15:00, LA 07-07 23:00
    expect(recentLocalDays(now, 'Asia/Seoul', 1)).toEqual(['2026-07-08']);
    expect(recentLocalDays(now, 'America/Los_Angeles', 1)).toEqual(['2026-07-07']);
  });
});

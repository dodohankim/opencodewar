import { describe, expect, it } from 'vitest';
import { kstToday, mondayOf, kstDayNum, weekDays, weekendDays, dowOf } from '../src/time';

// 기준: 2026-07-08T03:00:00Z = 2026-07-08 12:00 KST (수요일)
const WED_NOON_KST = Date.UTC(2026, 6, 8, 3, 0, 0);

describe('KST 날짜 계산', () => {
  it('kstToday: UTC ts를 KST 날짜로 환산한다', () => {
    expect(kstToday(WED_NOON_KST)).toBe('2026-07-08');
  });

  it('KST 자정 경계를 올바르게 넘긴다', () => {
    // 2026-07-08 23:59 KST → 2026-07-08
    expect(kstToday(Date.UTC(2026, 6, 8, 14, 59, 0))).toBe('2026-07-08');
    // 2026-07-09 00:00 KST → 2026-07-09
    expect(kstToday(Date.UTC(2026, 6, 8, 15, 0, 0))).toBe('2026-07-09');
  });

  it('dowOf: 요일 계산 (0=일)', () => {
    expect(dowOf(kstDayNum(WED_NOON_KST))).toBe(3); // 수요일
  });

  it('mondayOf: 해당 주 월요일', () => {
    expect(mondayOf(kstDayNum(WED_NOON_KST))).toBe(kstDayNum(Date.UTC(2026, 6, 6, 3, 0, 0)));
  });

  it('weekDays: 월~일 7일', () => {
    expect(weekDays(WED_NOON_KST)).toEqual([
      '2026-07-06', '2026-07-07', '2026-07-08', '2026-07-09', '2026-07-10', '2026-07-11', '2026-07-12',
    ]);
  });

  it('weekendDays: 이번 주 금·토·일', () => {
    expect(weekendDays(WED_NOON_KST)).toEqual(['2026-07-10', '2026-07-11', '2026-07-12']);
  });

  it('일요일도 같은 주(직전 월요일 시작)에 속한다', () => {
    // 2026-07-12는 일요일 → 월요일은 2026-07-06
    const sun = Date.UTC(2026, 6, 12, 3, 0, 0);
    expect(weekDays(sun)[0]).toBe('2026-07-06');
    expect(weekendDays(sun)).toEqual(['2026-07-10', '2026-07-11', '2026-07-12']);
  });
});

import { describe, expect, it } from 'vitest';
import { utcToday, mondayOf, utcDayNum, weekDays, weekendDays, dowOf, monthDays } from '../src/time';

// 기준: 2026-07-08T12:00:00Z (수요일, UTC 정오)
const WED = Date.UTC(2026, 6, 8, 12, 0, 0);

describe('UTC 날짜 계산 (공용 시계 = 리더보드)', () => {
  it('utcToday: UTC 날짜로 환산한다', () => {
    expect(utcToday(WED)).toBe('2026-07-08');
  });

  it('UTC 자정 경계를 올바르게 넘긴다', () => {
    expect(utcToday(Date.UTC(2026, 6, 8, 23, 59, 0))).toBe('2026-07-08');
    expect(utcToday(Date.UTC(2026, 6, 9, 0, 0, 0))).toBe('2026-07-09');
  });

  it('dowOf: 요일 계산 (0=일)', () => {
    expect(dowOf(utcDayNum(WED))).toBe(3); // 수요일
  });

  it('mondayOf: 해당 주 월요일', () => {
    expect(mondayOf(utcDayNum(WED))).toBe(utcDayNum(Date.UTC(2026, 6, 6, 12, 0, 0)));
  });

  it('weekDays: 월~일 7일', () => {
    expect(weekDays(WED)).toEqual([
      '2026-07-06', '2026-07-07', '2026-07-08', '2026-07-09', '2026-07-10', '2026-07-11', '2026-07-12',
    ]);
  });

  it('weekendDays: 이번 주 금·토·일', () => {
    expect(weekendDays(WED)).toEqual(['2026-07-10', '2026-07-11', '2026-07-12']);
  });

  it('일요일도 같은 주(직전 월요일 시작)에 속한다', () => {
    const sun = Date.UTC(2026, 6, 12, 12, 0, 0); // 2026-07-12는 일요일
    expect(weekDays(sun)[0]).toBe('2026-07-06');
    expect(weekendDays(sun)).toEqual(['2026-07-10', '2026-07-11', '2026-07-12']);
  });

  it('monthDays: 해당 달의 1일~말일 (31일 달)', () => {
    const days = monthDays(WED); // 2026-07
    expect(days).toHaveLength(31);
    expect(days[0]).toBe('2026-07-01');
    expect(days[30]).toBe('2026-07-31');
  });

  it('monthDays: 말일 경계에서도 그 달 전체', () => {
    const lastDay = Date.UTC(2026, 6, 31, 23, 0, 0);
    expect(monthDays(lastDay)[0]).toBe('2026-07-01');
    expect(monthDays(lastDay).at(-1)).toBe('2026-07-31');
  });

  it('monthDays: 2월(윤년/평년) 일수', () => {
    expect(monthDays(Date.UTC(2026, 1, 15, 12, 0, 0))).toHaveLength(28); // 2026 평년
    expect(monthDays(Date.UTC(2028, 1, 15, 12, 0, 0))).toHaveLength(29); // 2028 윤년
  });

  it('monthDays: 30일 달', () => {
    const days = monthDays(Date.UTC(2026, 3, 10, 12, 0, 0)); // 2026-04
    expect(days).toHaveLength(30);
    expect(days.at(-1)).toBe('2026-04-30');
  });
});

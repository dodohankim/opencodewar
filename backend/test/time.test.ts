import { describe, expect, it } from 'vitest';
import {
  kstToday,
  mondayOf,
  kstDayNum,
  weekDays,
  weekendDays,
  dowOf,
  recentDays,
  monthDays,
  kstHour,
  kstDayRange,
} from '../src/time';

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

  it('recentDays: 최근 n일을 오래된→오늘 순으로, 마지막이 오늘', () => {
    const days = recentDays(WED_NOON_KST, 30);
    expect(days).toHaveLength(30);
    expect(days[29]).toBe('2026-07-08'); // 오늘(KST)
    expect(days[0]).toBe('2026-06-09'); // 29일 전
    // 인접일은 하루 간격, 오름차순
    expect(days[28]).toBe('2026-07-07');
    for (let i = 1; i < days.length; i++) {
      expect(days[i] > days[i - 1]).toBe(true);
    }
  });

  it('recentDays: n=1이면 오늘 하루만', () => {
    expect(recentDays(WED_NOON_KST, 1)).toEqual(['2026-07-08']);
  });

  it('monthDays: 해당 달의 1일~말일 (31일 달)', () => {
    const days = monthDays(WED_NOON_KST); // 2026-07
    expect(days).toHaveLength(31);
    expect(days[0]).toBe('2026-07-01');
    expect(days[30]).toBe('2026-07-31');
  });

  it('monthDays: 말일 경계에서도 그 달 전체', () => {
    // 2026-07-31 23:00 KST → 여전히 7월
    const lastDay = Date.UTC(2026, 6, 31, 14, 0, 0);
    expect(monthDays(lastDay)[0]).toBe('2026-07-01');
    expect(monthDays(lastDay).at(-1)).toBe('2026-07-31');
  });

  it('monthDays: 2월(윤년/평년) 일수', () => {
    expect(monthDays(Date.UTC(2026, 1, 15, 3, 0, 0))).toHaveLength(28); // 2026 평년
    expect(monthDays(Date.UTC(2028, 1, 15, 3, 0, 0))).toHaveLength(29); // 2028 윤년
  });

  it('monthDays: 30일 달', () => {
    const days = monthDays(Date.UTC(2026, 3, 10, 3, 0, 0)); // 2026-04
    expect(days).toHaveLength(30);
    expect(days.at(-1)).toBe('2026-04-30');
  });
});

describe('KST 시간(hour) 계산', () => {
  it('kstHour: UTC ts를 KST 시(0~23)로 환산한다', () => {
    expect(kstHour(WED_NOON_KST)).toBe(12); // 12:00 KST
    expect(kstHour(Date.UTC(2026, 6, 8, 0, 0, 0))).toBe(9); // 00:00 UTC = 09:00 KST
    expect(kstHour(Date.UTC(2026, 6, 8, 15, 30, 0))).toBe(0); // 15:30 UTC = 익일 00:30 KST
    expect(kstHour(Date.UTC(2026, 6, 8, 14, 59, 59))).toBe(23); // 23:59 KST
  });

  it('kstDayRange: KST 하루의 UTC ms 범위 [start, end)', () => {
    const r = kstDayRange('2026-07-08')!;
    // KST 자정 = 전날 15:00 UTC
    expect(r.start).toBe(Date.UTC(2026, 6, 7, 15, 0, 0));
    expect(r.end).toBe(Date.UTC(2026, 6, 8, 15, 0, 0));
    expect(r.end - r.start).toBe(86_400_000);
  });

  it('kstDayRange: 범위·시(hour) 공식이 서로 정합한다', () => {
    const r = kstDayRange('2026-07-08')!;
    // 범위 시작은 그 날 KST 0시, 끝 직전은 23시.
    expect(kstHour(r.start)).toBe(0);
    expect(kstHour(r.end - 1)).toBe(23);
    // 범위 안의 모든 이벤트는 같은 KST 날짜로 환산된다.
    expect(kstToday(r.start)).toBe('2026-07-08');
    expect(kstToday(r.end - 1)).toBe('2026-07-08');
  });

  it('kstDayRange: 형식 오류면 null', () => {
    expect(kstDayRange('not-a-date')).toBeNull();
  });
});

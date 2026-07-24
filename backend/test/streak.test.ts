import { describe, expect, it } from 'vitest';
import { computeStreak, qualifies, STREAK_MIN_PROMPTS, STREAK_MIN_CHARS } from '../src/streak';

// 기준 오늘: 2026-07-24T12:00:00Z (UTC 정오)
const TODAY = Date.UTC(2026, 6, 24, 12, 0, 0);
const OK = { prompts: STREAK_MIN_PROMPTS, chars: STREAK_MIN_CHARS + 1 }; // 친 날 최소 통과값

describe('qualifies — "친 날" 조건 (프롬프트 ≥10 AND 글자수 >500)', () => {
  it('둘 다 만족해야 참', () => {
    expect(qualifies(10, 501)).toBe(true);
    expect(qualifies(50, 5000)).toBe(true);
  });

  it('경계: 프롬프트 10 미만이면 거짓', () => {
    expect(qualifies(9, 100000)).toBe(false);
  });

  it('경계: 글자수는 초과(>500)여야 — 정확히 500은 미달', () => {
    expect(qualifies(10, 500)).toBe(false);
    expect(qualifies(10, 501)).toBe(true);
  });

  it('AND 결합: 한쪽만 만족하면 거짓 ("ok" 10번 farming 차단)', () => {
    expect(qualifies(10, 20)).toBe(false); // 프롬프트만
    expect(qualifies(3, 5000)).toBe(false); // 글자수만
  });
});

describe('computeStreak — 현재/최장 (공용 UTC, §17)', () => {
  it('데이터 없으면 모두 0', () => {
    expect(computeStreak([], TODAY)).toEqual({ current: 0, longest: 0, since: null });
  });

  it('오늘까지 연속 3일이면 current=3, since=시작일', () => {
    const rows = [
      { day: '2026-07-22', ...OK },
      { day: '2026-07-23', ...OK },
      { day: '2026-07-24', ...OK },
    ];
    expect(computeStreak(rows, TODAY)).toEqual({ current: 3, longest: 3, since: '2026-07-22' });
  });

  it('오늘이 아직 미달이어도 어제까지의 연속을 인정한다(자정 유예)', () => {
    const rows = [
      { day: '2026-07-22', ...OK },
      { day: '2026-07-23', ...OK },
      // 2026-07-24(오늘): 데이터 없음
    ];
    expect(computeStreak(rows, TODAY)).toMatchObject({ current: 2, since: '2026-07-22' });
  });

  it('마지막 친 날이 이틀 전 이하면 현재 스트릭은 0(끊김)', () => {
    const rows = [
      { day: '2026-07-20', ...OK },
      { day: '2026-07-21', ...OK },
      // 22,23,24 없음 → 마지막 친 날 21은 today-3
    ];
    expect(computeStreak(rows, TODAY)).toMatchObject({ current: 0, longest: 2, since: null });
  });

  it('오늘이 조건 미달이면 그 날은 친 날이 아니다', () => {
    const rows = [
      { day: '2026-07-23', ...OK },
      { day: '2026-07-24', prompts: 4, chars: 100 }, // 오늘은 미달
    ];
    // 오늘 미달 → 어제(23)까지 유예 인정
    expect(computeStreak(rows, TODAY)).toMatchObject({ current: 1, since: '2026-07-23' });
  });

  it('longest 는 전 기간 최장 연속 (현재가 끊겨도 과거 최장 반환)', () => {
    const rows = [
      // 과거 5일 연속(최장)
      { day: '2026-07-01', ...OK },
      { day: '2026-07-02', ...OK },
      { day: '2026-07-03', ...OK },
      { day: '2026-07-04', ...OK },
      { day: '2026-07-05', ...OK },
      // 공백 후 최근 2일(현재)
      { day: '2026-07-23', ...OK },
      { day: '2026-07-24', ...OK },
    ];
    expect(computeStreak(rows, TODAY)).toEqual({ current: 2, longest: 5, since: '2026-07-23' });
  });

  it('입력 순서가 뒤섞여도 정렬해 계산한다', () => {
    const rows = [
      { day: '2026-07-24', ...OK },
      { day: '2026-07-22', ...OK },
      { day: '2026-07-23', ...OK },
    ];
    expect(computeStreak(rows, TODAY)).toEqual({ current: 3, longest: 3, since: '2026-07-22' });
  });

  it('미달인 날은 연속을 끊는다', () => {
    const rows = [
      { day: '2026-07-22', ...OK },
      { day: '2026-07-23', prompts: 2, chars: 50 }, // 미달 → 여기서 끊김
      { day: '2026-07-24', ...OK },
    ];
    // 오늘(24)만 친 날, 23 미달 → current=1
    expect(computeStreak(rows, TODAY)).toMatchObject({ current: 1, longest: 1, since: '2026-07-24' });
  });
});

import { describe, expect, it } from 'vitest';
import {
  BATTLE_CODE_RE,
  BATTLE_MAX_HOURS,
  BATTLE_MAX_NAME_LEN,
  BATTLE_MIN_HOURS,
  newBattleCode,
  normalizeBattleName,
  parseBattleHours,
} from '../src/battle';

describe('parseBattleHours — 기간은 방장이 24h~7d 사이 지정 (§22.2)', () => {
  it('경계: 24h(하한)·168h(상한) 허용', () => {
    expect(parseBattleHours(24)).toBe(24);
    expect(parseBattleHours(168)).toBe(168);
  });

  it('범위 밖 거부: 23h·169h', () => {
    expect(parseBattleHours(23)).toBeNull();
    expect(parseBattleHours(169)).toBeNull();
  });

  it('중간 값 자유: 48h·72h·120h', () => {
    expect(parseBattleHours(48)).toBe(48);
    expect(parseBattleHours(72)).toBe(72);
    expect(parseBattleHours(120)).toBe(120);
  });

  it('문자열 숫자 허용(JSON 경유 대비), 소수·비수치 거부', () => {
    expect(parseBattleHours('72')).toBe(72);
    expect(parseBattleHours(24.5)).toBeNull();
    expect(parseBattleHours('3d')).toBeNull(); // 단위 해석은 CLI 몫 — 서버는 시간 정수만
    expect(parseBattleHours(undefined)).toBeNull();
    expect(parseBattleHours(null)).toBeNull();
  });

  it('상수 자체가 §22.2 와 일치', () => {
    expect(BATTLE_MIN_HOURS).toBe(24);
    expect(BATTLE_MAX_HOURS).toBe(168);
  });
});

describe('normalizeBattleName — 방 이름', () => {
  it('앞뒤 공백 정리·연속 공백 축약', () => {
    expect(normalizeBattleName('  주말 결투  ')).toBe('주말 결투');
    expect(normalizeBattleName('a   b')).toBe('a b');
  });

  it(`길이 상한 ${BATTLE_MAX_NAME_LEN}자 초과·빈 문자열·비문자열 거부`, () => {
    expect(normalizeBattleName('x'.repeat(BATTLE_MAX_NAME_LEN))).toHaveLength(BATTLE_MAX_NAME_LEN);
    expect(normalizeBattleName('x'.repeat(BATTLE_MAX_NAME_LEN + 1))).toBeNull();
    expect(normalizeBattleName('   ')).toBeNull();
    expect(normalizeBattleName(42)).toBeNull();
  });
});

describe('newBattleCode — 초대 코드', () => {
  it('형식: 6자, 혼동 문자(0/o/1/l/i) 없는 소문자+숫자', () => {
    for (let i = 0; i < 50; i++) {
      const code = newBattleCode();
      expect(code).toMatch(BATTLE_CODE_RE);
      expect(code).not.toMatch(/[01oli]/);
    }
  });

  it('연속 생성 시 사실상 중복 없음(50개 표본)', () => {
    const codes = new Set(Array.from({ length: 50 }, () => newBattleCode()));
    expect(codes.size).toBe(50);
  });
});

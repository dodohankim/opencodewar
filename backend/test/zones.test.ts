import { describe, expect, it } from 'vitest';
import { cityKey, cleanCity, countryFlag } from '../src/zones';
import { isValidCountryCode } from '../src/validate';

describe('countryFlag', () => {
  it('2글자 국가코드를 국기 이모지로 바꾼다', () => {
    expect(countryFlag('KR')).toBe('🇰🇷');
    expect(countryFlag('US')).toBe('🇺🇸');
    expect(countryFlag('JP')).toBe('🇯🇵');
  });

  it('소문자도 허용한다', () => {
    expect(countryFlag('kr')).toBe('🇰🇷');
  });

  it('유효하지 않으면 빈 문자열', () => {
    expect(countryFlag(null)).toBe('');
    expect(countryFlag('')).toBe('');
    expect(countryFlag('KOR')).toBe('');
    expect(countryFlag('K1')).toBe('');
    expect(countryFlag(42)).toBe('');
  });
});

describe('cleanCity', () => {
  it('앞뒤 공백 제거 + 내부 연속 공백 축소', () => {
    expect(cleanCity('  Seoul  ')).toBe('Seoul');
    expect(cleanCity('San   Francisco')).toBe('San Francisco');
  });

  it('대소문자는 표시용으로 보존한다', () => {
    expect(cleanCity('seOUL')).toBe('seOUL');
  });

  it('빈 값/문자열 아님 → null(도시 해제)', () => {
    expect(cleanCity('')).toBeNull();
    expect(cleanCity('   ')).toBeNull();
    expect(cleanCity(null)).toBeNull();
    expect(cleanCity(123)).toBeNull();
  });
});

describe('cityKey', () => {
  it('소문자 + 공백 정규화로 그룹 키를 만든다', () => {
    expect(cityKey('Seoul')).toBe('seoul');
    expect(cityKey('  San   Francisco ')).toBe('san francisco');
    expect(cityKey('SEOUL')).toBe(cityKey('seoul'));
  });

  it('한글은 소문자 변환에 영향 없음(같은 키)', () => {
    expect(cityKey('서울')).toBe('서울');
  });
});

describe('isValidCountryCode', () => {
  it('2글자 영문만 허용', () => {
    expect(isValidCountryCode('KR')).toBe(true);
    expect(isValidCountryCode('us')).toBe(true);
    expect(isValidCountryCode('KOR')).toBe(false);
    expect(isValidCountryCode('K')).toBe(false);
    expect(isValidCountryCode('12')).toBe(false);
    expect(isValidCountryCode(null)).toBe(false);
  });
});

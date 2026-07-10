import { describe, expect, it } from 'vitest';
import { autoNickname, displayNickname } from '../src/nickname';

const SAMPLE_IDS = [
  'ocw_af0b1234567890abcdef1234567890d388',
  'ocw_00000000000000000000000000000000',
  'ocw_ffffffffffffffffffffffffffffffff',
  'short_id_1',
  'ocw_deadbeefcafebabe0123456789abcdef',
];

describe('autoNickname', () => {
  it('항상 10자 이내다', () => {
    for (const id of SAMPLE_IDS) {
      expect(autoNickname(id).length).toBeLessThanOrEqual(10);
    }
  });

  it('결정론적이다 (같은 userId → 같은 닉네임)', () => {
    for (const id of SAMPLE_IDS) {
      expect(autoNickname(id)).toBe(autoNickname(id));
    }
  });

  it('비어있지 않고 anon 이 아니다', () => {
    for (const id of SAMPLE_IDS) {
      const nick = autoNickname(id);
      expect(nick.length).toBeGreaterThan(0);
      expect(nick.toLowerCase()).not.toContain('anon');
    }
  });

  it('영숫자로만 구성된다', () => {
    for (const id of SAMPLE_IDS) {
      expect(autoNickname(id)).toMatch(/^[A-Za-z0-9]+$/);
    }
  });
});

describe('displayNickname', () => {
  it('등록 닉네임이 있으면 그대로 반환한다', () => {
    expect(displayNickname('dododo', 'ocw_whatever00000000')).toBe('dododo');
  });

  it('닉네임이 null/undefined 면 자동 닉네임으로 대체한다', () => {
    const id = SAMPLE_IDS[0];
    expect(displayNickname(null, id)).toBe(autoNickname(id));
    expect(displayNickname(undefined, id)).toBe(autoNickname(id));
  });
});

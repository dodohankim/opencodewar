import { describe, expect, it } from 'vitest';
import {
  isValidShortText,
  isValidUrl,
  MAX_PROJECT_NAME_LEN,
  MAX_ROLE_LEN,
  MAX_URL_LEN,
  normalizeLinks,
  normalizeProjects,
} from '../src/validate';

describe('isValidUrl', () => {
  it('http(s) 절대 URL 을 허용한다', () => {
    expect(isValidUrl('https://opencodewar.dev')).toBe(true);
    expect(isValidUrl('http://example.com/path?a=1&b=2#frag')).toBe(true);
    expect(isValidUrl('https://github.com/dohan/moonlog')).toBe(true);
  });

  it('http(s) 가 아닌 스킴/형식을 거부한다', () => {
    expect(isValidUrl('javascript:alert(1)')).toBe(false);
    expect(isValidUrl('ftp://example.com')).toBe(false);
    expect(isValidUrl('opencodewar.dev')).toBe(false); // 스킴 없음
    expect(isValidUrl('')).toBe(false);
    expect(isValidUrl(123)).toBe(false);
  });

  it('최대 길이를 넘기면 거부한다', () => {
    expect(isValidUrl('https://a.com/' + 'x'.repeat(MAX_URL_LEN))).toBe(false);
  });
});

describe('isValidShortText', () => {
  it('길이 이내 텍스트를 허용하고 초과를 거부한다', () => {
    expect(isValidShortText('Frontend Engineer', MAX_ROLE_LEN)).toBe(true);
    expect(isValidShortText('x'.repeat(MAX_ROLE_LEN + 1), MAX_ROLE_LEN)).toBe(false);
  });

  it('빈 문자열은 허용한다(해제 의미)', () => {
    expect(isValidShortText('', MAX_ROLE_LEN)).toBe(true);
    expect(isValidShortText('   ', MAX_ROLE_LEN)).toBe(true);
  });

  it('제어문자를 거부한다', () => {
    expect(isValidShortText('foo\nbar', MAX_ROLE_LEN)).toBe(false);
    expect(isValidShortText('foo\tbar', MAX_ROLE_LEN)).toBe(false);
  });
});

describe('normalizeLinks', () => {
  it('허용 키의 유효 URL 을 정규화한다', () => {
    expect(normalizeLinks({ github: 'https://github.com/dohan', x: 'https://x.com/dohan' })).toEqual({
      github: 'https://github.com/dohan',
      x: 'https://x.com/dohan',
    });
  });

  it('빈 값은 해당 링크를 제외한다', () => {
    expect(normalizeLinks({ github: 'https://github.com/dohan', x: '' })).toEqual({
      github: 'https://github.com/dohan',
    });
  });

  it('빈 객체는 전체 해제로 허용한다', () => {
    expect(normalizeLinks({})).toEqual({});
  });

  it('허용되지 않은 키나 잘못된 URL 은 null(거절)', () => {
    expect(normalizeLinks({ facebook: 'https://fb.com/x' })).toBeNull();
    expect(normalizeLinks({ github: 'not-a-url' })).toBeNull();
    expect(normalizeLinks({ website: 'javascript:alert(1)' })).toBeNull();
    expect(normalizeLinks(['https://x.com'])).toBeNull();
    expect(normalizeLinks(null)).toBeNull();
  });
});

describe('normalizeProjects', () => {
  it('name 필수, desc/url 선택을 정규화한다', () => {
    expect(
      normalizeProjects([
        { name: 'Open Code War', desc: 'Claude Code 리더보드', url: 'https://opencodewar.dev' },
        { name: 'moonlog' },
      ]),
    ).toEqual([
      { name: 'Open Code War', desc: 'Claude Code 리더보드', url: 'https://opencodewar.dev' },
      { name: 'moonlog' },
    ]);
  });

  it('빈 desc/url 은 생략한다', () => {
    expect(normalizeProjects([{ name: 'A', desc: '', url: '' }])).toEqual([{ name: 'A' }]);
  });

  it('최대 5개를 초과하면 null', () => {
    const six = Array.from({ length: 6 }, (_, i) => ({ name: `p${i}` }));
    expect(normalizeProjects(six)).toBeNull();
  });

  it('name 누락/형식오류/잘못된 url 은 null', () => {
    expect(normalizeProjects([{ desc: 'no name' }])).toBeNull();
    expect(normalizeProjects([{ name: '' }])).toBeNull();
    expect(normalizeProjects([{ name: 'x'.repeat(MAX_PROJECT_NAME_LEN + 1) }])).toBeNull();
    expect(normalizeProjects([{ name: 'A', url: 'ftp://x.com' }])).toBeNull();
    expect(normalizeProjects('nope')).toBeNull();
  });

  it('빈 배열은 전체 해제로 허용한다', () => {
    expect(normalizeProjects([])).toEqual([]);
  });
});

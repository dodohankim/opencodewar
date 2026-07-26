import { describe, expect, it } from 'vitest';
import { clearSessionCookie, isSameOrigin, newWebUserId, sessionCookie, SESSION_TTL_S } from '../src/session';
import { isValidUserId } from '../src/validate';

const req = (headers: Record<string, string>) => new Request('https://opencodewar.dev/api/profile', { headers });

describe('sessionCookie', () => {
  it('브라우저 JS 가 못 읽고(HttpOnly) 크로스사이트 POST 에 실리지 않는다(SameSite=Lax)', () => {
    const c = sessionCookie('a'.repeat(32));
    expect(c).toContain('HttpOnly');
    expect(c).toContain('SameSite=Lax');
    expect(c).toContain('Secure');
    expect(c).toContain('Path=/');
    expect(c).toContain(`Max-Age=${SESSION_TTL_S}`);
  });

  it('로그아웃 쿠키는 즉시 만료된다', () => {
    expect(clearSessionCookie()).toContain('Max-Age=0');
  });
});

describe('newWebUserId', () => {
  it('플러그인이 발급하는 userId 형식을 만족한다(나중에 CLI 병합이 그대로 먹어야 함)', () => {
    for (let i = 0; i < 20; i++) {
      const id = newWebUserId();
      expect(id.startsWith('ocw_')).toBe(true);
      expect(isValidUserId(id)).toBe(true);
    }
  });

  it('매번 다르다', () => {
    const seen = new Set(Array.from({ length: 50 }, () => newWebUserId()));
    expect(seen.size).toBe(50);
  });
});

describe('isSameOrigin', () => {
  const url = new URL('https://opencodewar.dev/api/profile');

  it('우리 오리진에서 온 요청만 통과시킨다', () => {
    expect(isSameOrigin(req({ origin: 'https://opencodewar.dev' }), url)).toBe(true);
  });

  it('다른 오리진은 막는다', () => {
    expect(isSameOrigin(req({ origin: 'https://evil.com' }), url)).toBe(false);
    // 서브도메인·스킴만 다른 경우도 별개 오리진이다.
    expect(isSameOrigin(req({ origin: 'https://www.opencodewar.dev' }), url)).toBe(false);
    expect(isSameOrigin(req({ origin: 'http://opencodewar.dev' }), url)).toBe(false);
  });

  it('Origin 이 아예 없는 요청도 막는다(웹 UI 는 항상 붙여 보낸다)', () => {
    expect(isSameOrigin(req({}), url)).toBe(false);
  });
});

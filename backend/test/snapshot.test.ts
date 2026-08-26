import { describe, expect, it } from 'vitest';
import { pickMainProject, prevDayFilter } from '../src/snapshot';

describe('pickMainProject', () => {
  it('main 표식이 붙은 프로젝트를 고른다(등록 순서와 무관)', () => {
    const raw = JSON.stringify([
      { name: 'moonlog', url: 'https://moonlog.dev' },
      { name: 'Open Code War', url: 'https://opencodewar.dev', main: true },
    ]);
    expect(pickMainProject(raw)).toEqual({ name: 'Open Code War', url: 'https://opencodewar.dev' });
  });

  it('main 표식이 없으면 첫 항목을 쓴다(유저 상세의 맨 위와 동일)', () => {
    const raw = JSON.stringify([{ name: 'moonlog' }, { name: 'second' }]);
    expect(pickMainProject(raw)).toEqual({ name: 'moonlog' });
  });

  it('desc 도 싣는다 — 톱3 카드의 한 줄 설명(§7.4)', () => {
    const raw = JSON.stringify([{ name: 'A', desc: '설명', url: 'https://a.dev' }]);
    expect(pickMainProject(raw)).toEqual({ name: 'A', url: 'https://a.dev', desc: '설명' });
  });

  it('빈 desc 는 키 자체를 만들지 않는다', () => {
    expect(pickMainProject(JSON.stringify([{ name: 'A', desc: '   ' }]))).toEqual({ name: 'A' });
  });

  it('url 이 http(s) 절대 URL 이 아니면 이름만 남긴다', () => {
    expect(pickMainProject(JSON.stringify([{ name: 'A', url: 'javascript:alert(1)' }]))).toEqual({
      name: 'A',
    });
    expect(pickMainProject(JSON.stringify([{ name: 'A', url: 'a.dev' }]))).toEqual({ name: 'A' });
  });

  it('미설정·빈 배열·깨진 JSON·이름 없는 항목은 null', () => {
    expect(pickMainProject(null)).toBeNull();
    expect(pickMainProject('[]')).toBeNull();
    expect(pickMainProject('{oops')).toBeNull();
    expect(pickMainProject(JSON.stringify([{ name: '   ' }]))).toBeNull();
    expect(pickMainProject(JSON.stringify([{ url: 'https://a.dev' }]))).toBeNull();
  });

  it('이름은 앞뒤 공백을 떼고 담는다', () => {
    expect(pickMainProject(JSON.stringify([{ name: '  moonlog  ' }]))).toEqual({ name: 'moonlog' });
  });

  it('잠수함(sub, §20.7)은 후보에서 제외한다 — main 이어도 공개 칩에 이름을 내지 않는다', () => {
    const raw = JSON.stringify([
      { name: 'ghost', sub: true, main: true, url: 'https://g.dev' },
      { name: 'moonlog' },
    ]);
    expect(pickMainProject(raw)).toEqual({ name: 'moonlog' });
    expect(pickMainProject(JSON.stringify([{ name: 'ghost', sub: true }]))).toBeNull();
  });
});

describe('prevDayFilter (§7.4 순위 변동)', () => {
  const now = Date.UTC(2026, 7, 26, 8, 0, 0); // 2026-08-26 08:00 UTC

  it("all 은 '어제까지 누적' 을 본다 — 오늘 친 건 빼고 세운 순위", () => {
    expect(prevDayFilter('all', now)).toEqual({ sql: 's.day <= ?', binds: ['2026-08-25'] });
  });

  it('daily 는 어제 하루만 본다', () => {
    expect(prevDayFilter('daily', now)).toEqual({ sql: 's.day = ?', binds: ['2026-08-25'] });
  });

  it('웹에 안 나오는 보드는 계산하지 않는다(null)', () => {
    expect(prevDayFilter('weekly', now)).toBeNull();
    expect(prevDayFilter('weekend', now)).toBeNull();
    expect(prevDayFilter('monthly', now)).toBeNull();
  });
});

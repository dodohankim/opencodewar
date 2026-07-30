// 클라이언트(플러그인) 쪽 브리핑 캐시 가드 — plugin/scripts/lib/briefing.mjs.
//
// 여기 있는 이유: 이 파일이 깨졌을 때 증상이 "같은 브리핑 줄이 세션을 오갈 때마다 반복해서 뜬다"
// 였고(실측: 37분간 5개 세션에서 `병장까지 182 프롬프트` 6회), 원인은 표시 기록이 스칼라
// 하나였던 것이다. 순수 함수라 FS 없이 검증된다.

import { describe, expect, it } from 'vitest';
// @ts-expect-error — 플러그인 스크립트는 타입 선언 없는 .mjs
import { SHOWN_TTL_MS, markShown, normalizeShown, wasShownTo } from '../../plugin/scripts/lib/briefing.mjs';

const NOW = Date.UTC(2026, 6, 30, 12, 0, 0);

describe('normalizeShown', () => {
  it('구버전 shownFor 스칼라를 맵으로 흡수한다', () => {
    expect(normalizeShown({ shownFor: 'sess-a', shownAt: 100 })).toEqual({ 'sess-a': 100 });
  });

  it('shownAt 이 없던 캐시는 0 으로 (TTL 판정에서 만료 취급)', () => {
    expect(normalizeShown({ shownFor: 'sess-a' })).toEqual({ 'sess-a': 0 });
  });

  it('shownFor 가 null 이거나 키가 아예 없으면 빈 맵', () => {
    expect(normalizeShown({ shownFor: null })).toEqual({});
    expect(normalizeShown({})).toEqual({});
  });

  it('이미 맵이면 그대로, 망가진 항목만 버린다', () => {
    expect(normalizeShown({ shownBySession: { a: 1, b: 'nope', '': 3 } })).toEqual({ a: 1 });
  });

  it('맵이 있으면 구버전 키는 무시한다', () => {
    expect(normalizeShown({ shownBySession: { a: 1 }, shownFor: 'b', shownAt: 2 })).toEqual({ a: 1 });
  });
});

describe('wasShownTo', () => {
  it('기록이 있으면 이미 본 것', () => {
    expect(wasShownTo({ a: NOW - 1000 }, 'a', NOW)).toBe(true);
  });

  it('다른 세션의 기록은 내 기록이 아니다 — 이게 핑퐁 버그의 핵심', () => {
    expect(wasShownTo({ b: NOW - 1000 }, 'a', NOW)).toBe(false);
    // 그리고 b 의 기록은 a 를 표시해도 살아남아야 한다
    expect(wasShownTo(markShown({ b: NOW - 1000 }, 'a', NOW), 'b', NOW)).toBe(true);
  });

  it('TTL 지난 기록은 없는 것으로 본다', () => {
    expect(wasShownTo({ a: NOW - SHOWN_TTL_MS - 1 }, 'a', NOW)).toBe(false);
  });

  it('빈/누락 맵에서도 터지지 않는다', () => {
    expect(wasShownTo(undefined, 'a', NOW)).toBe(false);
    expect(wasShownTo({}, 'a', NOW)).toBe(false);
  });
});

describe('markShown', () => {
  it('기존 기록을 유지한 채 이번 세션을 더한다', () => {
    expect(markShown({ a: NOW - 5000 }, 'b', NOW)).toEqual({ a: NOW - 5000, b: NOW });
  });

  it('TTL 지난 항목은 정리한다', () => {
    const shown = { old: NOW - SHOWN_TTL_MS - 1, fresh: NOW - 10 };
    expect(markShown(shown, 'b', NOW)).toEqual({ fresh: NOW - 10, b: NOW });
  });

  it('sessionId 가 없으면(호스트가 못 주면) 기록만 정리하고 추가하지 않는다', () => {
    expect(markShown({ a: NOW }, null, NOW)).toEqual({ a: NOW });
  });

  it('상한을 넘으면 오래된 것부터 버린다', () => {
    const shown: Record<string, number> = {};
    for (let i = 0; i < 250; i++) shown[`s${i}`] = NOW - (250 - i); // s0 이 가장 오래됨
    const next = markShown(shown, 'newest', NOW);
    expect(Object.keys(next)).toHaveLength(200);
    expect(next.newest).toBe(NOW);
    expect(next.s0).toBeUndefined();
    expect(next.s249).toBe(NOW - 1);
  });
});

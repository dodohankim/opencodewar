// 클라이언트(플러그인) 쪽 브리핑 표시 가드 — plugin/scripts/lib/briefing.mjs.
//
// 여기 있는 이유: 이 로직이 깨지면 증상이 "같은 줄이 계속 반복해서 뜬다"인데, 실측 전엔 잘
// 안 보인다(85분간 서로 다른 세션 9개에서 17회 표시된 적이 있다). 순수 함수라 FS 없이 검증된다.

import { describe, expect, it } from 'vitest';
// @ts-expect-error — 플러그인 스크립트는 타입 선언 없는 .mjs
import { briefingCandidates, canShow, localDay, pickBriefing } from '../../plugin/scripts/lib/briefing.mjs';

const NOW = new Date(2026, 6, 30, 12, 0, 0).getTime(); // 로컬 2026-07-30 정오
const TOMORROW = NOW + 24 * 60 * 60 * 1000;

/** 계급 임박(3순위)만 걸리는 데이터 — remaining 이 span 의 10% 이하. */
function data(over: Record<string, unknown> = {}) {
  return {
    registered: true,
    today: { prompts: 30, chars: 20000, qualified: true },
    streak: { current: 11, longest: 11, minPrompts: 10, minChars: 500 },
    rankTitle: { index: 2, remaining: 174, span: 2000 },
    rank: { global: 1, country: 1, countryCode: 'KR' },
    ahead: null,
    ...over,
  };
}

describe('localDay', () => {
  it('로컬 달력 기준 YYYY-MM-DD (로케일에 안 흔들린다)', () => {
    expect(localDay(NOW)).toBe('2026-07-30');
    expect(localDay(new Date(2026, 0, 5, 0, 30).getTime())).toBe('2026-01-05');
  });
});

describe('canShow — 하루 1회 + 같은 종류 금지', () => {
  it('기록이 비어 있으면 띄운다', () => {
    expect(canShow({}, 'rank:2', NOW)).toBe(true);
  });

  it('오늘 이미 띄웠으면 종류가 달라도 침묵', () => {
    expect(canShow({ lastShownDay: '2026-07-30', lastKey: 'streak:11' }, 'rank:2', NOW)).toBe(false);
  });

  it('날이 바뀌면 다시 띄운다', () => {
    expect(canShow({ lastShownDay: '2026-07-30', lastKey: 'streak:11' }, 'rank:2', TOMORROW)).toBe(true);
  });

  it('날이 바뀌어도 지난번과 같은 종류면 침묵 — 계급 줄이 몇 주 반복되던 문제', () => {
    expect(canShow({ lastShownDay: '2026-07-30', lastKey: 'rank:2' }, 'rank:2', TOMORROW)).toBe(false);
  });

  it('계급이 실제로 오르면 key 가 바뀌므로 다시 띄운다', () => {
    expect(canShow({ lastShownDay: '2026-07-30', lastKey: 'rank:2' }, 'rank:3', TOMORROW)).toBe(true);
  });

  it('state 나 key 가 없으면 침묵', () => {
    expect(canShow(null, 'rank:2', NOW)).toBe(false);
    expect(canShow({}, null, NOW)).toBe(false);
  });
});

describe('briefingCandidates — key 는 숫자가 아니라 종류로 잡는다', () => {
  it('계급 임박 key 는 숫자가 줄어도 그대로', () => {
    const a = briefingCandidates(data(), null, 'ko');
    const b = briefingCandidates(data({ rankTitle: { index: 2, remaining: 12, span: 2000 } }), null, 'ko');
    expect(a[0].key).toBe('rank:2');
    expect(b[0].key).toBe('rank:2');
    expect(a[0].line).not.toBe(b[0].line); // 문구는 다르지만 같은 얘기다
  });

  it('스트릭 key 는 연속일수를 담는다 — 매일 새로 알릴 값어치가 있다', () => {
    const d = data({ today: { prompts: 3, chars: 100, qualified: false } });
    expect(briefingCandidates(d, null, 'ko')[0].key).toBe('streak:11');
  });

  it('격차 key 는 상대 닉네임 — 같은 사람 쫓는 동안은 한 번만', () => {
    const d = data({ rank: { global: 5, country: 3, countryCode: 'KR' }, ahead: { nickname: 'foo', gap: 7 } });
    expect(briefingCandidates(d, null, 'ko').map((c: any) => c.key)).toContain('gap:foo');
  });

  it('우선순위 순서대로 나온다 (닉네임 > 스트릭 > 계급)', () => {
    const d = data({ registered: false, today: { prompts: 3, chars: 100, qualified: false } });
    expect(briefingCandidates(d, null, 'ko').map((c: any) => c.key)).toEqual(['nick', 'streak:11', 'rank:2']);
  });
});

describe('briefingCandidates — 막사 (§27.8)', () => {
  it('없는 동안 다녀간 사람·방명록 한 줄, 숫자가 늘면 다른 소식', () => {
    const c = briefingCandidates(data({ space: { visitors: 3, guestbook: 2 } }), null, 'ko');
    const line = c.find((x: any) => x.key === 'space:3:2');
    expect(line.line).toBe('⛺ 막사에 3명 다녀감 · 방명록 2');
  });
  it('방명록이 없으면 그 부분은 뺀다, 영문 복수형', () => {
    expect(briefingCandidates(data({ space: { visitors: 1, guestbook: 0 } }), null, 'ko')[0].line).toBe('⛺ 막사에 1명 다녀감');
    expect(briefingCandidates(data({ space: { visitors: 1, guestbook: 0 } }), null, 'en')[0].line).toBe('⛺ 1 visitor in your barracks');
    expect(briefingCandidates(data({ space: { visitors: 2, guestbook: 2 } }), null, 'en')[0].line).toBe('⛺ 2 visitors in your barracks · 2 guestbook notes');
  });
  it('우선순위: 스트릭 > 막사 > 계급 임박, 소식이 없으면 침묵', () => {
    const d = data({ today: { prompts: 3, chars: 100, qualified: false }, space: { visitors: 1, guestbook: 0 } });
    expect(briefingCandidates(d, null, 'ko').map((c: any) => c.key)).toEqual(['streak:11', 'space:1:0', 'rank:2']);
    expect(briefingCandidates(data({ space: null }), null, 'ko').map((c: any) => c.key)).toEqual(['rank:2']);
  });
});

describe('pickBriefing — 막힌 후보는 건너뛰고 다음 순위로', () => {
  it('1순위가 이미 본 얘기면 침묵하지 않고 다음 걸 띄운다', () => {
    const d = data({ today: { prompts: 3, chars: 100, qualified: false } }); // streak + rank 둘 다 후보
    const picked = pickBriefing({ lastKey: 'streak:11' }, d, null, 'ko', NOW);
    expect(picked.key).toBe('rank:2');
  });

  it('오늘 이미 띄웠으면 전부 막힌다', () => {
    const d = data({ today: { prompts: 3, chars: 100, qualified: false } });
    expect(pickBriefing({ lastShownDay: '2026-07-30' }, d, null, 'ko', NOW)).toBeNull();
  });

  it('후보가 하나뿐인데 그게 막혔으면 침묵', () => {
    expect(pickBriefing({ lastKey: 'rank:2' }, data(), null, 'ko', TOMORROW)).toBeNull();
  });

  it('보여줄 게 아예 없으면 침묵', () => {
    const quiet = data({ rankTitle: { index: 2, remaining: 1500, span: 2000 } }); // 임박 아님
    expect(pickBriefing({}, quiet, null, 'ko', NOW)).toBeNull();
  });
});

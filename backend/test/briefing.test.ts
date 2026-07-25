import { describe, expect, it } from 'vitest';
import { RANK_MINS, buildBriefing, rankIndexOf, rankSpan, remainingToNextRank } from '../src/briefing';
import type { RankEntry, Snapshot } from '../src/types';

// 기준 오늘: 2026-07-24T12:00:00Z (UTC 정오)
const TODAY = Date.UTC(2026, 6, 24, 12, 0, 0);
const TODAY_KEY = '2026-07-24';

function entry(rank: number, publicId: string, country: string | null, prompts: number): RankEntry {
  return {
    rank,
    nickname: `user${rank}`,
    registered: true,
    public_id: publicId,
    country,
    prompts,
    chars: prompts * 10,
  };
}

function snapshotOf(entries: RankEntry[]): Snapshot {
  const board = { period: { all: true as const }, prompts: entries, chars: entries };
  return {
    builtAt: TODAY,
    boards: { daily: board, weekly: board, weekend: board, monthly: board, all: board },
  };
}

const EMPTY = snapshotOf([]);

describe('rankIndexOf — 누적 prompts → 계급 인덱스 (§16)', () => {
  it('0이면 이병(0)', () => {
    expect(rankIndexOf(0)).toBe(0);
  });

  it('경계: 임계값 직전은 이전 계급, 임계값이면 승급', () => {
    expect(rankIndexOf(199)).toBe(0);
    expect(rankIndexOf(200)).toBe(1);
    expect(rankIndexOf(999)).toBe(1);
    expect(rankIndexOf(1000)).toBe(2);
  });

  it('최고 계급(장군)에서 더 올라가지 않는다', () => {
    const top = RANK_MINS.length - 1;
    expect(rankIndexOf(1_000_000)).toBe(top);
    expect(rankIndexOf(99_999_999)).toBe(top);
  });
});

describe('remainingToNextRank — 다음 계급까지 남은 수', () => {
  it('이병 0이면 일병(200)까지 200', () => {
    expect(remainingToNextRank(0)).toBe(200);
  });

  it('임계값 직전이면 1', () => {
    expect(remainingToNextRank(199)).toBe(1);
  });

  it('최고 계급이면 null', () => {
    expect(remainingToNextRank(1_000_000)).toBeNull();
  });
});

describe('rankSpan — 현재 계급 구간 크기 (임박 비율 판정의 분모)', () => {
  it('이병 구간은 0→200 이라 200', () => {
    expect(rankSpan(0)).toBe(200);
    expect(rankSpan(199)).toBe(200);
  });

  it('일병 구간은 200→1000 이라 800', () => {
    expect(rankSpan(200)).toBe(800);
  });

  it('최고 계급이면 null', () => {
    expect(rankSpan(1_000_000)).toBeNull();
  });

  it('remaining/span 으로 임박(≤10%) 판정이 가능하다', () => {
    // 일병(200~1000) 구간에서 970 → 남은 30, 구간 800 → 3.75% (임박)
    expect(remainingToNextRank(970)! / rankSpan(970)!).toBeLessThanOrEqual(0.1);
    // 250 → 남은 750 / 800 = 93.75% (임박 아님)
    expect(remainingToNextRank(250)! / rankSpan(250)!).toBeGreaterThan(0.1);
  });
});

describe('buildBriefing — 개인 지표 (계급·스트릭·오늘)', () => {
  const base = { snapshot: EMPTY, publicId: null, country: null, registered: true, now: TODAY };

  it('활동이 없으면 전부 0, 계급은 이병', () => {
    const b = buildBriefing({ ...base, dayStats: [] });
    expect(b.allTime.prompts).toBe(0);
    expect(b.today).toEqual({ prompts: 0, chars: 0, qualified: false });
    expect(b.streak).toEqual({ current: 0, longest: 0, minPrompts: 10, minChars: 500 });
    expect(b.rankTitle).toEqual({ index: 0, remaining: 200, span: 200 });
  });

  it('allTime 은 전 기간 합, today 는 오늘(UTC) 행만', () => {
    const b = buildBriefing({
      ...base,
      dayStats: [
        { day: '2026-07-23', prompts: 30, chars: 3000 },
        { day: TODAY_KEY, prompts: 12, chars: 600 },
      ],
    });
    expect(b.allTime.prompts).toBe(42);
    expect(b.today).toEqual({ prompts: 12, chars: 600, qualified: true });
  });

  it('오늘이 스트릭 조건 미달이면 qualified=false (프롬프트만 채운 경우)', () => {
    const b = buildBriefing({ ...base, dayStats: [{ day: TODAY_KEY, prompts: 12, chars: 100 }] });
    expect(b.today.qualified).toBe(false);
  });

  it('registered 를 그대로 전달한다 (닉네임 등록 유도 판정용)', () => {
    expect(buildBriefing({ ...base, registered: false, dayStats: [] }).registered).toBe(false);
  });
});

describe('buildBriefing — 스냅샷에서 순위·이웃 추출', () => {
  const board = [
    entry(1, 'pid_a', 'US', 5000),
    entry(2, 'pid_b', 'KR', 4000),
    entry(3, 'pid_c', 'US', 3000),
    entry(4, 'pid_d', 'KR', 2000),
    entry(5, 'pid_e', 'KR', 1900),
  ];
  const snapshot = snapshotOf(board);
  const base = { snapshot, registered: true, dayStats: [], now: TODAY };

  it('스냅샷 top-N 밖이면 순위를 모른다 — 전부 null', () => {
    const b = buildBriefing({ ...base, publicId: 'pid_zzz', country: 'KR' });
    expect(b.rank).toEqual({ global: null, country: null, countryCode: 'KR' });
    expect(b.ahead).toBeNull();
  });

  it('publicId 가 없으면(프로필 미생성) 순위 조회를 시도하지 않는다', () => {
    const b = buildBriefing({ ...base, publicId: null, country: 'KR' });
    expect(b.rank.global).toBeNull();
  });

  it('글로벌 순위는 스냅샷 rank 를 그대로 쓴다', () => {
    const b = buildBriefing({ ...base, publicId: 'pid_d', country: 'KR' });
    expect(b.rank.global).toBe(4);
  });

  it('국가 순위는 나까지 중 같은 국가 인원 수', () => {
    // KR: pid_b(2위) → pid_d(4위) → pid_e(5위). pid_d 는 KR 2위.
    expect(buildBriefing({ ...base, publicId: 'pid_d', country: 'KR' }).rank.country).toBe(2);
    expect(buildBriefing({ ...base, publicId: 'pid_e', country: 'KR' }).rank.country).toBe(3);
    expect(buildBriefing({ ...base, publicId: 'pid_b', country: 'KR' }).rank.country).toBe(1);
  });

  it('ahead 는 같은 국가에서 바로 위 사람 — 글로벌 바로 위(다른 국가)를 건너뛴다', () => {
    // pid_d(KR, 2000)의 글로벌 바로 위는 pid_c(US)지만, 같은 KR 인 pid_b 를 골라야 한다.
    const b = buildBriefing({ ...base, publicId: 'pid_d', country: 'KR' });
    expect(b.ahead).toEqual({ nickname: 'user2', gap: 2000 });
  });

  it('국가가 없으면 글로벌 바로 위를 쓴다', () => {
    const b = buildBriefing({ ...base, publicId: 'pid_d', country: null });
    expect(b.ahead).toEqual({ nickname: 'user3', gap: 1000 });
  });

  it('1위면 ahead 가 없다', () => {
    const b = buildBriefing({ ...base, publicId: 'pid_a', country: 'US' });
    expect(b.ahead).toBeNull();
    expect(b.rank).toEqual({ global: 1, country: 1, countryCode: 'US' });
  });

  it('같은 국가에 위가 없으면 글로벌 바로 위로 대체한다', () => {
    // pid_b 는 KR 1위지만 글로벌 2위 → 위에 pid_a(US)가 있다.
    const b = buildBriefing({ ...base, publicId: 'pid_b', country: 'KR' });
    expect(b.ahead).toEqual({ nickname: 'user1', gap: 1000 });
  });
});

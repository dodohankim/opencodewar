import { describe, expect, it } from 'vitest';
import {
  BARRACKS_WIDTH,
  CHAT_MAX_LEN,
  CHAT_TTL_MS,
  GUEST_DAILY_LIMIT,
  KICK_BLOCK_MS,
  VISIT_REWRITE_MS,
  VISIT_WINDOW_MS,
  PLAZA_CAP,
  DOOR_FIRST_X,
  DOOR_GAP,
  MAX_DOORS,
  PLAZA_MIN_WIDTH,
  PRESENCE_FRESH_MS,
  TICKET_TTL_MS,
  WORKING_FRESH_MS,
  activeBan,
  clampX,
  cleanChat,
  findTarget,
  hasRoomFor,
  isDoorVisible,
  layoutDoors,
  nextChatAlarm,
  ownerStatus,
  pruneBans,
  pruneBeats,
  pruneChat,
  recordVisit,
  roomKindOf,
  signTicket,
  spaceOgTitle,
  takeGuestQuota,
  verifyTicket,
  visitSummary,
} from '../src/space-logic';

const door = (pid: string, over: Partial<Parameters<typeof layoutDoors>[0][number]> = {}) => ({
  pid,
  nick: pid,
  agent: 'claude-code' as const,
  count: 0,
  ownerOnline: true,
  ownerWorking: false,
  locked: false,
  ...over,
});

describe('막사 방 이름', () => {
  it('plaza 와 public_id 만 방이다', () => {
    expect(roomKindOf('plaza')).toBe('plaza');
    expect(roomKindOf('u-abcdef1234')).toBe('barracks');
    expect(roomKindOf('u-ABC')).toBeNull();
    expect(roomKindOf('ocw_secret')).toBeNull();
  });
});

describe('채팅 정리', () => {
  it('제어문자·방향 제어 문자를 지우고 공백을 정리한다', () => {
    expect(cleanChat('  안녕\n\t하세요  ')).toBe('안녕 하세요');
    expect(cleanChat('a‮b')).toBe('a b');
    expect(cleanChat('   ')).toBeNull();
    expect(cleanChat(42)).toBeNull();
  });
  it('길이 제한(코드포인트 기준)', () => {
    expect(Array.from(cleanChat('가'.repeat(500))!).length).toBe(CHAT_MAX_LEN);
  });
});

describe('채팅 보존 (24시간)', () => {
  const now = 10 * CHAT_TTL_MS;
  const line = (age: number) => ({ pid: 'u-abcdef1234', nick: 'a', text: 'x', at: now - age });
  it('24시간 지난 말만 지운다', () => {
    expect(pruneChat([line(CHAT_TTL_MS), line(CHAT_TTL_MS - 1), line(0)], now)).toEqual([line(CHAT_TTL_MS - 1), line(0)]);
  });
  it('다음 alarm 은 가장 오래된 말이 만료될 때, 말이 없으면 걸지 않는다', () => {
    expect(nextChatAlarm([line(1000), line(5000)])).toBe(now - 5000 + CHAT_TTL_MS);
    expect(nextChatAlarm([])).toBeNull();
  });
});

describe('좌표', () => {
  it('막사 폭 안으로 자른다', () => {
    expect(clampX(-5, BARRACKS_WIDTH)).toBe(0);
    expect(clampX(9999, BARRACKS_WIDTH)).toBe(BARRACKS_WIDTH - 8);
    expect(clampX(NaN, BARRACKS_WIDTH)).toBeNull();
    expect(clampX('3', BARRACKS_WIDTH)).toBeNull();
  });
});

describe('정원', () => {
  const owner = 'u-owner00000';
  const visitors = (n: number) => Array.from({ length: n }, (_, i) => ({ pid: 'u-' + String(i).padStart(10, '0') }));
  it('주인이 있어도 없어도 방문자는 9명까지', () => {
    expect(hasRoomFor('barracks', false, visitors(8), owner)).toBe(true);
    expect(hasRoomFor('barracks', false, visitors(9), owner)).toBe(false);
    // 주인 + 방문자 8 = 9명이면 한 자리가 남는다
    expect(hasRoomFor('barracks', false, [...visitors(8), { pid: owner }], owner)).toBe(true);
    expect(hasRoomFor('barracks', false, [...visitors(9), { pid: owner }], owner)).toBe(false);
  });
  it('주인은 방문자 9명이 차 있어도 들어온다', () => {
    expect(hasRoomFor('barracks', true, visitors(9), owner)).toBe(true);
  });
  it('광장은 인원만 본다', () => {
    expect(hasRoomFor('plaza', false, visitors(PLAZA_CAP - 1), null)).toBe(true);
    expect(hasRoomFor('plaza', false, visitors(PLAZA_CAP), null)).toBe(false);
  });
});

describe('광장 문 배치', () => {
  it('작업 중 > 인원 > 온라인 순, 일정 간격', () => {
    const { doors, width } = layoutDoors([
      door('u-aaaaaaaaaa', { count: 1 }),
      door('u-bbbbbbbbbb', { ownerWorking: true }),
      door('u-cccccccccc', { count: 3 }),
    ]);
    expect(doors.map((d) => d.pid)).toEqual(['u-bbbbbbbbbb', 'u-cccccccccc', 'u-aaaaaaaaaa']);
    expect(doors.map((d) => d.x)).toEqual([DOOR_FIRST_X, DOOR_FIRST_X + DOOR_GAP, DOOR_FIRST_X + 2 * DOOR_GAP]);
    expect(width).toBe(PLAZA_MIN_WIDTH);
  });
  it('최대 개수와 폭', () => {
    const many = Array.from({ length: 40 }, (_, i) => door('u-' + String(i).padStart(10, '0')));
    const { doors, width } = layoutDoors(many);
    expect(doors.length).toBe(MAX_DOORS);
    expect(width).toBe(DOOR_FIRST_X + MAX_DOORS * DOOR_GAP + 16);
  });
  it('아무도 없고 주인도 꺼져 있으면 문을 세우지 않는다', () => {
    expect(isDoorVisible({ count: 0, ownerOnline: false })).toBe(false);
    expect(isDoorVisible({ count: 1, ownerOnline: false })).toBe(true);
    expect(isDoorVisible({ count: 0, ownerOnline: true })).toBe(true);
  });
});

describe('방명록 한도', () => {
  it('막사별 하루 3건, 날이 바뀌면 초기화', () => {
    let q = takeGuestQuota(undefined, 'u-a', '2026-11-04')!;
    for (let i = 1; i < GUEST_DAILY_LIMIT; i++) q = takeGuestQuota(q, 'u-a', '2026-11-04')!;
    expect(takeGuestQuota(q, 'u-a', '2026-11-04')).toBeNull();
    expect(takeGuestQuota(q, 'u-b', '2026-11-04')?.counts['u-b']).toBe(1); // 다른 방문자는 따로
    expect(takeGuestQuota(q, 'u-a', '2026-11-05')).toEqual({ day: '2026-11-05', counts: { 'u-a': 1 } });
  });
  it('방명록은 100자로 자른다', () => {
    expect(Array.from(cleanChat('가'.repeat(300), 100)!).length).toBe(100);
  });
});

describe('방문 기록', () => {
  const now = 100 * VISIT_WINDOW_MS;
  it('같은 사람이 금방 다시 오면 쓰지 않는다', () => {
    const log = recordVisit(undefined, 'u-a', 'a', now)!;
    expect(recordVisit(log, 'u-a', 'a', now + 1000)).toBeNull();
    expect(recordVisit(log, 'u-a', 'a', now + VISIT_REWRITE_MS)?.visits['u-a'].at).toBe(now + VISIT_REWRITE_MS);
  });
  it('주인이 들어온 뒤의 방문·방명록만 센다, 7일 지난 건 안 센다', () => {
    const log = { seenAt: now - 1000, visits: { a: { nick: 'a', at: now - 2000 }, b: { nick: 'b', at: now - 500 } } };
    expect(visitSummary(log, [{ at: now - 2000 }, { at: now - 100 }], now)).toEqual({ visitors: 1, guestbook: 1 });
    const never = { seenAt: 0, visits: { old: { nick: 'o', at: now - VISIT_WINDOW_MS - 1 }, b: { nick: 'b', at: now - 1 } } };
    expect(visitSummary(never, [], now)).toEqual({ visitors: 1, guestbook: 0 });
    expect(visitSummary(undefined, [], now)).toEqual({ visitors: 0, guestbook: 0 });
  });
});

describe('강퇴 · 차단', () => {
  const now = 1_000_000;
  it('강퇴는 잠시, 차단은 영구', () => {
    const bans = { a: { nick: 'a', until: now + KICK_BLOCK_MS }, b: { nick: 'b', until: null }, c: { nick: 'c', until: now - 1 } };
    expect(activeBan(bans, 'a', now)?.nick).toBe('a');
    expect(activeBan(bans, 'b', now + 10 ** 12)?.nick).toBe('b');
    expect(activeBan(bans, 'c', now)).toBeNull();
    expect(activeBan(undefined, 'a', now)).toBeNull();
    expect(Object.keys(pruneBans(bans, now))).toEqual(['a', 'b']);
  });
  it('닉네임(대소문자 무시)·public_id 로 찾고, 같은 닉이 둘이면 모호', () => {
    const c = [
      { pid: 'u-1', nick: 'Kim' },
      { pid: 'u-2', nick: 'lee' },
      { pid: 'u-3', nick: 'LEE' },
      { pid: 'u-1', nick: 'Kim' },
    ];
    expect(findTarget('kim', c)).toEqual(c[0]);
    expect(findTarget('u-2', c)).toEqual(c[1]);
    expect(findTarget('lee', c)).toBe('ambiguous');
    expect(findTarget('없음', c)).toBe('none');
  });
});

describe('주인 상태 (세션별 하트비트)', () => {
  const now = 1_000_000_000;
  it('세션 하나라도 일하면 작업 중', () => {
    expect(ownerStatus({ a: { state: 'idle', at: now - 1000 }, b: { state: 'working', at: now - 1000 } }, now)).toEqual({
      online: true,
      working: true,
    });
  });
  it('오래된 작업 신호는 작업 중이 아니다', () => {
    expect(ownerStatus({ a: { state: 'working', at: now - WORKING_FRESH_MS - 1 } }, now)).toEqual({ online: true, working: false });
  });
  it('하트비트가 끊기면 오프라인 + 정리', () => {
    const beats = { a: { state: 'idle' as const, at: now - PRESENCE_FRESH_MS - 1 } };
    expect(ownerStatus(beats, now)).toEqual({ online: false, working: false });
    expect(pruneBeats(beats, now)).toEqual({});
  });
});

describe('공유 미리보기 제목', () => {
  const info = { count: 3, online: true, working: true, locked: false };
  it('인원과 주인 상태', () => {
    expect(spaceOgTitle('dohan', info)).toBe('dohan의 막사 · 지금 3명 · 작업 중');
    expect(spaceOgTitle('dohan', { ...info, working: false })).toBe('dohan의 막사 · 지금 3명 · 접속 중');
    expect(spaceOgTitle('dohan', { ...info, working: false, online: false, count: 0 })).toBe('dohan의 막사 · 지금 0명 · 외출 중');
  });
  it('잠긴 막사·상태를 못 읽은 경우', () => {
    expect(spaceOgTitle('dohan', { ...info, locked: true })).toBe('dohan의 막사 · 잠김');
    expect(spaceOgTitle('dohan', null)).toBe('dohan의 막사');
  });
});

describe('티켓', () => {
  const id = { pid: 'u-abcdef1234', nick: 'dohan', agent: 'claude-code' as const, rank: 3 };
  it('서명·검증 왕복', async () => {
    const t = await signTicket('secret', id, 1000);
    expect(await verifyTicket('secret', t, 1000 + TICKET_TTL_MS - 1)).toEqual(id);
  });
  it('만료·위조·다른 키는 거부', async () => {
    const t = await signTicket('secret', id, 1000);
    expect(await verifyTicket('secret', t, 1000 + TICKET_TTL_MS + 1)).toBeNull();
    expect(await verifyTicket('other', t, 1000)).toBeNull();
    const [body, sig] = t.split('.');
    const forged = body.slice(0, -2) + (body.endsWith('A') ? 'BB' : 'AA') + '.' + sig;
    expect(await verifyTicket('secret', forged, 1000)).toBeNull();
    expect(await verifyTicket('secret', 'garbage', 1000)).toBeNull();
  });
  it('티켓에 비밀 userId 가 들어가지 않는다', async () => {
    const t = await signTicket('secret', id, 1000);
    const payload = atob(t.split('.')[0].replace(/-/g, '+').replace(/_/g, '/'));
    expect(payload).not.toContain('ocw_');
    expect(Object.keys(JSON.parse(payload)).sort()).toEqual(['a', 'e', 'n', 'p', 'r']);
  });
});

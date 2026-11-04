import { describe, expect, it } from 'vitest';
import {
  BARRACKS_WIDTH,
  CHAT_MAX_LEN,
  PLAZA_CAP,
  DOOR_FIRST_X,
  DOOR_GAP,
  MAX_DOORS,
  PLAZA_MIN_WIDTH,
  PRESENCE_FRESH_MS,
  TICKET_TTL_MS,
  WORKING_FRESH_MS,
  clampX,
  cleanChat,
  hasRoomFor,
  isDoorVisible,
  layoutDoors,
  ownerStatus,
  pruneBeats,
  roomKindOf,
  signTicket,
  verifyTicket,
} from '../src/space-logic';

const door = (pid: string, over: Partial<Parameters<typeof layoutDoors>[0][number]> = {}) => ({
  pid,
  nick: pid,
  agent: 'claude-code' as const,
  count: 0,
  ownerOnline: true,
  ownerWorking: false,
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

describe('티켓', () => {
  const id = { pid: 'u-abcdef1234', nick: 'dohan', agent: 'claude-code' as const };
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
    expect(Object.keys(JSON.parse(payload)).sort()).toEqual(['a', 'e', 'n', 'p']);
  });
});

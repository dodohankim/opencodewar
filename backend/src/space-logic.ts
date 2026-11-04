// 막사(Space) — 순수 로직 (DESIGN.md §27). Durable Object·Worker 양쪽과 테스트가 쓴다.
//
// 방 종류:
//   · 광장(plaza)   — 하나뿐. 막사 문이 줄지어 있고 걸어가서 들어간다. 최대 PLAZA_CAP 명.
//   · 막사(barracks) — 유저 1인당 1개, 이름 = 주인 public_id. 주인 포함 최대 BARRACKS_CAP 명.
// 관전자(비로그인 웹)는 정원에 들지 않고 말할 수 없다.

import type { Agent } from './validate';
import { AGENTS } from './validate';

export const PLAZA_ID = 'plaza';
export const PLAZA_CAP = 30;
export const BARRACKS_CAP = 10; // 주인 포함
export const SPECTATOR_CAP = 50;

export const BARRACKS_WIDTH = 96; // px(= 터미널 칸)
export const DOOR_GAP = 28;
export const DOOR_FIRST_X = 30;
export const PLAZA_MIN_WIDTH = 140;
export const MAX_DOORS = 24;
export const SPRITE_W = 8;

export const CHAT_KEEP = 50;
export const CHAT_MAX_LEN = 200;
export const SAY_MIN_INTERVAL_MS = 400;
export const MOVE_MIN_INTERVAL_MS = 60;

/** 주인 상태 하트비트 신선도. 플러그인은 2분마다 보낸다 → 5분 끊기면 오프라인. */
export const PRESENCE_FRESH_MS = 5 * 60_000;
/** 작업 중(working) 신호는 더 짧게 — 턴 도중 세션이 죽어도 오래 "작업 중"으로 남지 않게. */
export const WORKING_FRESH_MS = 3 * 60_000;

export const TICKET_TTL_MS = 60_000;

const PUBLIC_ID_RE = /^u-[0-9a-z]{10}$/;

export type RoomKind = 'plaza' | 'barracks';
export type MemberState = 'idle' | 'working';
export type Role = 'member' | 'spectator';

export interface Identity {
  pid: string;
  nick: string;
  agent: Agent;
}

export interface Member extends Identity {
  /** 연결 하나의 id (같은 유저가 웹·터미널로 각각 들어오면 나중 연결이 이전 것을 대체한다) */
  id: string;
  x: number;
  dir: 1 | -1;
  state: MemberState;
}

export interface OwnerPresence extends Identity {
  online: boolean;
  working: boolean;
}

export interface Door {
  pid: string;
  nick: string;
  agent: Agent;
  count: number;
  ownerOnline: boolean;
  ownerWorking: boolean;
  x: number;
}

export interface ChatLine {
  pid: string;
  nick: string;
  text: string;
  at: number;
}

export function roomKindOf(room: string): RoomKind | null {
  if (room === PLAZA_ID) return 'plaza';
  if (PUBLIC_ID_RE.test(room)) return 'barracks';
  return null;
}

export function isPublicId(v: unknown): v is string {
  return typeof v === 'string' && PUBLIC_ID_RE.test(v);
}

export function normalizeAgentName(v: unknown): Agent {
  return typeof v === 'string' && (AGENTS as readonly string[]).includes(v) ? (v as Agent) : 'claude-code';
}

const CHAT_STRIP_RE = /[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028-\u202e\u2066-\u2069]/g;

/** 채팅 본문 정리: 제어문자 제거, 공백 정리, 길이 제한. 비면 null. */
export function cleanChat(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  // 제어문자·폭 0 문자·방향 제어 문자(U+200B–200F, U+2028–202E, U+2066–2069)를 공백으로
  const s = v.replace(CHAT_STRIP_RE, ' ').replace(/\s+/g, ' ').trim();
  if (!s) return null;
  return Array.from(s).slice(0, CHAT_MAX_LEN).join('');
}

/**
 * 입장 가능 여부. others = 나를 뺀 지금 인원.
 * 막사는 주인 자리를 항상 비워 둔다: 주인은 언제나 들어오고, 방문자는 주인을 뺀 인원이 BARRACKS_CAP-1 미만일 때만.
 */
export function hasRoomFor(
  kind: RoomKind,
  isOwner: boolean,
  others: readonly { pid: string }[],
  ownerPid: string | null,
): boolean {
  if (kind === 'plaza') return others.length < PLAZA_CAP;
  if (isOwner) return true;
  return others.filter((m) => m.pid !== ownerPid).length < BARRACKS_CAP - 1;
}

export function clampX(v: unknown, width: number): number | null {
  if (typeof v !== 'number' || !Number.isFinite(v)) return null;
  return Math.max(0, Math.min(width - SPRITE_W, Math.round(v)));
}

/** 광장 문 배치: 정렬된 목록 순서대로 일정 간격. 클라이언트도 이 x 를 그대로 쓴다. */
export function layoutDoors(entries: Omit<Door, 'x'>[]): { doors: Door[]; width: number } {
  const sorted = [...entries]
    .sort(
      (a, b) =>
        Number(b.ownerWorking) - Number(a.ownerWorking) ||
        b.count - a.count ||
        Number(b.ownerOnline) - Number(a.ownerOnline) ||
        a.nick.localeCompare(b.nick),
    )
    .slice(0, MAX_DOORS);
  const doors = sorted.map((d, i) => ({ ...d, x: DOOR_FIRST_X + i * DOOR_GAP }));
  const width = Math.max(PLAZA_MIN_WIDTH, DOOR_FIRST_X + doors.length * DOOR_GAP + 16);
  return { doors, width };
}

/** 광장에 문을 세울 막사: 누가 있거나 주인이 켜져 있으면. */
export function isDoorVisible(d: Pick<Door, 'count' | 'ownerOnline'>): boolean {
  return d.count > 0 || d.ownerOnline;
}

export interface SessionBeat {
  state: MemberState;
  at: number;
}

/** 주인의 Claude 세션들(세션마다 하트비트) → 온라인·작업 중 판정. 하나라도 일하면 작업 중. */
export function ownerStatus(beats: Record<string, SessionBeat>, now: number): { online: boolean; working: boolean } {
  let online = false;
  let working = false;
  for (const b of Object.values(beats)) {
    if (now - b.at < PRESENCE_FRESH_MS) online = true;
    if (b.state === 'working' && now - b.at < WORKING_FRESH_MS) working = true;
  }
  return { online, working };
}

export function pruneBeats(beats: Record<string, SessionBeat>, now: number): Record<string, SessionBeat> {
  const out: Record<string, SessionBeat> = {};
  for (const [k, b] of Object.entries(beats)) if (now - b.at < PRESENCE_FRESH_MS) out[k] = b;
  return out;
}

// ── 티켓: 터미널(mod) 사이드카가 WebSocket 을 열 때 쓰는 60초짜리 서명 토큰 ──
// 비밀 userId 는 URL 에 싣지 않는다. 티켓 안에는 공개 정보(pid·nick·agent)와 만료만 있다.

function b64url(bytes: Uint8Array): string {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromB64url(s: string): Uint8Array {
  const b = atob(s.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((s.length + 3) % 4));
  return Uint8Array.from(b, (c) => c.charCodeAt(0));
}

async function hmacKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, [
    'sign',
    'verify',
  ]);
}

export async function signTicket(secret: string, id: Identity, now: number): Promise<string> {
  const body = b64url(
    new TextEncoder().encode(JSON.stringify({ p: id.pid, n: id.nick, a: id.agent, e: now + TICKET_TTL_MS })),
  );
  const sig = new Uint8Array(await crypto.subtle.sign('HMAC', await hmacKey(secret), new TextEncoder().encode(body)));
  return body + '.' + b64url(sig);
}

export async function verifyTicket(secret: string, ticket: string, now: number): Promise<Identity | null> {
  const [body, sig] = ticket.split('.');
  if (!body || !sig || ticket.length > 1024) return null;
  let ok = false;
  try {
    ok = await crypto.subtle.verify('HMAC', await hmacKey(secret), fromB64url(sig), new TextEncoder().encode(body));
  } catch {
    return null;
  }
  if (!ok) return null;
  try {
    const v = JSON.parse(new TextDecoder().decode(fromB64url(body))) as {
      p?: unknown;
      n?: unknown;
      a?: unknown;
      e?: unknown;
    };
    if (typeof v.e !== 'number' || v.e < now) return null;
    if (!isPublicId(v.p) || typeof v.n !== 'string' || !v.n) return null;
    return { pid: v.p, nick: v.n.slice(0, 40), agent: normalizeAgentName(v.a) };
  } catch {
    return null;
  }
}

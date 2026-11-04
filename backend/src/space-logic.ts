// 막사(Space) — 순수 로직 (DESIGN.md §27). Durable Object·Worker 양쪽과 테스트가 쓴다.
//
// 방 종류:
//   · 광장(plaza)   — 하나뿐. 막사 문이 줄지어 있고 걸어가서 들어간다. 최대 PLAZA_CAP 명.
//   · 막사(barracks) — 유저 1인당 1개, 이름 = 주인 public_id. 주인 포함 최대 BARRACKS_CAP 명.
// 관전자(비로그인 웹)는 정원에 들지 않고 말할 수 없다.

import type { Agent } from './validate';
import { AGENTS } from './validate';
import { RANK_MINS } from './briefing';

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
export const CHAT_TTL_MS = 24 * 60 * 60_000;
export const CHAT_MAX_LEN = 200;
export const SAY_MIN_INTERVAL_MS = 400;
export const MOVE_MIN_INTERVAL_MS = 60;

export const GUEST_MAX_LEN = 100;
export const GUEST_DAILY_LIMIT = 3; // 방문자당 막사별 하루(UTC)
export const GUEST_KEEP = 100; // 막사당 보관 줄 수
/** 브리핑 "다녀감" 집계 창. 주인이 막사에 안 들어와도 이보다 오래된 방문은 뉴스가 아니다. */
export const VISIT_WINDOW_MS = 7 * 24 * 60 * 60_000;
export const VISIT_KEEP = 200;
/** 같은 방문자의 재입장은 이 간격 안에서는 다시 기록하지 않는다(DO 쓰기 절약). */
export const VISIT_REWRITE_MS = 60 * 60_000;
/** 강퇴 후 재입장을 막는 시간. 막지 않으면 강퇴가 새로고침 한 번짜리가 된다. */
export const KICK_BLOCK_MS = 10 * 60_000;

/** 주인 상태 하트비트 신선도. 플러그인은 2분마다 보낸다 → 5분 끊기면 오프라인. */
export const PRESENCE_FRESH_MS = 5 * 60_000;
/** 작업 중(working) 신호는 더 짧게 — 턴 도중 세션이 죽어도 오래 "작업 중"으로 남지 않게. */
export const WORKING_FRESH_MS = 3 * 60_000;

/** 상태가 그대로면 광장 보고는 이 간격으로만. 광장은 보고 시각으로 신선도를 본다. */
export const REPORT_REFRESH_MS = 4 * 60_000;
/** 이만큼 보고가 끊긴 문은 불을 끈다 = 보고 간격 + 하트비트 2분 + 여유. */
export const DOOR_STALE_MS = 9 * 60_000;

export const TICKET_TTL_MS = 60_000;

const PUBLIC_ID_RE = /^u-[0-9a-z]{10}$/;

export type RoomKind = 'plaza' | 'barracks';
export type MemberState = 'idle' | 'working';
export type Role = 'member' | 'spectator';

export interface Identity {
  pid: string;
  nick: string;
  agent: Agent;
  /** 계급 인덱스(§16, 0=이병 … 11=장군). 이름은 클라이언트가 안다. */
  rank: number;
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
  locked: boolean;
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

export function normalizeRank(v: unknown): number {
  return Number.isInteger(v) && (v as number) >= 0 && (v as number) < RANK_MINS.length ? (v as number) : 0;
}

const CHAT_STRIP_RE = /[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028-\u202e\u2066-\u2069]/g;

/** 채팅 본문 정리: 제어문자 제거, 공백 정리, 길이 제한. 비면 null. */
export function cleanChat(v: unknown, max: number = CHAT_MAX_LEN): string | null {
  if (typeof v !== 'string') return null;
  // 제어문자·폭 0 문자·방향 제어 문자(U+200B–200F, U+2028–202E, U+2066–2069)를 공백으로
  const s = v.replace(CHAT_STRIP_RE, ' ').replace(/\s+/g, ' ').trim();
  if (!s) return null;
  return Array.from(s).slice(0, max).join('');
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

/** 24시간 지난 채팅을 뺀다. alarm 이 늦어도 hello 에 오래된 말이 실리지 않게 읽을 때도 거른다. */
export function pruneChat<T extends { at: number }>(chat: readonly T[], now: number): T[] {
  return chat.filter((l) => now - l.at < CHAT_TTL_MS);
}

/** 다음 정리 시각 = 가장 오래된 말이 만료되는 때. 지울 말이 없으면 null(alarm 을 걸지 않는다). */
export function nextChatAlarm(chat: readonly { at: number }[]): number | null {
  if (chat.length === 0) return null;
  return Math.min(...chat.map((l) => l.at)) + CHAT_TTL_MS;
}

// ── 방명록 · 방문 기록 (§27.8) ──

export interface GuestQuota {
  day: string;
  counts: Record<string, number>;
}

/** 오늘 이 방문자가 한 줄 더 남길 수 있나. 날이 바뀌면 전부 초기화되므로 표가 쌓이지 않는다. */
export function takeGuestQuota(q: GuestQuota | undefined, pid: string, day: string): GuestQuota | null {
  const counts = q?.day === day ? q.counts : {};
  const used = counts[pid] ?? 0;
  if (used >= GUEST_DAILY_LIMIT) return null;
  return { day, counts: { ...counts, [pid]: used + 1 } };
}

export interface VisitEntry {
  nick: string;
  at: number;
}

export interface VisitLog {
  /** 주인이 마지막으로 막사에 들어온 시각 — 브리핑은 그 뒤의 일만 센다 */
  seenAt: number;
  visits: Record<string, VisitEntry>;
}

/** 방문 기록. 바꿀 게 없으면 null(쓰기 생략). 오래된 항목은 지우고 VISIT_KEEP 안으로 자른다. */
export function recordVisit(log: VisitLog | undefined, pid: string, nick: string, now: number): VisitLog | null {
  const prev = log?.visits[pid];
  if (prev && prev.nick === nick && now - prev.at < VISIT_REWRITE_MS) return null;
  const entries = Object.entries(log?.visits ?? {}).filter(([k, v]) => k !== pid && now - v.at < VISIT_WINDOW_MS);
  entries.push([pid, { nick, at: now }]);
  entries.sort((a, b) => b[1].at - a[1].at);
  return { seenAt: log?.seenAt ?? 0, visits: Object.fromEntries(entries.slice(0, VISIT_KEEP)) };
}

/** 브리핑 한 줄의 재료: 주인이 마지막으로 들어온 뒤의 방문자 수·방명록 수(최근 7일만). */
export function visitSummary(
  log: VisitLog | undefined,
  guest: readonly { at: number }[],
  now: number,
): { visitors: number; guestbook: number } {
  const since = Math.max(log?.seenAt ?? 0, now - VISIT_WINDOW_MS);
  return {
    visitors: Object.values(log?.visits ?? {}).filter((v) => v.at > since).length,
    guestbook: guest.filter((l) => l.at > since).length,
  };
}

// ── 주인 권한: 강퇴 · 차단 (§27.9) ──

export interface BanEntry {
  nick: string;
  /** null = 영구 차단, 숫자 = 강퇴(이 시각까지 재입장 금지) */
  until: number | null;
}

export function activeBan(bans: Record<string, BanEntry> | undefined, pid: string, now: number): BanEntry | null {
  const b = bans?.[pid];
  return b && (b.until === null || b.until > now) ? b : null;
}

export function pruneBans(bans: Record<string, BanEntry>, now: number): Record<string, BanEntry> {
  return Object.fromEntries(Object.entries(bans).filter(([, b]) => b.until === null || b.until > now));
}

/** 닉네임(대소문자 무시) 또는 public_id 로 대상을 찾는다. 같은 닉이 둘이면 잘못된 사람을 내보내지 않게 모호 처리. */
export function findTarget<T extends { pid: string; nick: string }>(
  name: string,
  candidates: readonly T[],
): T | 'none' | 'ambiguous' {
  const q = name.trim().toLowerCase();
  const byPid = candidates.find((c) => c.pid === name.trim());
  if (byPid) return byPid;
  const hits = new Map<string, T>();
  for (const c of candidates) if (c.nick.toLowerCase() === q && !hits.has(c.pid)) hits.set(c.pid, c);
  if (hits.size === 0) return 'none';
  return hits.size === 1 ? [...hits.values()][0] : 'ambiguous';
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
    new TextEncoder().encode(
      JSON.stringify({ p: id.pid, n: id.nick, a: id.agent, r: id.rank, e: now + TICKET_TTL_MS }),
    ),
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
      r?: unknown;
      e?: unknown;
    };
    if (typeof v.e !== 'number' || v.e < now) return null;
    if (!isPublicId(v.p) || typeof v.n !== 'string' || !v.n) return null;
    return { pid: v.p, nick: v.n.slice(0, 40), agent: normalizeAgentName(v.a), rank: normalizeRank(v.r) };
  } catch {
    return null;
  }
}

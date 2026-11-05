// 막사(Space) — Worker 라우트 + Durable Object (DESIGN.md §27)
//
//   POST /space/ticket   { userId }                       → 60초 티켓 (터미널 mod 사이드카가 WS 열 때)
//   POST /space/status   { userId, sid, state, full? }    → 주인 작업 상태 하트비트 (세션마다)
//   POST /space/admin    { userId, action, target? }      → 주인 권한: 강퇴·차단·잠금·방명록 비우기
//   GET  /space/ws?room=plaza|<public_id>[&t=]            → WebSocket. 신원: 티켓 > 웹 세션 쿠키 > 관전자
//   GET  /plaza, /s/<public_id>                           → 웹 화면(web/space.html, OG 재작성)
//
// 방 1개 = SpaceRoom DO 1개(이름 = 'plaza' 또는 주인 public_id). WebSocket Hibernation 이라
// 아무도 말하지 않는 동안엔 duration 과금이 없다. 상태는 전부 DO 스토리지 — KV·D1 쓰기 0
// (처음 보는 userId 의 users 행 생성만 예외). D1 은 신원 조회 읽기뿐이다.

import { DurableObject } from 'cloudflare:workers';
import type { Env } from './types';
import { json, readJson } from './http';
import { getSession } from './session';
import { isValidUserId } from './validate';
import { displayNickname } from './nickname';
import { newPublicId } from './publicid';
import { rankIndexOf } from './briefing';
import { ogImageUrl, visitorCountry, withVisitorCountry } from './og';
import {
  BARRACKS_CAP,
  BARRACKS_WIDTH,
  CHAT_KEEP,
  CHAT_TTL_MS,
  DOOR_STALE_MS,
  GUEST_KEEP,
  GUEST_MAX_LEN,
  KICK_BLOCK_MS,
  MOVE_MIN_INTERVAL_MS,
  PLAZA_CAP,
  PLAZA_ID,
  REPORT_REFRESH_MS,
  SAY_MIN_INTERVAL_MS,
  VISIT_WINDOW_MS,
  SPECTATOR_CAP,
  type BanEntry,
  type ChatLine,
  type Door,
  type GuestQuota,
  type Identity,
  type Member,
  type MemberState,
  type OwnerPresence,
  type Role,
  type RoomKind,
  type SessionBeat,
  type SpaceInfo,
  type VisitLog,
  activeBan,
  clampX,
  cleanChat,
  findTarget,
  hasRoomFor,
  isDoorVisible,
  isPublicId,
  layoutDoors,
  nextCleanupAlarm,
  normalizeAgentName,
  ownerStatus,
  pruneBans,
  pruneBeats,
  pruneChat,
  pruneVisits,
  recordVisit,
  roomKindOf,
  signTicket,
  spaceOgTitle,
  takeGuestQuota,
  verifyTicket,
  visitSummary,
} from './space-logic';

const SID_RE = /^[A-Za-z0-9_-]{8,64}$/;
const SITE_ORIGIN = 'https://opencodewar.dev';

// ── 신원 조회 ──

interface IdentityRow {
  user_id: string;
  nickname: string | null;
  public_id: string | null;
  agent: string | null;
  prompts: number | null;
}

const IDENTITY_SQL = `SELECT u.user_id, u.nickname, u.public_id,
    (SELECT d.agent FROM daily_stats d WHERE d.user_id = u.user_id GROUP BY d.agent ORDER BY SUM(d.prompts) DESC LIMIT 1) AS agent,
    (SELECT COALESCE(SUM(d.prompts), 0) FROM daily_stats d WHERE d.user_id = u.user_id) AS prompts
  FROM users u`;

function toIdentity(row: IdentityRow | null): Identity | null {
  if (!row || !row.public_id) return null;
  return {
    pid: row.public_id,
    nick: displayNickname(row.nickname, row.user_id),
    agent: normalizeAgentName(row.agent),
    rank: rankIndexOf(Number(row.prompts) || 0),
  };
}

async function identityByUserId(env: Env, userId: string, create: boolean): Promise<Identity | null> {
  const stmt = env.DB.prepare(`${IDENTITY_SQL} WHERE u.user_id = ?`).bind(userId);
  const found = await stmt.first<IdentityRow>();
  if (found?.public_id || !create) return toIdentity(found);
  // 처음 보는 유저만 쓴다 — 하트비트마다 INSERT 를 시도하지 않는다.
  // /register 로 닉네임만 정한 유저는 첫 프롬프트 전까지 public_id 가 없으므로 여기서 채운다.
  await env.DB.prepare(
    `INSERT INTO users (user_id, public_id, created_at, last_seen_at) VALUES (?, ?, ?, ?)
     ON CONFLICT(user_id) DO UPDATE SET public_id = COALESCE(users.public_id, excluded.public_id)`,
  )
    .bind(userId, newPublicId(), Date.now(), Date.now())
    .run();
  return toIdentity(await stmt.first<IdentityRow>());
}

async function identityByPublicId(env: Env, pid: string): Promise<Identity | null> {
  return toIdentity(await env.DB.prepare(`${IDENTITY_SQL} WHERE u.public_id = ?`).bind(pid).first<IdentityRow>());
}

/**
 * pid·닉네임만 가져오는 가벼운 조회(행 1개 읽기). 하트비트는 세션당 2분마다 오므로 daily_stats 를 훑지 않는다
 * — 군복색·계급은 세션 시작(full)과 입장 때 갱신된다.
 */
async function ownerLite(env: Env, userId: string): Promise<Pick<Identity, 'pid' | 'nick'> | null> {
  const row = await env.DB.prepare('SELECT user_id, nickname, public_id FROM users WHERE user_id = ?')
    .bind(userId)
    .first<{ user_id: string; nickname: string | null; public_id: string | null }>();
  if (!row?.public_id) return null;
  return { pid: row.public_id, nick: displayNickname(row.nickname, row.user_id) };
}

// 서명 비밀값. 운영은 `wrangler secret put SPACE_SECRET`. 없으면 isolate 마다 랜덤(로컬 dev 전용 —
// 운영에서 비우면 isolate 가 바뀔 때 티켓이 무효가 된다).
let devSecret: string | null = null;
function ticketSecret(env: Env): string {
  if (env.SPACE_SECRET) return env.SPACE_SECRET;
  devSecret ??= crypto.randomUUID() + crypto.randomUUID();
  return devSecret;
}

function roomStub(env: Env, room: string): DurableObjectStub {
  return env.SPACE.get(env.SPACE.idFromName(room));
}

// ── Worker 라우트 ──

/** POST /space/ticket { userId } — 터미널 mod 용. 응답의 ticket 을 ?t= 로 붙여 WS 를 연다. */
export async function handleSpaceTicket(request: Request, env: Env): Promise<Response> {
  const body = await readJson(request);
  if (!body || !isValidUserId(body.userId)) return json({ error: 'invalid_userId' }, 400);
  const id = await identityByUserId(env, body.userId, true);
  if (!id) return json({ error: 'user_not_found' }, 404);
  const ticket = await signTicket(ticketSecret(env), id, Date.now());
  return json({ ticket, pid: id.pid, nick: id.nick, agent: id.agent, rank: id.rank });
}

/** POST /space/status { userId, sid, state } — 주인의 Claude 세션 하트비트(턴 시작·끝 + 2분마다). */
export async function handleSpaceStatus(request: Request, env: Env): Promise<Response> {
  const body = await readJson(request);
  if (!body || !isValidUserId(body.userId)) return json({ error: 'invalid_userId' }, 400);
  if (typeof body.sid !== 'string' || !SID_RE.test(body.sid)) return json({ error: 'invalid_sid' }, 400);
  const state = body.state === 'working' ? 'working' : body.state === 'offline' ? 'offline' : 'idle';
  // full = 세션 시작. 그때만 군복색·계급까지 다시 계산하고, 평소 하트비트는 가벼운 조회로 끝낸다.
  const id =
    (body.full === true ? null : await ownerLite(env, body.userId)) ??
    (await identityByUserId(env, body.userId, true));
  if (!id) return json({ error: 'user_not_found' }, 404);
  const res = await roomStub(env, id.pid).fetch('https://space/status', {
    method: 'POST',
    body: JSON.stringify({ owner: id, sid: body.sid, state }),
  });
  return json(await res.json());
}

const ADMIN_ACTIONS = new Set(['kick', 'ban', 'unban', 'bans', 'open', 'close', 'guest_clear']);

/** POST /space/admin { userId, action, target? } — 자기 막사에만 듣는다(userId 로 방이 정해진다). 터미널 mod 전용. */
export async function handleSpaceAdmin(request: Request, env: Env): Promise<Response> {
  const body = await readJson(request);
  if (!body || !isValidUserId(body.userId)) return json({ error: 'invalid_userId' }, 400);
  if (typeof body.action !== 'string' || !ADMIN_ACTIONS.has(body.action)) return json({ error: 'invalid_action' }, 400);
  const target = typeof body.target === 'string' ? body.target.slice(0, 64) : '';
  const owner = await identityByUserId(env, body.userId, false);
  if (!owner) return json({ error: 'user_not_found' }, 404);
  const res = await roomStub(env, owner.pid).fetch('https://space/admin', {
    method: 'POST',
    body: JSON.stringify({ owner, action: body.action, target }),
  });
  return json(await res.json(), res.status);
}

/** GET /space/ws?room=…[&t=…] — WebSocket 업그레이드를 그 방의 DO 로 넘긴다. */
export async function handleSpaceWs(request: Request, url: URL, env: Env): Promise<Response> {
  if (request.headers.get('upgrade')?.toLowerCase() !== 'websocket') return json({ error: 'expected_websocket' }, 426);
  const room = url.searchParams.get('room') ?? PLAZA_ID;
  const kind = roomKindOf(room);
  if (!kind) return json({ error: 'invalid_room' }, 400);

  // 신원: 티켓(터미널) > 웹 세션 쿠키 > 관전자
  let ident: Identity | null = null;
  const t = url.searchParams.get('t');
  if (t) {
    ident = await verifyTicket(ticketSecret(env), t, Date.now());
    if (!ident) return json({ error: 'invalid_ticket' }, 401);
  } else {
    const sess = await getSession(request, env);
    if (sess) ident = await identityByUserId(env, sess.userId, false);
  }

  let owner: Identity | null = null;
  if (kind === 'barracks') {
    owner = await identityByPublicId(env, room);
    if (!owner) return json({ error: 'room_not_found' }, 404);
  }

  const headers = new Headers(request.headers);
  headers.set('x-ocw-room', room);
  headers.set('x-ocw-ident', ident ? JSON.stringify(ident) : '');
  headers.set('x-ocw-owner', owner ? JSON.stringify(owner) : '');
  return roomStub(env, room).fetch(new Request('https://space/ws', { headers }));
}

/** /plaza, /s/<public_id> — 웹 화면. 같은 HTML 이 주소를 보고 방을 고른다. */
export function spacePageRoom(pathname: string): string | null {
  if (pathname === '/plaza' || pathname === '/plaza/') return PLAZA_ID;
  const m = /^\/s\/(u-[0-9a-z]{10})$/.exec(pathname);
  return m ? m[1] : null;
}

/**
 * 막사 공유 링크 미리보기(§27.10). 크롤러가 받는 HTML 의 메타만 그 막사의 지금 상태로 바꾼다 — handleBattlePage 패턴.
 * 없는(삭제된) 막사는 광장으로 보낸다. 안 그러면 웹이 없는 방에 WebSocket 재접속을 계속 시도한다.
 */
export async function handleSpacePage(request: Request, url: URL, env: Env): Promise<Response> {
  const res = await env.ASSETS.fetch(new Request(new URL('/space.html', url).toString(), { headers: request.headers }));
  const room = spacePageRoom(url.pathname);
  const country = visitorCountry(request); // 웹의 기본 언어 판정에 쓰인다(국가별로 HTML 이 달라져 private)
  if (!room || room === PLAZA_ID || res.status !== 200) {
    const page = withVisitorCountry(res, country);
    const out = new Response(page.body, page);
    out.headers.set('Cache-Control', 'private, no-cache');
    return out;
  }
  const row = await env.DB.prepare('SELECT user_id, nickname FROM users WHERE public_id = ?')
    .bind(room)
    .first<{ user_id: string; nickname: string | null }>();
  if (!row) return Response.redirect(new URL('/plaza', url).toString(), 302);

  const info = (await roomStub(env, room)
    .fetch('https://space/info')
    .then((r) => r.json())
    .catch(() => null)) as SpaceInfo | null;
  const title = spaceOgTitle(displayNickname(row.nickname, row.user_id), info);
  const desc = '코딩 에이전트를 돌리는 사람의 막사. 들어가서 구경하고 이야기해 보세요. Claude Code 에서는 /space';
  const pageUrl = `${SITE_ORIGIN}/s/${room}`;
  const setContent = (value: string) => ({
    element(el: Element) {
      el.setAttribute('content', value);
    },
  });
  const rewritten = new HTMLRewriter()
    .on('meta[name="ocw-country"]', setContent(country ?? ''))
    .on('title', {
      element(el) {
        el.setInnerContent(title);
      },
    })
    .on('meta[name="description"]', setContent(desc))
    .on('meta[property="og:title"]', setContent(title))
    .on('meta[property="og:description"]', setContent(desc))
    .on('meta[property="og:url"]', setContent(pageUrl))
    .on('meta[property="og:image"]', setContent(ogImageUrl(room)))
    .on('meta[name="twitter:title"]', setContent(title))
    .on('meta[name="twitter:description"]', setContent(desc))
    .on('meta[name="twitter:image"]', setContent(ogImageUrl(room)))
    .transform(res);
  const out = new Response(rewritten.body, rewritten);
  out.headers.set('Cache-Control', 'private, no-cache');
  return out;
}

// ── Durable Object ──

interface Attachment extends Member {
  role: Role;
  lastSay: number;
  lastMove: number;
}

interface DirEntry extends Omit<Door, 'x'> {
  at: number;
}

interface RoomMeta {
  id: string;
  kind: RoomKind;
  owner: Identity | null;
}

/** 입장 거부·퇴장 사유 → WebSocket close 코드 */
const CLOSE_CODE = { replaced: 4000, full: 4001, kicked: 4002, banned: 4003, closed: 4004 } as const;
type EndCode = keyof typeof CLOSE_CODE;

type Outgoing =
  | {
      t: 'hello';
      you: { id: string; role: Role; pid: string | null; nick: string | null; agent: string | null; rank: number };
      room: RoomInfo;
      members: Member[];
      chat: ChatLine[];
      guest: ChatLine[];
    }
  | { t: 'join'; m: Member }
  | { t: 'leave'; id: string }
  | { t: 'move'; id: string; x: number; dir: 1 | -1 }
  | { t: 'state'; id: string; state: MemberState }
  | { t: 'said'; line: ChatLine }
  | { t: 'guest'; line: ChatLine }
  | { t: 'guest_clear' }
  | { t: 'locked'; locked: boolean }
  | { t: 'owner'; owner: OwnerPresence }
  | { t: 'doors'; doors: Door[]; width: number }
  | { t: 'error'; code: string };

interface RoomInfo {
  id: string;
  kind: RoomKind;
  width: number;
  cap: number;
  owner: OwnerPresence | null;
  locked: boolean;
  doors?: Door[];
}

export class SpaceRoom extends DurableObject<Env> {
  /** 마지막 광장 보고(메모리 — hibernation 으로 사라지면 한 번 더 보고할 뿐이다) */
  private lastReport: { key: string; at: number } | null = null;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    // 클라이언트의 keepalive 'ping' 은 DO 를 깨우지 않고 런타임이 바로 'pong' 으로 답한다.
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair('ping', 'pong'));
  }

  // ── HTTP 진입점 (Worker 만 부른다) ──
  async fetch(request: Request): Promise<Response> {
    const path = new URL(request.url).pathname;
    if (path === '/ws') return this.accept(request);
    if (path === '/status' && request.method === 'POST') return this.onStatus(await request.json());
    if (path === '/report' && request.method === 'POST') return this.onReport(await request.json());
    if (path === '/admin' && request.method === 'POST') return this.onAdmin(await request.json());
    if (path === '/brief') return this.onBrief();
    if (path === '/info') return this.onInfo();
    if (path === '/wipe' && request.method === 'POST') return this.onWipe();
    return new Response('not found', { status: 404 });
  }

  private async read<T>(key: string): Promise<T | undefined> {
    return (await this.ctx.storage.get(key)) as T | undefined;
  }

  private async roomMeta(): Promise<RoomMeta | null> {
    return (await this.read<RoomMeta>('meta')) ?? null;
  }

  /** 주인 정보를 메타에 맞춘다. 하트비트의 가벼운 정보(pid·nick)는 저장된 군복색·계급 위에 덮는다. */
  private async ensureOwnerMeta(owner: Partial<Identity> & Pick<Identity, 'pid' | 'nick'>): Promise<RoomMeta> {
    const meta = await this.roomMeta();
    const merged: Identity = { agent: 'claude-code', rank: 0, ...meta?.owner, ...owner };
    if (meta && JSON.stringify(meta.owner) === JSON.stringify(merged)) return meta;
    const next: RoomMeta = { id: owner.pid, kind: 'barracks', owner: merged };
    await this.ctx.storage.put('meta', next);
    return next;
  }

  private members(): Attachment[] {
    const out: Attachment[] = [];
    for (const ws of this.ctx.getWebSockets('member')) {
      const a = ws.deserializeAttachment() as Attachment | null;
      if (a) out.push(a);
    }
    return out;
  }

  private broadcast(msg: Outgoing, except?: WebSocket): void {
    const s = JSON.stringify(msg);
    for (const ws of this.ctx.getWebSockets()) {
      if (ws === except) continue;
      try {
        ws.send(s);
      } catch {
        // 닫히는 중인 소켓 — close 핸들러가 정리한다
      }
    }
  }

  /** 이 유저의 연결을 끝낸다. 저쪽이 닫기 응답을 안 해도 인원에서 바로 빠지도록 여기서 정리한다. */
  private endMember(pid: string, code: EndCode): number {
    let n = 0;
    for (const ws of this.ctx.getWebSockets('member')) {
      const a = ws.deserializeAttachment() as Attachment | null;
      if (a?.pid !== pid) continue;
      n += 1;
      ws.serializeAttachment(null);
      this.broadcast({ t: 'leave', id: a.id }, ws);
      try {
        ws.send(JSON.stringify({ t: 'error', code } satisfies Outgoing));
        ws.close(CLOSE_CODE[code], code);
      } catch {}
    }
    return n;
  }

  private async presence(owner: Identity, now = Date.now()): Promise<OwnerPresence> {
    const beats = (await this.read<Record<string, SessionBeat>>('beats')) ?? {};
    return { ...owner, ...ownerStatus(beats, now) };
  }

  private async plazaDoors(now = Date.now()): Promise<{ doors: Door[]; width: number }> {
    const dir = (await this.read<Record<string, DirEntry>>('dir')) ?? {};
    const live: Omit<Door, 'x'>[] = [];
    for (const e of Object.values(dir)) {
      const stale = now - e.at > DOOR_STALE_MS;
      const d = { ...e, ownerOnline: e.ownerOnline && !stale, ownerWorking: e.ownerWorking && !stale };
      if (isDoorVisible(d))
        live.push({
          pid: d.pid,
          nick: d.nick,
          agent: d.agent,
          count: d.count,
          ownerOnline: d.ownerOnline,
          ownerWorking: d.ownerWorking,
          locked: d.locked,
        });
    }
    return layoutDoors(live);
  }

  private async roomInfo(meta: RoomMeta): Promise<RoomInfo> {
    if (meta.kind === 'plaza') {
      const { doors, width } = await this.plazaDoors();
      return { id: meta.id, kind: 'plaza', width, cap: PLAZA_CAP, owner: null, locked: false, doors };
    }
    return {
      id: meta.id,
      kind: 'barracks',
      width: BARRACKS_WIDTH,
      cap: BARRACKS_CAP,
      owner: meta.owner ? await this.presence(meta.owner) : null,
      locked: (await this.read<boolean>('locked')) ?? false,
    };
  }

  /**
   * 막사 → 광장: 인원·주인 상태 보고. 하트비트(force=false)는 바뀐 게 없으면 REPORT_REFRESH_MS 마다만 보낸다
   * — 세션당 2분마다 광장 DO 요청·쓰기가 나가지 않게.
   */
  private async reportToPlaza(meta: RoomMeta, force = true): Promise<void> {
    if (meta.kind !== 'barracks' || !meta.owner) return;
    const now = Date.now();
    const p = await this.presence(meta.owner, now);
    const body = {
      pid: meta.owner.pid,
      nick: meta.owner.nick,
      agent: meta.owner.agent,
      count: this.members().length,
      ownerOnline: p.online,
      ownerWorking: p.working,
      locked: (await this.read<boolean>('locked')) ?? false,
    };
    const key = JSON.stringify(body);
    if (!force && this.lastReport?.key === key && now - this.lastReport.at < REPORT_REFRESH_MS) return;
    this.lastReport = { key, at: now };
    try {
      await this.env.SPACE.get(this.env.SPACE.idFromName(PLAZA_ID)).fetch('https://space/report', {
        method: 'POST',
        body: key,
      });
    } catch (err) {
      console.error(JSON.stringify({ level: 'warn', msg: 'space_report_failed', err: String(err) }));
    }
  }

  /** 안 받는 연결: 이유만 알리고 닫는다. 태그가 달라 인원·관전자 수·소켓 정리에 잡히지 않는다. */
  private refuse(server: WebSocket, client: WebSocket, code: EndCode): Response {
    this.ctx.acceptWebSocket(server, ['refused']);
    server.send(JSON.stringify({ t: 'error', code } satisfies Outgoing));
    server.close(CLOSE_CODE[code], code);
    return new Response(null, { status: 101, webSocket: client });
  }

  // ── 입장 ──
  private async accept(request: Request): Promise<Response> {
    const room = request.headers.get('x-ocw-room') ?? '';
    const kind = roomKindOf(room);
    if (!kind) return new Response('bad room', { status: 400 });
    const identRaw = request.headers.get('x-ocw-ident');
    const ownerRaw = request.headers.get('x-ocw-owner');
    const ident: Identity | null = identRaw ? JSON.parse(identRaw) : null;
    const owner: Identity | null = ownerRaw ? JSON.parse(ownerRaw) : null;

    // 방 메타: 처음 한 번 저장, 주인 닉네임이 바뀌면 갱신
    let meta = await this.roomMeta();
    if (!meta || JSON.stringify(meta.owner) !== JSON.stringify(owner)) {
      meta = { id: room, kind, owner };
      await this.ctx.storage.put('meta', meta);
    }

    const pair = new WebSocketPair();
    const [client, server] = [pair[0], pair[1]];
    const role: Role = ident ? 'member' : 'spectator';
    const now = Date.now();
    const isOwner = !!(ident && meta.owner && ident.pid === meta.owner.pid);

    // 거부 판정이 대체보다 먼저 — 차단된 사람이 다시 들어와도 기존 연결을 건드리지 않는다
    if (kind === 'barracks' && !isOwner) {
      if (ident) {
        const ban = activeBan(await this.read<Record<string, BanEntry>>('bans'), ident.pid, now);
        if (ban) return this.refuse(server, client, ban.until === null ? 'banned' : 'kicked');
      }
      if (await this.read<boolean>('locked')) return this.refuse(server, client, 'closed');
    }
    const others = this.members().filter((m) => m.pid !== ident?.pid);
    if (role === 'member' && !hasRoomFor(kind, isOwner, others, meta.owner?.pid ?? null))
      return this.refuse(server, client, 'full');
    if (role === 'spectator' && this.ctx.getWebSockets('spectator').length >= SPECTATOR_CAP)
      return this.refuse(server, client, 'full');

    // 같은 유저가 다시 들어오면(웹 ↔ 터미널, 재연결) 이전 연결을 대체한다
    if (ident) this.endMember(ident.pid, 'replaced');
    this.ctx.acceptWebSocket(server, [role]);

    // 방문 기록(§27.8): 주인이 들어오면 그때까지의 소식은 본 것으로 친다
    if (kind === 'barracks' && ident) {
      const log = await this.read<VisitLog>('visitlog');
      if (isOwner) await this.ctx.storage.put('visitlog', { seenAt: now, visits: log?.visits ?? {} } satisfies VisitLog);
      else {
        const next = recordVisit(log, ident.pid, ident.nick, now);
        if (next) {
          await this.ctx.storage.put('visitlog', next);
          // 이미 걸린 alarm 이 있으면 그 alarm 이 다음 시각을 다시 계산한다.
          if ((await this.ctx.storage.getAlarm()) === null) await this.ctx.storage.setAlarm(now + VISIT_WINDOW_MS);
        }
      }
    }

    const width = kind === 'plaza' ? (await this.plazaDoors()).width : BARRACKS_WIDTH;
    const spawnX = kind === 'plaza' ? 8 + Math.floor(Math.random() * 12) : 14 + Math.floor(Math.random() * 20);
    const a: Attachment = {
      id: crypto.randomUUID().slice(0, 8),
      role,
      pid: ident?.pid ?? '',
      nick: ident?.nick ?? '',
      agent: ident?.agent ?? 'claude-code',
      rank: ident?.rank ?? 0,
      x: Math.min(spawnX, width - 8),
      dir: 1,
      state: 'idle',
      lastSay: 0,
      lastMove: 0,
    };
    server.serializeAttachment(a);

    const chat = pruneChat((await this.read<ChatLine[]>('chat')) ?? [], now);
    const guest = kind === 'barracks' ? ((await this.read<ChatLine[]>('guest')) ?? []) : [];
    server.send(
      JSON.stringify({
        t: 'hello',
        you: {
          id: a.id,
          role,
          pid: ident?.pid ?? null,
          nick: ident?.nick ?? null,
          agent: ident?.agent ?? null,
          rank: ident?.rank ?? 0,
        },
        room: await this.roomInfo(meta),
        members: others.map(publicMember),
        chat: chat.slice(-30),
        guest: guest.slice(-20),
      } satisfies Outgoing),
    );
    if (role === 'member') {
      this.broadcast({ t: 'join', m: publicMember(a) }, server);
      await this.reportToPlaza(meta);
    }
    return new Response(null, { status: 101, webSocket: client });
  }

  // ── 메시지 ──
  async webSocketMessage(ws: WebSocket, raw: string | ArrayBuffer): Promise<void> {
    const a = ws.deserializeAttachment() as Attachment | null;
    if (!a || a.role !== 'member' || typeof raw !== 'string' || raw.length > 2048) return;
    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }
    const now = Date.now();
    const meta = await this.roomMeta();
    if (!meta) return;
    const tell = (code: string) => ws.send(JSON.stringify({ t: 'error', code } satisfies Outgoing));

    if (msg.t === 'move') {
      if (now - a.lastMove < MOVE_MIN_INTERVAL_MS) return;
      const width = meta.kind === 'plaza' ? (await this.plazaDoors(now)).width : BARRACKS_WIDTH;
      const x = clampX(msg.x, width);
      if (x === null) return;
      a.x = x;
      a.dir = msg.dir === -1 ? -1 : 1;
      a.lastMove = now;
      ws.serializeAttachment(a);
      this.broadcast({ t: 'move', id: a.id, x: a.x, dir: a.dir }, ws);
      return;
    }
    if (msg.t === 'state') {
      const state: MemberState = msg.state === 'working' ? 'working' : 'idle';
      if (state === a.state) return;
      a.state = state;
      ws.serializeAttachment(a);
      this.broadcast({ t: 'state', id: a.id, state });
      return;
    }
    if (msg.t === 'say' || msg.t === 'guest') {
      if (now - a.lastSay < SAY_MIN_INTERVAL_MS) return tell('slow_down');
      if (msg.t === 'guest') return this.onGuest(ws, a, meta, msg.text, now);
      const text = cleanChat(msg.text);
      if (!text) return;
      a.lastSay = now;
      ws.serializeAttachment(a);
      const line: ChatLine = { pid: a.pid, nick: a.nick, text, at: now };
      const chat = (await this.read<ChatLine[]>('chat')) ?? [];
      chat.push(line);
      await this.ctx.storage.put('chat', chat.slice(-CHAT_KEEP));
      // 방문 기록용 alarm(최대 7일 뒤)이 걸려 있을 수 있다. 채팅 만료보다 늦으면 앞당긴다.
      const alarm = await this.ctx.storage.getAlarm();
      if (alarm === null || alarm > now + CHAT_TTL_MS) await this.ctx.storage.setAlarm(now + CHAT_TTL_MS);
      this.broadcast({ t: 'said', line });
    }
  }

  /** 방명록(§27.8): 주인이 이 방에 없을 때 방문자가 한 줄. 100자, 막사별 하루 3건. */
  private async onGuest(ws: WebSocket, a: Attachment, meta: RoomMeta, raw: unknown, now: number): Promise<void> {
    const tell = (code: string) => ws.send(JSON.stringify({ t: 'error', code } satisfies Outgoing));
    if (meta.kind !== 'barracks' || !meta.owner) return;
    if (a.pid === meta.owner.pid || this.members().some((m) => m.pid === meta.owner?.pid)) return tell('guest_owner_here');
    const text = cleanChat(raw, GUEST_MAX_LEN);
    if (!text) return;
    const quota = takeGuestQuota(await this.read<GuestQuota>('guestquota'), a.pid, new Date(now).toISOString().slice(0, 10));
    if (!quota) return tell('guest_limit');
    a.lastSay = now;
    ws.serializeAttachment(a);
    const line: ChatLine = { pid: a.pid, nick: a.nick, text, at: now };
    const guest = (await this.read<ChatLine[]>('guest')) ?? [];
    guest.push(line);
    await this.ctx.storage.put({ guest: guest.slice(-GUEST_KEEP), guestquota: quota });
    this.broadcast({ t: 'guest', line });
  }

  async webSocketClose(ws: WebSocket): Promise<void> {
    await this.onGone(ws);
  }

  async webSocketError(ws: WebSocket): Promise<void> {
    await this.onGone(ws);
  }

  private async onGone(ws: WebSocket): Promise<void> {
    const a = ws.deserializeAttachment() as Attachment | null;
    if (!a || a.role !== 'member') return;
    ws.serializeAttachment(null); // 두 번 처리 방지
    this.broadcast({ t: 'leave', id: a.id }, ws);
    const meta = await this.roomMeta();
    if (meta) await this.reportToPlaza(meta);
  }

  // ── 채팅 24시간 · 방문 기록 7일 정리. DO 안 setInterval 은 hibernation 을 깨므로 alarm 으로 한다 (§27.5) ──
  async alarm(): Promise<void> {
    const now = Date.now();
    const chat = (await this.read<ChatLine[]>('chat')) ?? [];
    const kept = pruneChat(chat, now);
    if (kept.length === 0) await this.ctx.storage.delete('chat');
    else if (kept.length !== chat.length) await this.ctx.storage.put('chat', kept);
    const log = await this.read<VisitLog>('visitlog');
    const keptLog = pruneVisits(log, now);
    if (log && keptLog && Object.keys(keptLog.visits).length !== Object.keys(log.visits).length)
      await this.ctx.storage.put('visitlog', keptLog);
    // 방명록 하루 제한 표도 방문자 ID 를 담는다. 날이 지나면 쓸모가 없으니 함께 지운다.
    const quota = await this.read<GuestQuota>('guestquota');
    if (quota && quota.day !== new Date(now).toISOString().slice(0, 10)) await this.ctx.storage.delete('guestquota');
    const next = nextCleanupAlarm(kept, keptLog);
    if (next !== null) await this.ctx.storage.setAlarm(next);
  }

  // ── 주인 하트비트 (막사 DO) ──
  private async onStatus(body: {
    owner: Partial<Identity> & Pick<Identity, 'pid' | 'nick'>;
    sid: string;
    state: 'working' | 'idle' | 'offline';
  }): Promise<Response> {
    const now = Date.now();
    const meta = await this.ensureOwnerMeta(body.owner);
    const owner = meta.owner!;
    const before = await this.presence(owner, now);
    const beats = pruneBeats((await this.read<Record<string, SessionBeat>>('beats')) ?? {}, now);
    if (body.state === 'offline') delete beats[body.sid];
    else beats[body.sid] = { state: body.state, at: now };
    await this.ctx.storage.put('beats', beats);
    const after = await this.presence(owner, now);
    if (before.online !== after.online || before.working !== after.working)
      this.broadcast({ t: 'owner', owner: after });
    await this.reportToPlaza(meta, false);
    return Response.json({ ok: true, online: after.online, working: after.working });
  }

  // ── 주인 권한 (막사 DO, §27.9) ──
  private async onAdmin(body: { owner: Identity; action: string; target: string }): Promise<Response> {
    const now = Date.now();
    const meta = await this.ensureOwnerMeta(body.owner);
    const fail = (error: string, status = 400) => Response.json({ ok: false, error }, { status });
    const bans = pruneBans((await this.read<Record<string, BanEntry>>('bans')) ?? {}, now);

    if (body.action === 'bans') {
      return Response.json({ ok: true, bans: Object.values(bans).filter((b) => b.until === null).map((b) => b.nick) });
    }
    if (body.action === 'open' || body.action === 'close') {
      const locked = body.action === 'close';
      await this.ctx.storage.put('locked', locked);
      this.broadcast({ t: 'locked', locked });
      await this.reportToPlaza(meta);
      return Response.json({ ok: true, locked });
    }
    if (body.action === 'guest_clear') {
      await this.ctx.storage.delete('guest');
      this.broadcast({ t: 'guest_clear' });
      return Response.json({ ok: true });
    }
    if (body.action === 'unban') {
      const hit = findTarget(body.target, Object.entries(bans).map(([pid, b]) => ({ pid, nick: b.nick })));
      if (hit === 'none' || hit === 'ambiguous') return fail(hit === 'none' ? 'not_found' : 'ambiguous');
      delete bans[hit.pid];
      await this.ctx.storage.put('bans', bans);
      return Response.json({ ok: true, target: hit.nick });
    }
    // kick · ban: 지금 있는 사람 먼저, 그다음 최근 다녀간 사람
    const log = await this.read<VisitLog>('visitlog');
    const hit = findTarget(body.target, [
      ...this.members().map((m) => ({ pid: m.pid, nick: m.nick })),
      ...Object.entries(log?.visits ?? {}).map(([pid, v]) => ({ pid, nick: v.nick })),
    ]);
    if (hit === 'none' || hit === 'ambiguous') return fail(hit === 'none' ? 'not_found' : 'ambiguous');
    if (hit.pid === meta.owner?.pid) return fail('not_self');
    const isBan = body.action === 'ban';
    bans[hit.pid] = { nick: hit.nick, until: isBan ? null : now + KICK_BLOCK_MS };
    await this.ctx.storage.put('bans', bans);
    if (isBan) {
      // 차단한 사람의 방명록도 함께 내린다 — 그걸 지우려고 차단하는 경우가 많다
      const guest = (await this.read<ChatLine[]>('guest')) ?? [];
      const kept = guest.filter((l) => l.pid !== hit.pid);
      if (kept.length !== guest.length) {
        await this.ctx.storage.put('guest', kept);
        this.broadcast({ t: 'guest_clear' });
        for (const line of kept.slice(-20)) this.broadcast({ t: 'guest', line });
      }
    }
    const present = this.endMember(hit.pid, isBan ? 'banned' : 'kicked');
    if (present > 0) await this.reportToPlaza(meta);
    return Response.json({ ok: true, target: hit.nick, present: present > 0 });
  }

  /** 세션 브리핑(§27.8) 재료. 주인이 막사에 들어오면 0 으로 돌아간다. */
  private async onBrief(): Promise<Response> {
    const log = await this.read<VisitLog>('visitlog');
    const guest = (await this.read<ChatLine[]>('guest')) ?? [];
    return Response.json(visitSummary(log, guest, Date.now()));
  }

  /** OG 미리보기(§27.10)용 현재 상태 */
  private async onInfo(): Promise<Response> {
    const meta = await this.roomMeta();
    const p = meta?.owner ? await this.presence(meta.owner) : null;
    return Response.json({
      count: this.members().length,
      working: !!p?.working,
      online: !!p?.online,
      locked: (await this.read<boolean>('locked')) ?? false,
    } satisfies SpaceInfo);
  }

  /** 계정 삭제(§27.9): 있던 사람을 내보내고 이 막사의 저장 내용을 전부 지운다. 광장의 문도 내린다. */
  private async onWipe(): Promise<Response> {
    const meta = await this.roomMeta();
    for (const ws of this.ctx.getWebSockets()) {
      ws.serializeAttachment(null);
      try {
        ws.send(JSON.stringify({ t: 'error', code: 'closed' } satisfies Outgoing));
        ws.close(CLOSE_CODE.closed, 'closed');
      } catch {}
    }
    await this.ctx.storage.delete('beats');
    if (meta) await this.reportToPlaza(meta);
    await this.ctx.storage.deleteAlarm();
    await this.ctx.storage.deleteAll();
    return Response.json({ ok: true });
  }

  // ── 막사 목록 (광장 DO) ──
  private async onReport(body: Omit<DirEntry, 'at'>): Promise<Response> {
    if (!isPublicId(body.pid)) return new Response('bad', { status: 400 });
    if (!(await this.roomMeta())) await this.ctx.storage.put('meta', { id: PLAZA_ID, kind: 'plaza', owner: null });
    const now = Date.now();
    const dir = (await this.read<Record<string, DirEntry>>('dir')) ?? {};
    const before = JSON.stringify(await this.plazaDoors(now));
    const entry: DirEntry = {
      pid: body.pid,
      nick: String(body.nick).slice(0, 40),
      agent: normalizeAgentName(body.agent),
      count: Math.max(0, Math.min(BARRACKS_CAP, Number(body.count) || 0)),
      ownerOnline: !!body.ownerOnline,
      ownerWorking: !!body.ownerWorking,
      locked: !!body.locked,
      at: now,
    };
    if (isDoorVisible(entry)) dir[body.pid] = entry;
    else delete dir[body.pid];
    // 오래된 항목 정리
    for (const [k, e] of Object.entries(dir)) if (now - e.at > 30 * 60_000) delete dir[k];
    await this.ctx.storage.put('dir', dir);
    const after = await this.plazaDoors(now);
    if (JSON.stringify(after) !== before) this.broadcast({ t: 'doors', ...after });
    return Response.json({ ok: true });
  }
}

function publicMember(a: Attachment): Member {
  return { id: a.id, pid: a.pid, nick: a.nick, agent: a.agent, rank: a.rank, x: a.x, dir: a.dir, state: a.state };
}

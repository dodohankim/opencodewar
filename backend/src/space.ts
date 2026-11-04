// 막사(Space) — Worker 라우트 + Durable Object (DESIGN.md §27)
//
//   POST /space/ticket   { userId }              → 60초 티켓 (터미널 mod 사이드카가 WS 열 때)
//   POST /space/status   { userId, sid, state }  → 주인 작업 상태 하트비트 (세션마다)
//   GET  /space/ws?room=plaza|<public_id>[&t=]   → WebSocket. 신원: 티켓 > 웹 세션 쿠키 > 관전자
//   GET  /plaza, /s/<public_id>                  → 웹 화면(web/space.html)
//
// 방 1개 = SpaceRoom DO 1개(이름 = 'plaza' 또는 주인 public_id). WebSocket Hibernation 이라
// 아무도 말하지 않는 동안엔 duration 과금이 없다. D1 은 연결·상태 보고 때 신원 조회만 읽는다(쓰기 0).

import { DurableObject } from 'cloudflare:workers';
import type { Env } from './types';
import { json, readJson } from './http';
import { getSession } from './session';
import { isValidUserId } from './validate';
import { displayNickname } from './nickname';
import { newPublicId } from './publicid';
import {
  BARRACKS_CAP,
  BARRACKS_WIDTH,
  CHAT_KEEP,
  MOVE_MIN_INTERVAL_MS,
  PLAZA_CAP,
  PLAZA_ID,
  SAY_MIN_INTERVAL_MS,
  SPECTATOR_CAP,
  type ChatLine,
  type Door,
  type Identity,
  type Member,
  type MemberState,
  type OwnerPresence,
  type Role,
  type RoomKind,
  type SessionBeat,
  clampX,
  cleanChat,
  isDoorVisible,
  isPublicId,
  layoutDoors,
  normalizeAgentName,
  ownerStatus,
  pruneBeats,
  roomKindOf,
  signTicket,
  verifyTicket,
} from './space-logic';

const SID_RE = /^[A-Za-z0-9_-]{8,64}$/;

// ── 신원 조회 ──

interface IdentityRow {
  user_id: string;
  nickname: string | null;
  public_id: string | null;
  agent: string | null;
}

const IDENTITY_SQL = `SELECT u.user_id, u.nickname, u.public_id,
    (SELECT d.agent FROM daily_stats d WHERE d.user_id = u.user_id GROUP BY d.agent ORDER BY SUM(d.prompts) DESC LIMIT 1) AS agent
  FROM users u`;

function toIdentity(row: IdentityRow | null): Identity | null {
  if (!row || !row.public_id) return null;
  return { pid: row.public_id, nick: displayNickname(row.nickname, row.user_id), agent: normalizeAgentName(row.agent) };
}

async function identityByUserId(env: Env, userId: string, create: boolean): Promise<Identity | null> {
  if (create) {
    await env.DB.prepare(
      'INSERT INTO users (user_id, public_id, created_at, last_seen_at) VALUES (?, ?, ?, ?) ON CONFLICT(user_id) DO NOTHING',
    )
      .bind(userId, newPublicId(), Date.now(), Date.now())
      .run();
  }
  return toIdentity(await env.DB.prepare(`${IDENTITY_SQL} WHERE u.user_id = ?`).bind(userId).first<IdentityRow>());
}

async function identityByPublicId(env: Env, pid: string): Promise<Identity | null> {
  return toIdentity(await env.DB.prepare(`${IDENTITY_SQL} WHERE u.public_id = ?`).bind(pid).first<IdentityRow>());
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
  return json({ ticket, pid: id.pid, nick: id.nick, agent: id.agent });
}

/** POST /space/status { userId, sid, state } — 주인의 Claude 세션 하트비트(턴 시작·끝 + 2분마다). */
export async function handleSpaceStatus(request: Request, env: Env): Promise<Response> {
  const body = await readJson(request);
  if (!body || !isValidUserId(body.userId)) return json({ error: 'invalid_userId' }, 400);
  if (typeof body.sid !== 'string' || !SID_RE.test(body.sid)) return json({ error: 'invalid_sid' }, 400);
  const state = body.state === 'working' ? 'working' : body.state === 'offline' ? 'offline' : 'idle';
  const id = await identityByUserId(env, body.userId, true);
  if (!id) return json({ error: 'user_not_found' }, 404);
  const res = await roomStub(env, id.pid).fetch('https://space/status', {
    method: 'POST',
    body: JSON.stringify({ owner: id, sid: body.sid, state }),
  });
  return json(await res.json());
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

export async function handleSpacePage(request: Request, url: URL, env: Env): Promise<Response> {
  const res = await env.ASSETS.fetch(new Request(new URL('/space.html', url).toString(), { headers: request.headers }));
  const out = new Response(res.body, res);
  out.headers.set('Cache-Control', 'no-cache');
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

type Outgoing =
  | {
      t: 'hello';
      you: { id: string; role: Role; pid: string | null; nick: string | null; agent: string | null };
      room: RoomInfo;
      members: Member[];
      chat: ChatLine[];
    }
  | { t: 'join'; m: Member }
  | { t: 'leave'; id: string }
  | { t: 'move'; id: string; x: number; dir: 1 | -1 }
  | { t: 'state'; id: string; state: MemberState }
  | { t: 'said'; line: ChatLine }
  | { t: 'owner'; owner: OwnerPresence }
  | { t: 'doors'; doors: Door[]; width: number }
  | { t: 'error'; code: string };

interface RoomInfo {
  id: string;
  kind: RoomKind;
  width: number;
  cap: number;
  owner: OwnerPresence | null;
  doors?: Door[];
}

export class SpaceRoom extends DurableObject<Env> {
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
    return new Response('not found', { status: 404 });
  }

  private async roomMeta(): Promise<{ id: string; kind: RoomKind; owner: Identity | null } | null> {
    return (await this.ctx.storage.get('meta')) ?? null;
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

  private async presence(owner: Identity, now = Date.now()): Promise<OwnerPresence> {
    const beats = ((await this.ctx.storage.get('beats')) as Record<string, SessionBeat> | undefined) ?? {};
    return { ...owner, ...ownerStatus(beats, now) };
  }

  private async plazaDoors(now = Date.now()): Promise<{ doors: Door[]; width: number }> {
    const dir = ((await this.ctx.storage.get('dir')) as Record<string, DirEntry> | undefined) ?? {};
    const live: Omit<Door, 'x'>[] = [];
    for (const e of Object.values(dir)) {
      // 보고가 끊긴 주인은 오프라인으로 본다(하트비트 2분 · 신선도 5분)
      const stale = now - e.at > 5 * 60_000;
      const d = { ...e, ownerOnline: e.ownerOnline && !stale, ownerWorking: e.ownerWorking && !stale };
      if (isDoorVisible(d))
        live.push({
          pid: d.pid,
          nick: d.nick,
          agent: d.agent,
          count: d.count,
          ownerOnline: d.ownerOnline,
          ownerWorking: d.ownerWorking,
        });
    }
    return layoutDoors(live);
  }

  private async roomInfo(meta: { id: string; kind: RoomKind; owner: Identity | null }): Promise<RoomInfo> {
    if (meta.kind === 'plaza') {
      const { doors, width } = await this.plazaDoors();
      return { id: meta.id, kind: 'plaza', width, cap: PLAZA_CAP, owner: null, doors };
    }
    return {
      id: meta.id,
      kind: 'barracks',
      width: BARRACKS_WIDTH,
      cap: BARRACKS_CAP,
      owner: meta.owner ? await this.presence(meta.owner) : null,
    };
  }

  /** 막사 → 광장: 인원·주인 상태가 바뀔 때마다 알린다 */
  private async reportToPlaza(meta: { id: string; kind: RoomKind; owner: Identity | null }): Promise<void> {
    if (meta.kind !== 'barracks' || !meta.owner) return;
    const p = await this.presence(meta.owner);
    const count = this.members().length;
    try {
      await this.env.SPACE.get(this.env.SPACE.idFromName(PLAZA_ID)).fetch('https://space/report', {
        method: 'POST',
        body: JSON.stringify({
          pid: meta.owner.pid,
          nick: meta.owner.nick,
          agent: meta.owner.agent,
          count,
          ownerOnline: p.online,
          ownerWorking: p.working,
        }),
      });
    } catch (err) {
      console.error(JSON.stringify({ level: 'warn', msg: 'space_report_failed', err: String(err) }));
    }
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

    // 같은 유저가 다시 들어오면(웹 ↔ 터미널, 재연결) 이전 연결을 대체한다
    if (ident) {
      for (const ws of this.ctx.getWebSockets('member')) {
        const a = ws.deserializeAttachment() as Attachment | null;
        if (a?.pid === ident.pid) {
          try {
            ws.send(JSON.stringify({ t: 'error', code: 'replaced' } satisfies Outgoing));
            ws.close(4000, 'replaced');
          } catch {}
        }
      }
    }

    const others = this.members().filter((m) => m.pid !== ident?.pid);
    const isOwner = !!(ident && meta.owner && ident.pid === meta.owner.pid);
    const cap = kind === 'plaza' ? PLAZA_CAP : isOwner ? BARRACKS_CAP : BARRACKS_CAP - 1; // 주인 자리 예약
    const spectators = this.ctx.getWebSockets('spectator').length;

    this.ctx.acceptWebSocket(server, [role]);
    if ((role === 'member' && others.length >= cap) || (role === 'spectator' && spectators >= SPECTATOR_CAP)) {
      server.send(JSON.stringify({ t: 'error', code: 'full' } satisfies Outgoing));
      server.close(4001, 'full');
      return new Response(null, { status: 101, webSocket: client });
    }

    const width = kind === 'plaza' ? (await this.plazaDoors()).width : BARRACKS_WIDTH;
    const spawnX = kind === 'plaza' ? 8 + Math.floor(Math.random() * 12) : 14 + Math.floor(Math.random() * 20);
    const a: Attachment = {
      id: crypto.randomUUID().slice(0, 8),
      role,
      pid: ident?.pid ?? '',
      nick: ident?.nick ?? '',
      agent: ident?.agent ?? 'claude-code',
      x: Math.min(spawnX, width - 8),
      dir: 1,
      state: 'idle',
      lastSay: 0,
      lastMove: 0,
    };
    server.serializeAttachment(a);

    const chat = ((await this.ctx.storage.get('chat')) as ChatLine[] | undefined) ?? [];
    server.send(
      JSON.stringify({
        t: 'hello',
        you: { id: a.id, role, pid: ident?.pid ?? null, nick: ident?.nick ?? null, agent: ident?.agent ?? null },
        room: await this.roomInfo(meta),
        members: others.map(publicMember),
        chat: chat.slice(-30),
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
    if (msg.t === 'say') {
      if (now - a.lastSay < SAY_MIN_INTERVAL_MS) {
        ws.send(JSON.stringify({ t: 'error', code: 'slow_down' } satisfies Outgoing));
        return;
      }
      const text = cleanChat(msg.text);
      if (!text) return;
      a.lastSay = now;
      ws.serializeAttachment(a);
      const line: ChatLine = { pid: a.pid, nick: a.nick, text, at: now };
      const chat = ((await this.ctx.storage.get('chat')) as ChatLine[] | undefined) ?? [];
      chat.push(line);
      await this.ctx.storage.put('chat', chat.slice(-CHAT_KEEP));
      this.broadcast({ t: 'said', line });
      return;
    }
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

  // ── 주인 하트비트 (막사 DO) ──
  private async onStatus(body: {
    owner: Identity;
    sid: string;
    state: 'working' | 'idle' | 'offline';
  }): Promise<Response> {
    const now = Date.now();
    let meta = await this.roomMeta();
    if (!meta) {
      meta = { id: body.owner.pid, kind: 'barracks', owner: body.owner };
      await this.ctx.storage.put('meta', meta);
    } else if (JSON.stringify(meta.owner) !== JSON.stringify(body.owner)) {
      meta = { ...meta, owner: body.owner };
      await this.ctx.storage.put('meta', meta);
    }
    const before = await this.presence(body.owner, now);
    const beats = pruneBeats(
      ((await this.ctx.storage.get('beats')) as Record<string, SessionBeat> | undefined) ?? {},
      now,
    );
    if (body.state === 'offline') delete beats[body.sid];
    else beats[body.sid] = { state: body.state, at: now };
    await this.ctx.storage.put('beats', beats);
    const after = await this.presence(body.owner, now);
    if (before.online !== after.online || before.working !== after.working)
      this.broadcast({ t: 'owner', owner: after });
    await this.reportToPlaza(meta); // 매번 보낸다 — 광장은 보고 시각으로 신선도를 본다
    return Response.json({ ok: true, online: after.online, working: after.working });
  }

  // ── 막사 목록 (광장 DO) ──
  private async onReport(body: Omit<DirEntry, 'at'>): Promise<Response> {
    if (!isPublicId(body.pid)) return new Response('bad', { status: 400 });
    if (!(await this.roomMeta())) await this.ctx.storage.put('meta', { id: PLAZA_ID, kind: 'plaza', owner: null });
    const now = Date.now();
    const dir = ((await this.ctx.storage.get('dir')) as Record<string, DirEntry> | undefined) ?? {};
    const before = JSON.stringify(await this.plazaDoors(now));
    const entry: DirEntry = {
      pid: body.pid,
      nick: String(body.nick).slice(0, 40),
      agent: normalizeAgentName(body.agent),
      count: Math.max(0, Math.min(BARRACKS_CAP, Number(body.count) || 0)),
      ownerOnline: !!body.ownerOnline,
      ownerWorking: !!body.ownerWorking,
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
  return { id: a.id, pid: a.pid, nick: a.nick, agent: a.agent, x: a.x, dir: a.dir, state: a.state };
}

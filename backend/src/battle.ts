// 교전(Battle) — 최대 10명 개인전 (DESIGN.md §22)
//
// 원칙:
// - 집계 창은 전원 동일(created_at ~ ends_at). 참가 시점은 보드 등재 여부만 결정한다 —
//   늦게 조인해도 창 시작 이후 events 가 소급 집계되어 늦참 불이익이 없다.
// - 순위는 원시 events 실시간 계산(멤버 ≤10 × 창 ≤7일, idx_events_user_time 사용).
//   유저 규모가 커지면 KV 캐시 도입(§22 남은 것).
// - user_id 는 비밀키 — 응답에는 닉네임·public_id 만 싣는다(리더보드와 같은 규칙).

import type { Env, Metric } from './types';
import { json, readJson } from './http';
import { isValidUserId } from './validate';
import { autoNickname } from './nickname';
import { newPublicId } from './publicid';

export const BATTLE_MIN_HOURS = 24;
export const BATTLE_MAX_HOURS = 24 * 7;
export const BATTLE_MAX_MEMBERS = 10;
export const BATTLE_MAX_NAME_LEN = 30;

/** 초대 코드: 6자, 혼동 문자(0/o/1/l/i) 제외 소문자+숫자. URL /b/<code>. */
const CODE_ALPHABET = '23456789abcdefghjkmnpqrstuvwxyz';
const CODE_LEN = 6;
export const BATTLE_CODE_RE = /^[23456789abcdefghjkmnpqrstuvwxyz]{6}$/;

export function newBattleCode(): string {
  const buf = new Uint8Array(CODE_LEN);
  crypto.getRandomValues(buf);
  let code = '';
  for (const b of buf) code += CODE_ALPHABET[b % CODE_ALPHABET.length];
  return code;
}

/** 기간 파싱: 시간 단위 정수, 24 ≤ hours ≤ 168. */
export function parseBattleHours(v: unknown): number | null {
  const n = typeof v === 'number' ? v : typeof v === 'string' ? Number(v) : NaN;
  if (!Number.isInteger(n) || n < BATTLE_MIN_HOURS || n > BATTLE_MAX_HOURS) return null;
  return n;
}

export function normalizeBattleName(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  const name = v.trim().replace(/\s+/g, ' ');
  if (!name || name.length > BATTLE_MAX_NAME_LEN) return null;
  return name;
}

function parseBattleMetric(v: unknown): Metric {
  return v === 'chars' ? 'chars' : 'prompts';
}

interface BattleRow {
  id: number;
  code: string;
  name: string | null;
  owner_user_id: string;
  metric: string;
  created_at: number;
  ends_at: number;
}

/** 공개 응답용 교전 메타 (owner_user_id 는 비밀키라 제외). */
function publicBattle(b: BattleRow, now: number) {
  return {
    code: b.code,
    name: b.name,
    metric: b.metric as Metric,
    startsAt: b.created_at,
    endsAt: b.ends_at,
    ended: now >= b.ends_at,
  };
}

async function getBattleByCode(env: Env, code: string): Promise<BattleRow | null> {
  return await env.DB.prepare(
    'SELECT id, code, name, owner_user_id, metric, created_at, ends_at FROM battles WHERE code = ?',
  )
    .bind(code)
    .first<BattleRow>();
}

/** users 행 보장(닉네임 미등록 유저도 교전을 만들 수 있게 — setNickname 과 같은 패턴). */
async function ensureUser(env: Env, userId: string, now: number): Promise<void> {
  await env.DB.prepare(
    'INSERT INTO users (user_id, public_id, created_at, last_seen_at) VALUES (?, ?, ?, ?) ON CONFLICT(user_id) DO NOTHING',
  )
    .bind(userId, newPublicId(), now, now)
    .run();
}

/** POST /battle/new — body: { userId, hours, name?, metric? } */
export async function handleBattleNew(request: Request, env: Env): Promise<Response> {
  const body = await readJson(request);
  if (!body || !isValidUserId(body.userId)) return json({ error: 'invalid_userId' }, 400);
  const hours = parseBattleHours(body.hours);
  if (hours === null) {
    return json({ error: 'invalid_hours', min: BATTLE_MIN_HOURS, max: BATTLE_MAX_HOURS }, 400);
  }
  const name = body.name === undefined || body.name === null || body.name === '' ? null : normalizeBattleName(body.name);
  if (body.name && name === null) return json({ error: 'invalid_name', max: BATTLE_MAX_NAME_LEN }, 400);
  const metric = parseBattleMetric(body.metric);
  const userId = body.userId;
  const now = Date.now();

  await ensureUser(env, userId, now);

  // 코드 충돌은 UNIQUE 위반으로 드러난다 — 소수 재시도로 흡수(31^6 ≈ 8.9억 조합이라 사실상 안 일어남).
  for (let attempt = 0; attempt < 3; attempt++) {
    const code = newBattleCode();
    try {
      const res = await env.DB.prepare(
        'INSERT INTO battles (code, name, owner_user_id, metric, created_at, ends_at) VALUES (?, ?, ?, ?, ?, ?) RETURNING id',
      )
        .bind(code, name, userId, metric, now, now + hours * 3_600_000)
        .first<{ id: number }>();
      if (!res) continue;
      await env.DB.prepare('INSERT INTO battle_members (battle_id, user_id, joined_at) VALUES (?, ?, ?)')
        .bind(res.id, userId, now)
        .run();
      return json({ ok: true, code, name, metric, startsAt: now, endsAt: now + hours * 3_600_000 });
    } catch (err) {
      if (String(err).includes('UNIQUE')) continue;
      throw err;
    }
  }
  return json({ error: 'code_collision' }, 500);
}

/** POST /battle/join — body: { userId, code }. 이미 멤버면 ok(멱등). */
export async function handleBattleJoin(request: Request, env: Env): Promise<Response> {
  const body = await readJson(request);
  if (!body || !isValidUserId(body.userId)) return json({ error: 'invalid_userId' }, 400);
  const code = typeof body.code === 'string' ? body.code.trim().toLowerCase() : '';
  if (!BATTLE_CODE_RE.test(code)) return json({ error: 'invalid_code' }, 400);
  const userId = body.userId;
  const now = Date.now();

  const battle = await getBattleByCode(env, code);
  if (!battle) return json({ error: 'battle_not_found' }, 404);
  if (now >= battle.ends_at) return json({ error: 'battle_ended' }, 409);

  const members = await env.DB.prepare('SELECT user_id FROM battle_members WHERE battle_id = ?')
    .bind(battle.id)
    .all<{ user_id: string }>();
  if (members.results.some((m) => m.user_id === userId)) {
    return json({ ok: true, already: true, ...publicBattle(battle, now) });
  }
  if (members.results.length >= BATTLE_MAX_MEMBERS) {
    return json({ error: 'battle_full', max: BATTLE_MAX_MEMBERS }, 409);
  }

  await ensureUser(env, userId, now);
  await env.DB.prepare('INSERT INTO battle_members (battle_id, user_id, joined_at) VALUES (?, ?, ?)')
    .bind(battle.id, userId, now)
    .run();
  return json({ ok: true, ...publicBattle(battle, now) });
}

/** POST /battle/leave — body: { userId, code }. 방장 포함 누구나 나갈 수 있다(방은 남는다). */
export async function handleBattleLeave(request: Request, env: Env): Promise<Response> {
  const body = await readJson(request);
  if (!body || !isValidUserId(body.userId)) return json({ error: 'invalid_userId' }, 400);
  const code = typeof body.code === 'string' ? body.code.trim().toLowerCase() : '';
  if (!BATTLE_CODE_RE.test(code)) return json({ error: 'invalid_code' }, 400);

  const battle = await getBattleByCode(env, code);
  if (!battle) return json({ error: 'battle_not_found' }, 404);

  await env.DB.prepare('DELETE FROM battle_members WHERE battle_id = ? AND user_id = ?')
    .bind(battle.id, body.userId)
    .run();
  return json({ ok: true });
}

export interface BattleStanding {
  rank: number;
  /** 내부 매칭용 비밀키 — 응답 직전에 publicStanding() 으로 반드시 벗겨낸다. */
  user_id: string;
  nickname: string;
  registered: boolean;
  public_id: string | null;
  owner: boolean;
  prompts: number;
  chars: number;
}

/** 공개 응답용 — user_id(비밀키) 제거. */
export function publicStanding(s: BattleStanding): Omit<BattleStanding, 'user_id'> {
  const { user_id: _secret, ...pub } = s;
  return pub;
}

/** 교전 순위 계산 — 창(created_at~ends_at) 내 멤버들의 events 집계. 0점 멤버도 보드에 싣는다. */
export async function battleStandings(env: Env, battle: BattleRow): Promise<BattleStanding[]> {
  const rows = await env.DB.prepare(
    `SELECT m.user_id, u.nickname, u.public_id,
            COUNT(e.id) AS prompts, COALESCE(SUM(e.chars), 0) AS chars
       FROM battle_members m
       LEFT JOIN users u ON u.user_id = m.user_id
       LEFT JOIN events e ON e.user_id = m.user_id AND e.created_at >= ? AND e.created_at < ?
      WHERE m.battle_id = ?
      GROUP BY m.user_id`,
  )
    .bind(battle.created_at, battle.ends_at, battle.id)
    .all<{ user_id: string; nickname: string | null; public_id: string | null; prompts: number; chars: number }>();

  const metric = battle.metric === 'chars' ? 'chars' : 'prompts';
  const sorted = rows.results
    .map((r) => ({
      user_id: r.user_id,
      nickname: r.nickname ?? autoNickname(r.user_id),
      registered: r.nickname != null,
      public_id: r.public_id ?? null,
      owner: r.user_id === battle.owner_user_id,
      prompts: Number(r.prompts) || 0,
      chars: Number(r.chars) || 0,
    }))
    .sort((a, b) => (b[metric] - a[metric]) || (b.prompts - a.prompts) || a.nickname.localeCompare(b.nickname));

  return sorted.map((r, i) => ({
    rank: i + 1,
    user_id: r.user_id,
    nickname: r.nickname,
    registered: r.registered,
    public_id: r.public_id,
    owner: r.owner,
    prompts: r.prompts,
    chars: r.chars,
  }));
}

/**
 * GET /battle?code=X[&userId=Y] — 교전 메타 + 순위.
 * userId(비밀키)를 주면 응답에 내 순위(me)를 표시한다(공개 페이지는 미전달).
 */
export async function handleBattleGet(url: URL, env: Env): Promise<Response> {
  const code = (url.searchParams.get('code') ?? '').trim().toLowerCase();
  if (!BATTLE_CODE_RE.test(code)) return json({ error: 'invalid_code' }, 400);
  const battle = await getBattleByCode(env, code);
  if (!battle) return json({ error: 'battle_not_found' }, 404);

  const now = Date.now();
  const standings = await battleStandings(env, battle);

  let me: { rank: number; nickname: string } | null = null;
  const userId = url.searchParams.get('userId');
  if (userId && isValidUserId(userId)) {
    const mine = standings.find((s) => s.user_id === userId) ?? null;
    if (mine) me = { rank: mine.rank, nickname: mine.nickname };
  }

  return json({
    ...publicBattle(battle, now),
    members: standings.length,
    maxMembers: BATTLE_MAX_MEMBERS,
    standings: standings.map(publicStanding),
    me,
    now,
  });
}

/** 내가 참가 중인(종료 전) 교전 목록 — 종료 임박 순. 브리핑·CLI status 용. */
export async function activeBattlesOf(env: Env, userId: string, now: number): Promise<BattleRow[]> {
  const rows = await env.DB.prepare(
    `SELECT b.id, b.code, b.name, b.owner_user_id, b.metric, b.created_at, b.ends_at
       FROM battle_members m JOIN battles b ON b.id = m.battle_id
      WHERE m.user_id = ? AND b.ends_at > ?
      ORDER BY b.ends_at ASC`,
  )
    .bind(userId, now)
    .all<BattleRow>();
  return rows.results;
}

/**
 * 브리핑(§19·§22.5)용 교전 요약 — 참가 중 교전 중 종료가 가장 임박한 것 하나.
 * 문구는 클라이언트(track.mjs)가 만든다. members=1 이면 "대기 중"(초대 유도) 상태.
 */
export interface BattleBrief {
  code: string;
  name: string | null;
  metric: Metric;
  endsAt: number;
  members: number;
  rank: number;
  /** 바로 위와의 격차(내가 1위면 null 이고 gapBehind 가 뉴스가 된다). */
  aheadNickname: string | null;
  gapAhead: number | null;
  /** 바로 아래와의 격차(1위 방어용 뉴스). */
  gapBehind: number | null;
}

export async function battleBriefOf(env: Env, userId: string, now: number): Promise<BattleBrief | null> {
  const battles = await activeBattlesOf(env, userId, now);
  if (battles.length === 0) return null;
  const battle = battles[0];
  const standings = await battleStandings(env, battle);
  const meIdx = standings.findIndex((s) => s.user_id === userId);
  if (meIdx < 0) return null;
  const metric = (battle.metric === 'chars' ? 'chars' : 'prompts') as Metric;
  const me = standings[meIdx];
  const ahead = meIdx > 0 ? standings[meIdx - 1] : null;
  const behind = meIdx < standings.length - 1 ? standings[meIdx + 1] : null;
  return {
    code: battle.code,
    name: battle.name,
    metric,
    endsAt: battle.ends_at,
    members: standings.length,
    rank: me.rank,
    aheadNickname: ahead ? ahead.nickname : null,
    gapAhead: ahead ? Math.max(0, ahead[metric] - me[metric]) : null,
    gapBehind: behind ? Math.max(0, me[metric] - behind[metric]) : null,
  };
}

/** GET /battle/mine?userId=X — 참가 중 교전 목록(메타만, 순위 없음). */
export async function handleBattleMine(url: URL, env: Env): Promise<Response> {
  const userId = url.searchParams.get('userId');
  if (!isValidUserId(userId)) return json({ error: 'invalid_userId' }, 400);
  const now = Date.now();
  const battles = await activeBattlesOf(env, userId, now);
  return json({ battles: battles.map((b) => publicBattle(b, now)), now });
}

import type { Env } from './types';
import { json, readJson } from './http';
import { kstToday, weekDays, weekendDays } from './time';
import {
  clampChars,
  clampLimit,
  isValidNickname,
  isValidUserId,
  parseMetric,
  parseType,
} from './validate';
import { METRIC_COL, getSnapshot, periodOf } from './snapshot';

/** POST /track — 입력 이벤트 1건 수집. body: { userId, chars } */
export async function handleTrack(request: Request, env: Env): Promise<Response> {
  const body = await readJson(request);
  if (!body || !isValidUserId(body.userId)) {
    return json({ error: 'invalid_userId' }, 400);
  }
  const userId = body.userId;
  const chars = clampChars(body.chars);
  const now = Date.now();
  const day = kstToday(now);
  const country = request.cf?.country ?? null;

  // events insert + users insert(신규만) + daily_stats upsert 를 단일 트랜잭션(batch)으로.
  // 쓰기 절감: 기존 유저는 users를 다시 쓰지 않는다(DO NOTHING). last_seen 매번 갱신 X.
  await env.DB.batch([
    env.DB.prepare('INSERT INTO events (user_id, chars, country, created_at) VALUES (?, ?, ?, ?)').bind(
      userId,
      chars,
      country,
      now,
    ),
    env.DB.prepare(
      `INSERT INTO users (user_id, country, created_at, last_seen_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(user_id) DO NOTHING`,
    ).bind(userId, country, now, now),
    env.DB.prepare(
      `INSERT INTO daily_stats (user_id, day, prompts, chars, country)
       VALUES (?, ?, 1, ?, ?)
       ON CONFLICT(user_id, day) DO UPDATE SET
         prompts = daily_stats.prompts + 1,
         chars = daily_stats.chars + excluded.chars,
         country = COALESCE(daily_stats.country, excluded.country)`,
    ).bind(userId, day, chars, country),
  ]);

  return json({ ok: true, day });
}

/** POST /register — 닉네임 등록/변경. body: { userId, nickname } */
export async function handleRegister(request: Request, env: Env): Promise<Response> {
  const body = await readJson(request);
  if (!body || !isValidUserId(body.userId)) {
    return json({ error: 'invalid_userId' }, 400);
  }
  if (!isValidNickname(body.nickname)) {
    return json({ error: 'invalid_nickname' }, 400);
  }
  const userId = body.userId;
  const nickname = (body.nickname as string).trim();
  const now = Date.now();

  await env.DB.prepare(
    `INSERT INTO users (user_id, created_at, last_seen_at) VALUES (?, ?, ?)
     ON CONFLICT(user_id) DO NOTHING`,
  )
    .bind(userId, now, now)
    .run();

  const taken = await env.DB.prepare('SELECT user_id FROM users WHERE nickname = ?')
    .bind(nickname)
    .first<{ user_id: string }>();
  if (taken && taken.user_id !== userId) {
    return json({ error: 'nickname_taken' }, 409);
  }

  await env.DB.prepare('UPDATE users SET nickname = ? WHERE user_id = ?').bind(nickname, userId).run();

  return json({ ok: true, userId, nickname });
}

/**
 * GET /leaderboard?type=daily|weekly|weekend&metric=prompts|chars&limit=100
 * KV 스냅샷에서 서빙(D1 미접근). 스냅샷 신선도는 SNAPSHOT_TTL_MS.
 */
export async function handleLeaderboard(url: URL, env: Env, ctx?: ExecutionContext): Promise<Response> {
  const type = parseType(url.searchParams.get('type'));
  const metric = parseMetric(url.searchParams.get('metric'));
  const limit = clampLimit(url.searchParams.get('limit'));

  const snap = await getSnapshot(env, ctx);
  const board = snap.boards[type];
  const full = board ? board[metric] : [];
  const ranking = full.slice(0, limit);

  return json({
    type,
    metric,
    period: board ? board.period : periodOf(type, Date.now()),
    builtAt: snap.builtAt,
    count: ranking.length,
    ranking,
  });
}

/** GET /me?userId=...&type=...&metric=... — 내 집계와 순위(실시간 D1, 저빈도). */
export async function handleMe(url: URL, env: Env): Promise<Response> {
  const userId = url.searchParams.get('userId');
  if (!isValidUserId(userId)) {
    return json({ error: 'invalid_userId' }, 400);
  }
  const type = parseType(url.searchParams.get('type'));
  const metric = parseMetric(url.searchParams.get('metric'));
  const orderCol = METRIC_COL[metric];
  const now = Date.now();

  let aggSql: string;
  let aggBinds: string[];
  if (type === 'daily') {
    aggSql = 'SELECT user_id, prompts, chars FROM daily_stats WHERE day = ?';
    aggBinds = [kstToday(now)];
  } else {
    const days = type === 'weekly' ? weekDays(now) : weekendDays(now);
    const placeholders = days.map(() => '?').join(',');
    aggSql = `SELECT user_id, SUM(prompts) AS prompts, SUM(chars) AS chars
              FROM daily_stats WHERE day IN (${placeholders}) GROUP BY user_id`;
    aggBinds = days;
  }

  const sql = `
    WITH agg AS (${aggSql}),
         me AS (SELECT prompts, chars FROM agg WHERE user_id = ?)
    SELECT
      (SELECT nickname FROM users WHERE user_id = ?) AS nickname,
      COALESCE((SELECT prompts FROM me), 0) AS prompts,
      COALESCE((SELECT chars FROM me), 0) AS chars,
      (SELECT COUNT(*) FROM agg) AS total,
      CASE WHEN (SELECT COUNT(*) FROM me) = 0 THEN NULL
           ELSE (SELECT COUNT(*) + 1 FROM agg WHERE ${orderCol} > (SELECT ${orderCol} FROM me))
      END AS rank`;

  const row = await env.DB.prepare(sql)
    .bind(...aggBinds, userId, userId)
    .first<{ nickname: string | null; prompts: number; chars: number; total: number; rank: number | null }>();

  return json({
    type,
    metric,
    period: periodOf(type, now),
    me: {
      nickname: row?.nickname ?? null,
      prompts: Number(row?.prompts) || 0,
      chars: Number(row?.chars) || 0,
      rank: row?.rank ?? null,
      total: Number(row?.total) || 0,
    },
  });
}

import type { BoardType, Env, LeaderboardRow, Metric } from './types';
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

// metric 이름을 실제 컬럼명으로 화이트리스트 매핑 (SQL 인젝션 방지).
const METRIC_COL: Record<Metric, string> = { prompts: 'prompts', chars: 'chars' };

function periodOf(type: BoardType, now: number) {
  if (type === 'daily') return { day: kstToday(now) };
  const days = type === 'weekly' ? weekDays(now) : weekendDays(now);
  return { from: days[0], to: days[days.length - 1], days };
}

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

  // events insert + users upsert + daily_stats upsert 를 단일 트랜잭션(batch)으로.
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
       ON CONFLICT(user_id) DO UPDATE SET
         last_seen_at = excluded.last_seen_at,
         country = COALESCE(excluded.country, users.country)`,
    ).bind(userId, country, now, now),
    env.DB.prepare(
      `INSERT INTO daily_stats (user_id, day, prompts, chars, country)
       VALUES (?, ?, 1, ?, ?)
       ON CONFLICT(user_id, day) DO UPDATE SET
         prompts = daily_stats.prompts + 1,
         chars = daily_stats.chars + excluded.chars,
         country = COALESCE(excluded.country, daily_stats.country)`,
    ).bind(userId, day, chars, country),
  ]);

  const today = await env.DB.prepare('SELECT prompts, chars FROM daily_stats WHERE user_id = ? AND day = ?')
    .bind(userId, day)
    .first<{ prompts: number; chars: number }>();

  return json({ ok: true, day, today: today ?? { prompts: 0, chars: 0 } });
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

  // 유저가 없으면 생성 (닉네임만 먼저 등록하는 경우).
  await env.DB.prepare(
    `INSERT INTO users (user_id, created_at, last_seen_at) VALUES (?, ?, ?)
     ON CONFLICT(user_id) DO NOTHING`,
  )
    .bind(userId, now, now)
    .run();

  // 닉네임 중복(다른 유저가 선점) 검사.
  const taken = await env.DB.prepare('SELECT user_id FROM users WHERE nickname = ?')
    .bind(nickname)
    .first<{ user_id: string }>();
  if (taken && taken.user_id !== userId) {
    return json({ error: 'nickname_taken' }, 409);
  }

  await env.DB.prepare('UPDATE users SET nickname = ? WHERE user_id = ?').bind(nickname, userId).run();

  return json({ ok: true, userId, nickname });
}

/** GET /leaderboard?type=daily|weekly|weekend&metric=prompts|chars&limit=100 */
export async function handleLeaderboard(url: URL, env: Env): Promise<Response> {
  const type = parseType(url.searchParams.get('type'));
  const metric = parseMetric(url.searchParams.get('metric'));
  const limit = clampLimit(url.searchParams.get('limit'));
  const orderCol = METRIC_COL[metric];
  const now = Date.now();

  let result;
  if (type === 'daily') {
    const day = kstToday(now);
    result = await env.DB.prepare(
      `SELECT s.user_id, u.nickname, s.country, s.prompts, s.chars
       FROM daily_stats s LEFT JOIN users u ON u.user_id = s.user_id
       WHERE s.day = ?
       ORDER BY s.${orderCol} DESC, s.user_id ASC
       LIMIT ?`,
    )
      .bind(day, limit)
      .all<LeaderboardRow>();
  } else {
    const days = type === 'weekly' ? weekDays(now) : weekendDays(now);
    const placeholders = days.map(() => '?').join(',');
    result = await env.DB.prepare(
      `SELECT s.user_id, u.nickname, MAX(s.country) AS country,
              SUM(s.prompts) AS prompts, SUM(s.chars) AS chars
       FROM daily_stats s LEFT JOIN users u ON u.user_id = s.user_id
       WHERE s.day IN (${placeholders})
       GROUP BY s.user_id, u.nickname
       ORDER BY ${orderCol} DESC, s.user_id ASC
       LIMIT ?`,
    )
      .bind(...days, limit)
      .all<LeaderboardRow>();
  }

  // user_id는 인증 비밀키이므로 공개 응답에서 제외한다.
  const ranking = result.results.map((r, i) => ({
    rank: i + 1,
    nickname: r.nickname ?? null,
    country: r.country ?? null,
    prompts: Number(r.prompts) || 0,
    chars: Number(r.chars) || 0,
  }));

  return json({
    type,
    metric,
    period: periodOf(type, now),
    updatedAt: now,
    count: ranking.length,
    ranking,
  });
}

/** GET /me?userId=...&type=...&metric=... — 내 집계와 순위. */
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

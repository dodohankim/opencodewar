import type { Env } from './types';
import { json, readJson } from './http';
import { kstToday, recentDays, weekDays, weekendDays } from './time';
import {
  clampChars,
  clampLimit,
  isValidBio,
  isValidNickname,
  isValidShortText,
  isValidUserId,
  MAX_COMPANY_LEN,
  MAX_ROLE_LEN,
  normalizeLinks,
  normalizeProjects,
  parseMetric,
  parseType,
  type Links,
  type Project,
} from './validate';
import { METRIC_COL, SNAPSHOT_KEY, getSnapshot, periodOf } from './snapshot';
import { displayNickname } from './nickname';

/** 유저 상세 페이지가 보여주는 최근 사용량 구간(일). */
const PROFILE_WINDOW_DAYS = 30;

/** links/projects 는 users 테이블에 JSON 문자열로 저장된다. 파싱 실패 시 기본값 반환. */
function parseLinks(raw: string | null): Links {
  if (!raw) return {};
  try {
    const v = JSON.parse(raw);
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as Links) : {};
  } catch {
    return {};
  }
}
function parseProjects(raw: string | null): Project[] {
  if (!raw) return [];
  try {
    const v = JSON.parse(raw);
    return Array.isArray(v) ? (v as Project[]) : [];
  } catch {
    return [];
  }
}

/** POST /track — 입력 이벤트 1건 수집. body: { userId, chars } */
export async function handleTrack(request: Request, env: Env): Promise<Response> {
  // 남용 방지: 본문 파싱 전에 IP 기준으로 먼저 차단(플러드 시 비용 최소화).
  // userId는 클라이언트가 임의 생성/회전 가능하므로 회전 비용이 큰 IP를 키로 쓴다.
  // (완전한 위조 차단은 서버 발급 서명 userId 도입 시. 지금은 스팸 완화가 목적.)
  const ip = request.headers.get('cf-connecting-ip') ?? 'unknown';
  const { success } = await env.TRACK_RATE_LIMITER.limit({ key: ip });
  if (!success) {
    return json({ error: 'rate_limited' }, 429);
  }

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

  // 등록/변경을 리더보드에 즉시 반영: 스냅샷을 무효화해 다음 조회 시 재빌드되게 한다.
  // (등록은 저빈도이므로 재빌드 비용은 무시할 만하다.)
  await env.KV.delete(SNAPSHOT_KEY);

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
         me AS (SELECT prompts, chars FROM agg WHERE user_id = ?),
         prof AS (SELECT nickname, bio, role, company, links, projects FROM users WHERE user_id = ?)
    SELECT
      (SELECT nickname FROM prof) AS nickname,
      (SELECT bio FROM prof) AS bio,
      (SELECT role FROM prof) AS role,
      (SELECT company FROM prof) AS company,
      (SELECT links FROM prof) AS links,
      (SELECT projects FROM prof) AS projects,
      COALESCE((SELECT prompts FROM me), 0) AS prompts,
      COALESCE((SELECT chars FROM me), 0) AS chars,
      (SELECT COUNT(*) FROM agg) AS total,
      CASE WHEN (SELECT COUNT(*) FROM me) = 0 THEN NULL
           ELSE (SELECT COUNT(*) + 1 FROM agg WHERE ${orderCol} > (SELECT ${orderCol} FROM me))
      END AS rank`;

  const row = await env.DB.prepare(sql)
    .bind(...aggBinds, userId, userId)
    .first<{
      nickname: string | null;
      bio: string | null;
      role: string | null;
      company: string | null;
      links: string | null;
      projects: string | null;
      prompts: number;
      chars: number;
      total: number;
      rank: number | null;
    }>();

  return json({
    type,
    metric,
    period: periodOf(type, now),
    me: {
      nickname: displayNickname(row?.nickname, userId),
      bio: row?.bio ?? null,
      role: row?.role ?? null,
      company: row?.company ?? null,
      links: parseLinks(row?.links ?? null),
      projects: parseProjects(row?.projects ?? null),
      prompts: Number(row?.prompts) || 0,
      chars: Number(row?.chars) || 0,
      rank: row?.rank ?? null,
      total: Number(row?.total) || 0,
    },
  });
}

/**
 * POST /profile — 프로필 부분 갱신. body 에 포함된 필드만 바꾼다(부분 패치).
 * body: { userId, bio?, role?, company?, links?, projects? }
 * - 텍스트(bio/role/company): 빈 문자열이면 해제(NULL).
 * - links: {website?,github?,x?,linkedin?} 전체 교체(빈 객체 = 전체 해제).
 * - projects: [{name,desc?,url?}] 전체 교체, 최대 5개(빈 배열 = 전체 해제).
 * 닉네임과 동일한 신뢰 모델(비밀 userId 소유자만 설정).
 */
export async function handleProfile(request: Request, env: Env): Promise<Response> {
  const body = await readJson(request);
  if (!body || !isValidUserId(body.userId)) {
    return json({ error: 'invalid_userId' }, 400);
  }
  const userId = body.userId;

  // 제공된 필드만 SET 절에 넣는다. echo 는 정규화된 값을 응답에 담아 클라이언트가 로컬 캐시 갱신에 쓴다.
  const cols: string[] = [];
  const vals: (string | null)[] = [];
  const echo: Record<string, unknown> = {};

  const setText = (key: string, col: string, valid: boolean, raw: unknown) => {
    if (!valid) return false;
    const t = (raw as string).trim();
    const v = t.length ? t : null;
    cols.push(`${col} = ?`);
    vals.push(v);
    echo[key] = v;
    return true;
  };

  if ('bio' in body && !setText('bio', 'bio', isValidBio(body.bio), body.bio)) {
    return json({ error: 'invalid_bio' }, 400);
  }
  if ('role' in body && !setText('role', 'role', isValidShortText(body.role, MAX_ROLE_LEN), body.role)) {
    return json({ error: 'invalid_role' }, 400);
  }
  if (
    'company' in body &&
    !setText('company', 'company', isValidShortText(body.company, MAX_COMPANY_LEN), body.company)
  ) {
    return json({ error: 'invalid_company' }, 400);
  }
  if ('links' in body) {
    const links = normalizeLinks(body.links);
    if (links === null) return json({ error: 'invalid_links' }, 400);
    cols.push('links = ?');
    vals.push(Object.keys(links).length ? JSON.stringify(links) : null);
    echo.links = links;
  }
  if ('projects' in body) {
    const projects = normalizeProjects(body.projects);
    if (projects === null) return json({ error: 'invalid_projects' }, 400);
    cols.push('projects = ?');
    vals.push(projects.length ? JSON.stringify(projects) : null);
    echo.projects = projects;
  }

  if (!cols.length) {
    return json({ error: 'no_fields' }, 400);
  }

  const now = Date.now();
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO users (user_id, created_at, last_seen_at) VALUES (?, ?, ?)
       ON CONFLICT(user_id) DO NOTHING`,
    ).bind(userId, now, now),
    env.DB.prepare(`UPDATE users SET ${cols.join(', ')} WHERE user_id = ?`).bind(...vals, userId),
  ]);

  return json({ ok: true, ...echo });
}

/**
 * POST /delete — 본인 데이터 완전 삭제(삭제권 대응). body: { userId }.
 * events·daily_stats·users 에서 해당 userId 행을 모두 지우고 스냅샷을 무효화한다.
 * 닉네임과 동일한 신뢰 모델: 비밀 userId 소유자만 자기 데이터를 지울 수 있다.
 */
export async function handleDelete(request: Request, env: Env): Promise<Response> {
  const body = await readJson(request);
  if (!body || !isValidUserId(body.userId)) {
    return json({ error: 'invalid_userId' }, 400);
  }
  const userId = body.userId;

  await env.DB.batch([
    env.DB.prepare('DELETE FROM events WHERE user_id = ?').bind(userId),
    env.DB.prepare('DELETE FROM daily_stats WHERE user_id = ?').bind(userId),
    env.DB.prepare('DELETE FROM users WHERE user_id = ?').bind(userId),
  ]);

  // 리더보드에서 즉시 사라지도록 스냅샷을 무효화(다음 조회 시 재빌드).
  await env.KV.delete(SNAPSHOT_KEY);

  return json({ ok: true, deleted: true });
}

/**
 * GET /user?nickname=... — 유저 상세(프로필 + 최근 30일 일별 사용량).
 * 공개 페이지이므로 등록 닉네임(유니크)으로만 조회한다. user_id(비밀키)는 반환하지 않는다.
 */
export async function handleUser(url: URL, env: Env): Promise<Response> {
  const nicknameParam = url.searchParams.get('nickname');
  if (!isValidNickname(nicknameParam)) {
    return json({ error: 'invalid_nickname' }, 400);
  }
  const nickname = (nicknameParam as string).trim();

  const user = await env.DB.prepare(
    'SELECT user_id, nickname, bio, role, company, links, projects, email, country, created_at FROM users WHERE nickname = ?',
  )
    .bind(nickname)
    .first<{
      user_id: string;
      nickname: string;
      bio: string | null;
      role: string | null;
      company: string | null;
      links: string | null;
      projects: string | null;
      email: string | null;
      country: string | null;
      created_at: number;
    }>();

  if (!user) {
    return json({ error: 'user_not_found' }, 404);
  }

  const now = Date.now();
  const days = recentDays(now, PROFILE_WINDOW_DAYS); // 오래된 날 → 오늘
  const placeholders = days.map(() => '?').join(',');
  const rows = await env.DB.prepare(
    `SELECT day, prompts, chars FROM daily_stats WHERE user_id = ? AND day IN (${placeholders})`,
  )
    .bind(user.user_id, ...days)
    .all<{ day: string; prompts: number; chars: number }>();

  const byDay = new Map(rows.results.map((r) => [r.day, r]));
  const series = days.map((day) => {
    const r = byDay.get(day);
    return { day, prompts: Number(r?.prompts) || 0, chars: Number(r?.chars) || 0 };
  });
  const totals = series.reduce(
    (acc, s) => ({ prompts: acc.prompts + s.prompts, chars: acc.chars + s.chars }),
    { prompts: 0, chars: 0 },
  );

  return json({
    nickname: user.nickname,
    bio: user.bio ?? null,
    role: user.role ?? null,
    company: user.company ?? null,
    links: parseLinks(user.links),
    projects: parseProjects(user.projects),
    email: user.email ?? null, // 로그인 도입 전까지 항상 null
    country: user.country ?? null,
    joinedAt: Number(user.created_at) || null,
    range: { from: days[0], to: days[days.length - 1], days: days.length },
    days: series,
    totals,
  });
}

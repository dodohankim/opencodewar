import type { Env } from './types';
import { json, readJson } from './http';
import { utcToday } from './time';
import { isValidTimezone, localDay, localHour, recentLocalDays, zonedDayRange } from './tz';
import {
  clampChars,
  clampLimit,
  isValidBio,
  isValidCountryCode,
  isValidDay,
  isValidNickname,
  isValidShortText,
  isValidUserId,
  normalizeAgent,
  MAX_CITY_LEN,
  MAX_COMPANY_LEN,
  MAX_ROLE_LEN,
  normalizeLinks,
  normalizeProjects,
  parseMetric,
  parseType,
  type Links,
  type Project,
} from './validate';
import { METRIC_COL, SNAPSHOT_KEY, boardDays, computeZoneRanking, getSnapshot, periodOf } from './snapshot';
import { displayNickname } from './nickname';
import { isValidPublicId, newPublicId } from './publicid';
import { cityKey, cleanCity, countryFlag } from './zones';

/** 유저 상세 페이지 그래프가 보여주는 최근 사용량 구간(로컬 일수). */
const PROFILE_WINDOW_DAYS = 30;
/** 스트릭(연속 활동일) 계산을 위한 뒤로보기 상한(로컬 일수). 이 창을 넘는 연속은 값이 캡된다. */
const STREAK_WINDOW_DAYS = 60;

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

/** POST /track — 입력 이벤트 1건 수집. body: { userId, chars, agent? } (agent 미지정 = claude-code) */
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
  const agent = normalizeAgent(body.agent);
  const now = Date.now();
  const day = utcToday(now); // 리더보드 집계는 공용 UTC 일자
  const country = request.cf?.country ?? null;
  // 상세 페이지 로컬 시간용 유저 TZ. IP 기반(cf.timezone, IANA). 유효할 때만 저장, 아니면 NULL(→ UTC 폴백).
  const cfTz = request.cf?.timezone;
  const timezone = isValidTimezone(cfTz) ? cfTz : null;

  // events insert + users insert(신규만) + daily_stats upsert 를 단일 트랜잭션(batch)으로.
  // 쓰기 절감: 기존 유저는 users를 다시 쓰지 않는다(DO NOTHING). last_seen 매번 갱신 X.
  await env.DB.batch([
    env.DB.prepare('INSERT INTO events (user_id, chars, country, agent, created_at) VALUES (?, ?, ?, ?, ?)').bind(
      userId,
      chars,
      country,
      agent,
      now,
    ),
    env.DB.prepare(
      `INSERT INTO users (user_id, public_id, country, timezone, created_at, last_seen_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(user_id) DO NOTHING`,
    ).bind(userId, newPublicId(), country, timezone, now, now),
    env.DB.prepare(
      `INSERT INTO daily_stats (user_id, day, agent, prompts, chars, country)
       VALUES (?, ?, ?, 1, ?, ?)
       ON CONFLICT(user_id, day, agent) DO UPDATE SET
         prompts = daily_stats.prompts + 1,
         chars = daily_stats.chars + excluded.chars,
         country = COALESCE(daily_stats.country, excluded.country)`,
    ).bind(userId, day, agent, chars, country),
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
 * GET /leaderboard?type=daily|weekly|weekend|monthly&metric=prompts|chars&limit=100
 *   &scope=global|country|city [&country=KR] [&city=Seoul]
 * - scope=global(기본): KV 스냅샷에서 서빙(D1 미접근).
 * - scope=country|city: 구역 필터 랭킹을 D1에서 실시간 계산("이 구역 코드워리어").
 */
export async function handleLeaderboard(url: URL, env: Env, ctx?: ExecutionContext): Promise<Response> {
  const type = parseType(url.searchParams.get('type'));
  const metric = parseMetric(url.searchParams.get('metric'));
  const limit = clampLimit(url.searchParams.get('limit'));
  const scope = url.searchParams.get('scope');

  // ── 구역 리더보드(국가 / 국가+도시) — 실시간 D1 ──
  if (scope === 'country' || scope === 'city') {
    const countryParam = url.searchParams.get('country');
    if (!isValidCountryCode(countryParam)) return json({ error: 'invalid_country' }, 400);
    const country = countryParam.toUpperCase();

    let cityLabel: string | null = null;
    let cityLower: string | null = null;
    if (scope === 'city') {
      const cityParam = url.searchParams.get('city');
      if (!isValidShortText(cityParam, MAX_CITY_LEN)) return json({ error: 'invalid_city' }, 400);
      cityLabel = cleanCity(cityParam);
      if (!cityLabel) return json({ error: 'invalid_city' }, 400);
      cityLower = cityKey(cityLabel);
    }

    const ranking = await computeZoneRanking(env, type, metric, limit, country, cityLower);
    return json({
      type,
      metric,
      scope,
      country,
      flag: countryFlag(country),
      ...(scope === 'city' ? { city: cityLabel } : {}),
      period: periodOf(type, Date.now()),
      count: ranking.length,
      ranking,
    });
  }

  // ── 글로벌(기본) — KV 스냅샷 ──
  const snap = await getSnapshot(env, ctx);
  const board = snap.boards[type];
  const full = board ? board[metric] : [];
  const ranking = full.slice(0, limit);

  return json({
    type,
    metric,
    scope: 'global',
    period: board ? board.period : periodOf(type, Date.now()),
    builtAt: snap.builtAt,
    count: ranking.length,
    ranking,
  });
}

/**
 * GET /zones — 구역 셀렉터용 목록: 실제 활동 유저가 있는 국가 + 각 국가의 도시(인원수).
 * 세계 도시 사전이 아니라 우리 유저 실데이터에서 뽑는다(빈 구역 안 생김).
 * 도시는 대소문자 무시로 병합(리더보드 그룹키와 동일: LOWER(city)), 대표 라벨은 최다 표기.
 */
export async function handleZones(env: Env): Promise<Response> {
  const rows = await env.DB.prepare(
    `SELECT u.country AS country, u.city AS city, COUNT(*) AS n
     FROM users u
     WHERE u.country IS NOT NULL
       AND EXISTS (SELECT 1 FROM daily_stats d WHERE d.user_id = u.user_id)
     GROUP BY u.country, u.city`,
  ).all<{ country: string; city: string | null; n: number }>();

  type CityAgg = { label: string; count: number };
  type CountryAgg = { code: string; count: number; cities: Map<string, CityAgg> };
  const byCountry = new Map<string, CountryAgg>();

  for (const r of rows.results) {
    const n = Number(r.n) || 0;
    let c = byCountry.get(r.country);
    if (!c) {
      c = { code: r.country, count: 0, cities: new Map() };
      byCountry.set(r.country, c);
    }
    c.count += n;
    if (r.city) {
      const key = cityKey(r.city);
      const existing = c.cities.get(key);
      if (!existing) c.cities.set(key, { label: r.city, count: n });
      else existing.count += n; // 대소문자 변형 병합(대표 라벨은 첫 표기 유지)
    }
  }

  const countries = [...byCountry.values()]
    .map((c) => ({
      code: c.code,
      flag: countryFlag(c.code),
      count: c.count,
      cities: [...c.cities.values()].sort((a, b) => b.count - a.count),
    }))
    .sort((a, b) => b.count - a.count);

  return json({ countries });
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

  const days = boardDays(type, now);
  const ph = days.map(() => '?').join(',');

  // 한 번의 쿼리로 프로필 + 글로벌/국가/도시 구역의 순위·인원을 계산한다.
  // agg  = 기간 내 전체 유저 집계(글로벌). aggc = 내 국가로 좁힘. aggt = 내 국가+도시로 좁힘.
  // 도시 구역 키 = (country, LOWER(city)) — 동명 도시 분리(파리 FR/US) + Hangul 은 LOWER 무영향.
  const sql = `
    WITH agg AS (
      SELECT s.user_id, SUM(s.prompts) AS prompts, SUM(s.chars) AS chars
      FROM daily_stats s WHERE s.day IN (${ph}) GROUP BY s.user_id
    ),
    me AS (SELECT prompts, chars FROM agg WHERE user_id = ?),
    prof AS (SELECT nickname, bio, role, company, links, projects, country, city FROM users WHERE user_id = ?),
    aggc AS (
      SELECT a.prompts, a.chars FROM agg a JOIN users u ON u.user_id = a.user_id
      WHERE u.country = (SELECT country FROM prof)
    ),
    aggt AS (
      SELECT a.prompts, a.chars FROM agg a JOIN users u ON u.user_id = a.user_id
      WHERE u.country = (SELECT country FROM prof)
        AND LOWER(u.city) = LOWER((SELECT city FROM prof))
    )
    SELECT
      (SELECT nickname FROM prof) AS nickname,
      (SELECT bio FROM prof) AS bio,
      (SELECT role FROM prof) AS role,
      (SELECT company FROM prof) AS company,
      (SELECT links FROM prof) AS links,
      (SELECT projects FROM prof) AS projects,
      (SELECT country FROM prof) AS country,
      (SELECT city FROM prof) AS city,
      COALESCE((SELECT prompts FROM me), 0) AS prompts,
      COALESCE((SELECT chars FROM me), 0) AS chars,
      (SELECT COUNT(*) FROM agg) AS total,
      CASE WHEN (SELECT COUNT(*) FROM me) = 0 THEN NULL
           ELSE (SELECT COUNT(*) + 1 FROM agg WHERE ${orderCol} > (SELECT ${orderCol} FROM me)) END AS rank,
      (SELECT COUNT(*) FROM aggc) AS country_total,
      CASE WHEN (SELECT COUNT(*) FROM me) = 0 OR (SELECT country FROM prof) IS NULL THEN NULL
           ELSE (SELECT COUNT(*) + 1 FROM aggc WHERE ${orderCol} > (SELECT ${orderCol} FROM me)) END AS country_rank,
      (SELECT COUNT(*) FROM aggt) AS city_total,
      CASE WHEN (SELECT COUNT(*) FROM me) = 0 OR (SELECT city FROM prof) IS NULL OR (SELECT country FROM prof) IS NULL THEN NULL
           ELSE (SELECT COUNT(*) + 1 FROM aggt WHERE ${orderCol} > (SELECT ${orderCol} FROM me)) END AS city_rank`;

  const row = await env.DB.prepare(sql)
    .bind(...days, userId, userId)
    .first<{
      nickname: string | null;
      bio: string | null;
      role: string | null;
      company: string | null;
      links: string | null;
      projects: string | null;
      country: string | null;
      city: string | null;
      prompts: number;
      chars: number;
      total: number;
      rank: number | null;
      country_total: number;
      country_rank: number | null;
      city_total: number;
      city_rank: number | null;
    }>();

  const country = row?.country ?? null;
  const city = row?.city ?? null;
  const zones = {
    global: { rank: row?.rank ?? null, total: Number(row?.total) || 0 },
    country: country
      ? {
          code: country,
          flag: countryFlag(country),
          rank: row?.country_rank ?? null,
          total: Number(row?.country_total) || 0,
        }
      : null,
    city:
      city && country
        ? {
            label: city,
            key: cityKey(city),
            rank: row?.city_rank ?? null,
            total: Number(row?.city_total) || 0,
          }
        : null,
  };

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
      country,
      city,
      prompts: Number(row?.prompts) || 0,
      chars: Number(row?.chars) || 0,
      rank: row?.rank ?? null, // 글로벌(하위호환)
      total: Number(row?.total) || 0,
      zones,
    },
  });
}

/**
 * POST /profile — 프로필 부분 갱신. body 에 포함된 필드만 바꾼다(부분 패치).
 * body: { userId, bio?, role?, company?, links?, projects? }
 * - 텍스트(bio/role/company): 빈 문자열이면 해제(NULL).
 * - links: {website?,blog?,github?,x?,linkedin?} 전체 교체(빈 객체 = 전체 해제).
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
  if ('city' in body) {
    // 도시는 표시용으로 공백 정규화(내부 연속공백 축소)해 저장. 빈 값이면 해제(NULL).
    if (!isValidShortText(body.city, MAX_CITY_LEN)) return json({ error: 'invalid_city' }, 400);
    const cleaned = cleanCity(body.city);
    cols.push('city = ?');
    vals.push(cleaned);
    echo.city = cleaned;
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
 * ?id=<public_id> | ?nickname=<등록닉> 로 유저를 찾는 준비된 쿼리를 만든다(cols는 SELECT ~ FROM users).
 * id 우선(익명 유저 slug 진입 경로), 없으면 nickname. 파라미터가 유효하지 않으면 그대로 반환할
 * 에러 Response 를 준다 — 호출부는 { query } | { error } 로 분기한다. (/user 와 /user/hours 공용)
 */
function buildUserQuery(
  env: Env,
  url: URL,
  cols: string,
): { query: D1PreparedStatement } | { error: Response } {
  const idParam = url.searchParams.get('id');
  const nicknameParam = url.searchParams.get('nickname');
  if (idParam != null) {
    if (!isValidPublicId(idParam)) return { error: json({ error: 'invalid_id' }, 400) };
    return { query: env.DB.prepare(`${cols} WHERE public_id = ?`).bind(idParam) };
  }
  if (!isValidNickname(nicknameParam)) return { error: json({ error: 'invalid_nickname' }, 400) };
  return { query: env.DB.prepare(`${cols} WHERE nickname = ?`).bind((nicknameParam as string).trim()) };
}

/**
 * GET /user?nickname=<등록닉> | ?id=<public_id> — 유저 상세(프로필 + 최근 30일 일별 사용량).
 * 공개 페이지다. 등록 유저는 닉네임으로, 닉네임 미등록(익명) 유저는 공개 slug(public_id)로 조회한다.
 * user_id(비밀키)는 어느 경우에도 반환하지 않는다.
 */
export async function handleUser(url: URL, env: Env): Promise<Response> {
  const cols =
    'SELECT user_id, nickname, bio, role, company, links, projects, email, country, city, timezone, created_at FROM users';
  const built = buildUserQuery(env, url, cols);
  if ('error' in built) return built.error;

  const user = await built.query.first<{
    user_id: string;
    nickname: string | null;
    bio: string | null;
    role: string | null;
    company: string | null;
    links: string | null;
    projects: string | null;
    email: string | null;
    country: string | null;
    city: string | null;
    timezone: string | null;
    created_at: number;
  }>();

  if (!user) {
    return json({ error: 'user_not_found' }, 404);
  }

  // 상세 페이지는 "그 유저의 로컬 시간"으로 본다(리더보드의 공용 UTC 와 별개). TZ 미상이면 UTC 폴백.
  const tz = isValidTimezone(user.timezone) ? user.timezone : 'UTC';
  const now = Date.now();
  const DAY_MS = 86_400_000;

  // 원시 events 를 유저 로컬 일자로 재집계한다(daily_stats 는 공용 UTC 라 로컬 경계와 안 맞음).
  // 스트릭 창(60일)까지 넉넉히 조회 후 JS 에서 로컬 일자로 버킷팅. 규모 커지면 유저-TZ 롤업 캐시 고려.
  const sinceUtc = now - (STREAK_WINDOW_DAYS + 1) * DAY_MS;
  const rows = await env.DB.prepare(
    'SELECT created_at, agent, chars FROM events WHERE user_id = ? AND created_at >= ?',
  )
    .bind(user.user_id, sinceUtc)
    .all<{ created_at: number; agent: string; chars: number }>();

  type DayAgg = { prompts: number; chars: number; agents: Record<string, { prompts: number; chars: number }> };
  const byDay = new Map<string, DayAgg>();
  for (const r of rows.results) {
    const day = localDay(Number(r.created_at), tz);
    let d = byDay.get(day);
    if (!d) {
      d = { prompts: 0, chars: 0, agents: {} };
      byDay.set(day, d);
    }
    const c = Number(r.chars) || 0;
    d.prompts += 1; // events 1행 = 프롬프트 1건
    d.chars += c;
    const a = d.agents[r.agent] ?? (d.agents[r.agent] = { prompts: 0, chars: 0 });
    a.prompts += 1;
    a.chars += c;
  }

  const graphDays = recentLocalDays(now, tz, PROFILE_WINDOW_DAYS); // 30일, 오래된 날 → 오늘
  const series = graphDays.map((day) => {
    const d = byDay.get(day);
    return { day, prompts: d?.prompts ?? 0, chars: d?.chars ?? 0, agents: d?.agents ?? {} };
  });
  const totals = series.reduce(
    (acc, s) => ({ prompts: acc.prompts + s.prompts, chars: acc.chars + s.chars }),
    { prompts: 0, chars: 0 },
  );

  // 스트릭: 최근 활동일에서 뒤로 연속 카운트. 오늘이 아직 비어도 어제까지의 연속을 인정(자정 유예).
  const streakDays = recentLocalDays(now, tz, STREAK_WINDOW_DAYS);
  const isActive = (day: string) => (byDay.get(day)?.prompts ?? 0) > 0;
  let end = streakDays.length - 1;
  if (!isActive(streakDays[end])) end -= 1;
  let streak = 0;
  let streakSince: string | null = null;
  for (let j = end; j >= 0; j--) {
    if (isActive(streakDays[j])) {
      streak += 1;
      streakSince = streakDays[j];
    } else break;
  }

  return json({
    // 익명 유저는 저장된 닉네임이 없으므로 userId 파생 자동 닉네임으로 표시한다.
    nickname: displayNickname(user.nickname, user.user_id),
    bio: user.bio ?? null,
    role: user.role ?? null,
    company: user.company ?? null,
    links: parseLinks(user.links),
    projects: parseProjects(user.projects),
    email: user.email ?? null, // 로그인 도입 전까지 항상 null
    country: user.country ?? null,
    flag: countryFlag(user.country), // 국가 구역 표시용 국기(없으면 '')
    city: user.city ?? null,
    timezone: tz, // 상세 페이지가 이 TZ 로컬로 렌더됨(웹에 표기)
    joinedAt: Number(user.created_at) || null,
    range: { from: graphDays[0], to: graphDays[graphDays.length - 1], days: graphDays.length },
    days: series,
    totals,
    streak, // 연속 활동일(로컬), OG 카드가 재활용
    streakSince, // 스트릭 시작 로컬 날짜 'YYYY-MM-DD' | null
  });
}

/**
 * GET /user/hours?id=<public_id> | ?nickname=<등록닉> [&day=YYYY-MM-DD]
 *   — 특정 하루의 시간대별(0~23시) 사용량. day 미지정 시 그 유저의 로컬 오늘.
 * day 는 프로필 주인의 로컬 날짜다. 원시 events(created_at=UTC ms)를 그 유저 TZ 로컬 시(hour)로
 * 그룹핑한다(DST 정확). 상세 페이지 "하루(시간별)" 뷰 전용 — 열람 시에만 온디맨드로 호출.
 * 응답은 항상 24칸(활동 없는 시각은 0)으로 채워, 웹은 일별 차트와 같은 렌더 경로를 재사용한다.
 */
export async function handleUserHours(url: URL, env: Env): Promise<Response> {
  const built = buildUserQuery(env, url, 'SELECT user_id, timezone FROM users');
  if ('error' in built) return built.error;
  const user = await built.query.first<{ user_id: string; timezone: string | null }>();
  if (!user) {
    return json({ error: 'user_not_found' }, 404);
  }

  const tz = isValidTimezone(user.timezone) ? user.timezone : 'UTC';
  const now = Date.now();
  const dayParam = url.searchParams.get('day');
  const day = dayParam ?? localDay(now, tz); // 그 유저의 로컬 오늘
  if (!isValidDay(day)) {
    return json({ error: 'invalid_day' }, 400);
  }
  // 로컬 하루의 UTC 범위로 이벤트를 뽑고, 각 이벤트를 유저 로컬 시로 버킷팅(:30 오프셋 TZ 도 정확).
  const range = zonedDayRange(day, tz);
  const rows = await env.DB.prepare(
    'SELECT created_at, agent, chars FROM events WHERE user_id = ? AND created_at >= ? AND created_at < ?',
  )
    .bind(user.user_id, range.start, range.end)
    .all<{ created_at: number; agent: string; chars: number }>();

  type HourAgg = { prompts: number; chars: number; agents: Record<string, { prompts: number; chars: number }> };
  const byHour = new Map<number, HourAgg>();
  for (const r of rows.results) {
    const h = localHour(Number(r.created_at), tz);
    let b = byHour.get(h);
    if (!b) {
      b = { prompts: 0, chars: 0, agents: {} };
      byHour.set(h, b);
    }
    const c = Number(r.chars) || 0;
    b.prompts += 1;
    b.chars += c;
    const a = b.agents[r.agent] ?? (b.agents[r.agent] = { prompts: 0, chars: 0 });
    a.prompts += 1;
    a.chars += c;
  }
  const hours = Array.from({ length: 24 }, (_, h) => {
    const b = byHour.get(h);
    return { hour: h, prompts: b?.prompts ?? 0, chars: b?.chars ?? 0, agents: b?.agents ?? {} };
  });
  const totals = hours.reduce(
    (acc, s) => ({ prompts: acc.prompts + s.prompts, chars: acc.chars + s.chars }),
    { prompts: 0, chars: 0 },
  );

  return json({ day, timezone: tz, hours, totals });
}

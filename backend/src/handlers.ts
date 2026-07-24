import type { Env } from './types';
import { json, readJson } from './http';
import { utcToday } from './time';
import { computeStreak } from './streak';
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
import { METRIC_COL, SNAPSHOT_KEY, computeZoneRanking, dayFilter, getSnapshot, periodOf } from './snapshot';
import { displayNickname } from './nickname';
import { isValidPublicId, newPublicId } from './publicid';
import { cityKey, cleanCity, countryFlag } from './zones';

/** 유저 상세 페이지 그래프가 보여주는 최근 사용량 구간(로컬 일수). */
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

  const { sql: dayCond, binds: dayBinds } = dayFilter(type, now);

  // 한 번의 쿼리로 프로필 + 글로벌/국가/도시 구역의 순위·인원을 계산한다.
  // agg  = 기간 내 전체 유저 집계(글로벌). aggc = 내 국가로 좁힘. aggt = 내 국가+도시로 좁힘.
  // 도시 구역 키 = (country, LOWER(city)) — 동명 도시 분리(파리 FR/US) + Hangul 은 LOWER 무영향.
  const sql = `
    WITH agg AS (
      SELECT s.user_id, SUM(s.prompts) AS prompts, SUM(s.chars) AS chars
      FROM daily_stats s WHERE ${dayCond} GROUP BY s.user_id
    ),
    me AS (SELECT prompts, chars FROM agg WHERE user_id = ?),
    prof AS (SELECT nickname, bio, role, company, links, projects, country, city FROM users WHERE user_id = ?),
    acct AS (SELECT email, email_public FROM accounts WHERE user_id = ? LIMIT 1),
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
      (SELECT email FROM acct) AS account_email,
      (SELECT email_public FROM acct) AS account_email_public,
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
    .bind(...dayBinds, userId, userId, userId)
    .first<{
      nickname: string | null;
      bio: string | null;
      role: string | null;
      company: string | null;
      links: string | null;
      projects: string | null;
      country: string | null;
      city: string | null;
      account_email: string | null;
      account_email_public: number | null;
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
      account: row?.account_email ? { email: row.account_email, emailPublic: !!row.account_email_public } : null,
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
    env.DB.prepare('DELETE FROM accounts WHERE user_id = ?').bind(userId), // Google 연동도 함께 해제
  ]);

  // 리더보드에서 즉시 사라지도록 스냅샷을 무효화(다음 조회 시 재빌드).
  await env.KV.delete(SNAPSHOT_KEY);

  return json({ ok: true, deleted: true });
}

/** GET /random — 등록(닉네임 보유) 유저 중 한 명을 무작위로. 공개 정보만 반환하며 user_id 는 내보내지 않는다. */
export async function handleRandom(env: Env): Promise<Response> {
  const user = await env.DB.prepare(
    `SELECT u.user_id, u.nickname, u.public_id, u.bio, u.role, u.company, u.links, u.projects,
            u.country, u.city, u.created_at,
            a.email AS acct_email, a.email_public AS acct_email_public
       FROM users u LEFT JOIN accounts a ON a.user_id = u.user_id
      WHERE u.nickname IS NOT NULL
      ORDER BY RANDOM() LIMIT 1`,
  ).first<{
    user_id: string;
    nickname: string;
    public_id: string | null;
    bio: string | null;
    role: string | null;
    company: string | null;
    links: string | null;
    projects: string | null;
    country: string | null;
    city: string | null;
    created_at: number;
    acct_email: string | null;
    acct_email_public: number | null;
  }>();
  if (!user) return json({ error: 'no_users' }, 404);

  const agg = await env.DB.prepare(
    'SELECT COALESCE(SUM(prompts), 0) AS p, COALESCE(SUM(chars), 0) AS c FROM daily_stats WHERE user_id = ?',
  )
    .bind(user.user_id)
    .first<{ p: number; c: number }>();

  return json({
    user: {
      nickname: user.nickname,
      public_id: user.public_id,
      bio: user.bio ?? null,
      role: user.role ?? null,
      company: user.company ?? null,
      links: parseLinks(user.links),
      projects: parseProjects(user.projects),
      // 이메일은 본인이 공개 옵트인한 경우에만 — 비공개 정보는 서버에서부터 내보내지 않는다.
      email: user.acct_email_public ? (user.acct_email ?? null) : null,
      country: user.country ?? null,
      flag: countryFlag(user.country),
      city: user.city ?? null,
      joinedAt: Number(user.created_at) || null,
      prompts: Number(agg?.p) || 0,
      chars: Number(agg?.c) || 0,
    },
  });
}

/**
 * ?id=<public_id> | ?nickname=<등록닉> 로 유저를 찾는 users WHERE 절과 바인딩 값을 만든다.
 * id 우선(익명 유저 slug 진입 경로), 없으면 nickname. 파라미터가 유효하지 않으면 그대로 반환할
 * 에러 Response 를 준다 — 호출부는 { where, bind } | { error } 로 분기한다. (/user 와 /user/hours 공용)
 * D1 은 쿼리마다 네트워크 왕복이라, 부속 쿼리들은 이 WHERE 를
 * (SELECT user_id FROM users WHERE …) 서브쿼리로 재사용해 batch 한 번(단일 왕복)에 묶는다.
 */
function userWhere(url: URL): { where: string; bind: string } | { error: Response } {
  const idParam = url.searchParams.get('id');
  const nicknameParam = url.searchParams.get('nickname');
  if (idParam != null) {
    if (!isValidPublicId(idParam)) return { error: json({ error: 'invalid_id' }, 400) };
    return { where: 'public_id = ?', bind: idParam };
  }
  if (!isValidNickname(nicknameParam)) return { error: json({ error: 'invalid_nickname' }, 400) };
  return { where: 'nickname = ?', bind: (nicknameParam as string).trim() };
}

/**
 * GET /user?nickname=<등록닉> | ?id=<public_id> — 유저 상세(프로필 + 최근 30일 일별 사용량).
 * 공개 페이지다. 등록 유저는 닉네임으로, 닉네임 미등록(익명) 유저는 공개 slug(public_id)로 조회한다.
 * user_id(비밀키)는 어느 경우에도 반환하지 않는다.
 */
export async function handleUser(url: URL, env: Env): Promise<Response> {
  const built = userWhere(url);
  if ('error' in built) return built.error;
  const { where, bind } = built;

  const now = Date.now();
  const DAY_MS = 86_400_000;
  // 원시 events 를 유저 로컬 일자로 재집계한다(daily_stats 는 공용 UTC 라 로컬 경계와 안 맞음).
  // 상세 그래프(30일)용. 경계 보정 위해 +1일 여유. 규모 커지면 유저-TZ 롤업 캐시 고려.
  // (스트릭은 로컬이 아니라 공용 UTC 이므로 아래 daily_stats 에서 별도 계산한다 — §17)
  const sinceUtc = now - (PROFILE_WINDOW_DAYS + 1) * DAY_MS;

  // D1 은 쿼리마다 네트워크 왕복(실측 ~150-200ms)이므로 프로필·이메일·이벤트·일별 집계를
  // batch 하나(단일 왕복)로 묶는다. 2~4번째 쿼리는 user_id 를 서브쿼리로 재조회(인덱스 조회라 비용 무시 가능).
  const sub = `(SELECT user_id FROM users WHERE ${where})`;
  const [userRes, acctRes, eventRes, statRes, rankRes] = await env.DB.batch([
    env.DB.prepare(
      `SELECT user_id, public_id, nickname, bio, role, company, links, projects, country, city, timezone, created_at
         FROM users WHERE ${where}`,
    ).bind(bind),
    env.DB.prepare(`SELECT email, email_public FROM accounts WHERE user_id = ${sub} LIMIT 1`).bind(bind),
    env.DB.prepare(`SELECT created_at, agent, chars FROM events WHERE user_id = ${sub} AND created_at >= ?`).bind(
      bind,
      sinceUtc,
    ),
    env.DB.prepare(
      `SELECT day, SUM(prompts) AS prompts, SUM(chars) AS chars FROM daily_stats WHERE user_id = ${sub} GROUP BY day`,
    ).bind(bind),
    // 전체·국가 순위(전 기간 누적 prompts 기준, 리더보드 total 탭과 동일 개념).
    // tot = 유저별 전 기간 prompts 합. 규모 커지면 리더보드 스냅샷 재사용 고려(지금은 라이브 집계).
    env.DB.prepare(
      `WITH tot AS (SELECT s.user_id AS uid, SUM(s.prompts) AS p FROM daily_stats s GROUP BY s.user_id),
            me AS (SELECT t.p AS p, u.country AS c FROM tot t JOIN users u ON u.user_id = t.uid WHERE u.${where})
       SELECT
         (SELECT COUNT(*) FROM me) AS hasme,
         (SELECT c FROM me) AS mecountry,
         (SELECT COUNT(*) FROM tot) AS gtotal,
         (SELECT COUNT(*) + 1 FROM tot WHERE p > (SELECT p FROM me)) AS grank,
         (SELECT COUNT(*) FROM tot t JOIN users u ON u.user_id = t.uid WHERE u.country = (SELECT c FROM me)) AS ctotal,
         (SELECT COUNT(*) + 1 FROM tot t JOIN users u ON u.user_id = t.uid
            WHERE u.country = (SELECT c FROM me) AND t.p > (SELECT p FROM me)) AS crank`,
    ).bind(bind),
  ]);

  const user = userRes.results[0] as
    | {
        user_id: string;
        public_id: string | null;
        nickname: string | null;
        bio: string | null;
        role: string | null;
        company: string | null;
        links: string | null;
        projects: string | null;
        country: string | null;
        city: string | null;
        timezone: string | null;
        created_at: number;
      }
    | undefined;

  if (!user) {
    return json({ error: 'user_not_found' }, 404);
  }

  // 공개 이메일: Google 연동 + 본인이 공개 옵트인(/ocw email public)한 경우에만 노출.
  const acct = acctRes.results[0] as { email: string | null; email_public: number } | undefined;
  const publicEmail = acct && acct.email_public ? (acct.email ?? null) : null;

  // 상세 페이지는 "그 유저의 로컬 시간"으로 본다(리더보드의 공용 UTC 와 별개). TZ 미상이면 UTC 폴백.
  const tz = isValidTimezone(user.timezone) ? user.timezone : 'UTC';

  type DayAgg = { prompts: number; chars: number; agents: Record<string, { prompts: number; chars: number }> };
  const byDay = new Map<string, DayAgg>();
  for (const r of eventRes.results as Array<{ created_at: number; agent: string; chars: number }>) {
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

  // 유저의 UTC 일자별 집계(daily_stats 를 day 단위로 agent 합산, 위 batch 4번째 쿼리).
  // 계급용 전 기간 누적과 스트릭(§17)을 함께 구한다. 스트릭 최장은 전 기간이 필요하다.
  const dayStats = (statRes.results as Array<{ day: string; prompts: number; chars: number }>).map((r) => ({
    day: r.day,
    prompts: Number(r.prompts) || 0,
    chars: Number(r.chars) || 0,
  }));

  // 전 기간 누적(계급 산정용, §16). 공용 UTC 롤업이지만 총합은 TZ 와 무관하다.
  const allTime = dayStats.reduce(
    (acc, s) => ({ prompts: acc.prompts + s.prompts, chars: acc.chars + s.chars }),
    { prompts: 0, chars: 0 },
  );

  // 스트릭(§17): 공용 UTC 하루 기준(로컬 보정 안 함). "친 날" = prompts≥10 AND chars>500.
  // current(오늘/어제까지 자정 유예) + longest(역대 최장).
  const streakInfo = computeStreak(dayStats, now);

  // 전체·국가 순위(위 batch 5번째). hasme=0(활동 없음)이면 순위 없음(null).
  const rankRow = rankRes.results[0] as
    | { hasme: number; mecountry: string | null; gtotal: number; grank: number; ctotal: number; crank: number }
    | undefined;
  const hasMe = rankRow ? Number(rankRow.hasme) > 0 : false;
  const rank = hasMe ? Number(rankRow!.grank) || null : null;
  const rankTotal = rankRow ? Number(rankRow.gtotal) || 0 : 0;
  const hasCountryRank = hasMe && rankRow!.mecountry != null;
  const countryRank = hasCountryRank ? Number(rankRow!.crank) || null : null;
  const countryTotal = hasCountryRank ? Number(rankRow!.ctotal) || 0 : 0;

  return json({
    // 익명 유저는 저장된 닉네임이 없으므로 userId 파생 자동 닉네임으로 표시한다.
    nickname: displayNickname(user.nickname, user.user_id),
    // 공개 slug — 웹의 '카드 저장'이 유저별 OG 이미지(/og/<public_id>.png)를 가리키는 데 쓴다. user_id(비밀키) 아님.
    publicId: user.public_id ?? null,
    bio: user.bio ?? null,
    role: user.role ?? null,
    company: user.company ?? null,
    links: parseLinks(user.links),
    projects: parseProjects(user.projects),
    email: publicEmail, // 옵트인(/ocw email public)한 연동 이메일만. 기본 비공개.
    country: user.country ?? null,
    flag: countryFlag(user.country), // 국가 구역 표시용 국기(없으면 '')
    city: user.city ?? null,
    timezone: tz, // 상세 페이지가 이 TZ 로컬로 렌더됨(웹에 표기)
    joinedAt: Number(user.created_at) || null,
    range: { from: graphDays[0], to: graphDays[graphDays.length - 1], days: graphDays.length },
    days: series,
    totals,
    // 전 기간 누적 — 웹·OG 가 계급(이병~장군, DESIGN.md §16) 산정에 쓴다.
    allTime,
    streak: streakInfo.current, // 현재 연속 "친 날"(공용 UTC, §17). 웹·OG 카드가 재활용
    streakLongest: streakInfo.longest, // 역대 최장 연속
    streakSince: streakInfo.since, // 현재 연속 시작 UTC 날짜 'YYYY-MM-DD' | null
    // 전체·국가 순위(전 기간 누적 prompts). 활동 없으면 null. 웹 프로필 헤더 '전체 순위' 표시용.
    rank,
    rankTotal,
    countryRank,
    countryTotal,
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
  const built = userWhere(url);
  if ('error' in built) return built.error;
  const { where, bind } = built;

  const now = Date.now();
  const dayParam = url.searchParams.get('day');
  if (dayParam !== null && !isValidDay(dayParam)) {
    return json({ error: 'invalid_day' }, 400);
  }

  // 단일 왕복을 위해 유저 TZ(users 행)를 알기 전에 이벤트도 같은 batch 로 뽑는다:
  // 어떤 IANA TZ(UTC-12~+14)의 로컬 하루도 덮는 넉넉한 UTC 창으로 가져온 뒤,
  // 응답 후 그 유저 TZ 의 정확한 하루 범위(zonedDayRange, DST 23/25h 정확)로 거른다.
  const HOUR_MS = 3_600_000;
  const DAY_MS = 86_400_000;
  let winStart: number;
  let winEnd: number;
  if (dayParam) {
    const [y, m, d] = dayParam.split('-').map(Number);
    const utcMidnight = Date.UTC(y, m - 1, d);
    winStart = utcMidnight - 14 * HOUR_MS; // UTC+14 의 로컬 자정까지 커버
    winEnd = utcMidnight + DAY_MS + 12 * HOUR_MS; // UTC-12 의 로컬 하루 끝까지 커버
  } else {
    // 로컬 '오늘'은 어떤 TZ 든 now-24h 이후에 시작하고, 이벤트는 미래가 없다(+1h 는 여유).
    winStart = now - DAY_MS - HOUR_MS;
    winEnd = now + HOUR_MS;
  }

  const sub = `(SELECT user_id FROM users WHERE ${where})`;
  const [userRes, eventRes] = await env.DB.batch([
    env.DB.prepare(`SELECT user_id, timezone FROM users WHERE ${where}`).bind(bind),
    env.DB.prepare(
      `SELECT created_at, agent, chars FROM events WHERE user_id = ${sub} AND created_at >= ? AND created_at < ?`,
    ).bind(bind, winStart, winEnd),
  ]);
  const user = userRes.results[0] as { user_id: string; timezone: string | null } | undefined;
  if (!user) {
    return json({ error: 'user_not_found' }, 404);
  }

  const tz = isValidTimezone(user.timezone) ? user.timezone : 'UTC';
  const day = dayParam ?? localDay(now, tz); // 그 유저의 로컬 오늘
  // 넓은 창에서 이 유저 로컬 하루의 정확한 UTC 범위만 남기고, 로컬 시로 버킷팅(:30 오프셋 TZ 도 정확).
  const range = zonedDayRange(day, tz);

  type HourAgg = { prompts: number; chars: number; agents: Record<string, { prompts: number; chars: number }> };
  const byHour = new Map<number, HourAgg>();
  for (const r of eventRes.results as Array<{ created_at: number; agent: string; chars: number }>) {
    const ts = Number(r.created_at);
    if (ts < range.start || ts >= range.end) continue;
    const h = localHour(ts, tz);
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

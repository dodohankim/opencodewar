// 리더보드 스냅샷: D1 집계를 사전 계산해 KV에 저장하고, 읽기는 KV에서 서빙한다.
// - 쓰기: 간격당 1회(단일 키) → KV 쓰기 한도(무료 1천/일) 안에서 안전
// - 읽기: /leaderboard = KV get 1회 → D1 미접근
// - 신선도: SNAPSHOT_TTL_MS 초과 시 읽기 시점에 자동 재빌드(cron이 없거나 트래픽만 있어도 동작)

import type {
  BoardSnapshot,
  BoardType,
  Env,
  LeaderboardRow,
  Metric,
  Period,
  RankEntry,
  RankProject,
  Snapshot,
} from './types';
import { utcToday, utcDayNum, dayStr, monthDays, weekDays, weekendDays } from './time';
import { displayNickname } from './nickname';
import { isValidUrl, parseProjects } from './validate';

// v2: 'all'(전체 기간) 보드 추가 / v3: 랭킹 항목에 대표 프로젝트 추가
// v4: 활동 0인 가입자도 랭킹에 포함 / v5: 순위 변동(delta) 추가 — 배포 즉시 재빌드 유도
export const SNAPSHOT_KEY = 'lb:snapshot:v5';
const SNAPSHOT_LIMIT = 100;
const DEFAULT_TTL_MS = 30 * 60 * 1000; // 30분
const BOARDS: BoardType[] = ['daily', 'weekly', 'weekend', 'monthly', 'all'];

// metric 이름 → 실제 컬럼(화이트리스트, SQL 인젝션 방지)
export const METRIC_COL: Record<Metric, string> = { prompts: 'prompts', chars: 'chars' };

/**
 * 보드가 집계하는 'YYYY-MM-DD' 날짜 목록. 랭킹 쿼리의 `day IN (...)` 에 쓴다.
 * 'all'(전체 기간)은 고정 날짜 목록이 없다 — 빈 배열을 주고, 실제 쿼리는 dayFilter 가 필터를 생략한다.
 */
export function boardDays(type: BoardType, now: number): string[] {
  switch (type) {
    case 'daily':
      return [utcToday(now)];
    case 'weekly':
      return weekDays(now);
    case 'weekend':
      return weekendDays(now);
    case 'monthly':
      return monthDays(now);
    case 'all':
      return [];
  }
}

/**
 * 랭킹 쿼리 WHERE 절의 기간 조건과 바인딩. daily_stats 는 별칭 `s` 로 가정한다.
 * 'all' 은 전체 기간이라 날짜 필터를 걸지 않는다(1=1).
 */
export function dayFilter(type: BoardType, now: number): { sql: string; binds: string[] } {
  if (type === 'all') return { sql: '1=1', binds: [] };
  const days = boardDays(type, now);
  return { sql: `s.day IN (${days.map(() => '?').join(',')})`, binds: days };
}

export function periodOf(type: BoardType, now: number): Period {
  if (type === 'all') return { all: true };
  if (type === 'daily') return { day: utcToday(now) };
  const days = boardDays(type, now);
  return { from: days[0], to: days[days.length - 1], days };
}

/**
 * 리더보드에 실을 대표 프로젝트 1개. main 표식이 있으면 그것, 없으면 첫 항목 —
 * 유저 상세(main 우선, 나머지는 등록 순)에서 맨 위에 보이는 것과 같은 프로젝트다.
 * 잠수함(sub, §20.7)은 공개 지면에 이름을 낼 수 없으므로 후보에서 제외한다(전부 잠수함이면 칩 없음).
 * name 이 없으면 버리고, url 이 http(s) 절대 URL 이 아니면 링크 없이 이름만 남긴다.
 */
export function pickMainProject(raw: string | null): RankProject | null {
  const list = parseProjects(raw).filter((p) => p && p.sub !== true);
  const picked = list.find((p) => p && p.main === true) ?? list[0];
  const name = picked && typeof picked.name === 'string' ? picked.name.trim() : '';
  if (!name) return null;
  const project: RankProject = { name };
  if (isValidUrl(picked.url)) project.url = picked.url.trim();
  // 한 줄 설명은 톱3 카드용(§7.4). 100행 스냅샷이라 KV 크기 영향은 무시할 수준.
  const desc = typeof picked.desc === 'string' ? picked.desc.trim() : '';
  if (desc) project.desc = desc;
  return project;
}

/**
 * D1 원시 행 → 공개 랭킹 항목. user_id 는 비밀키라 응답에 담지 않는다.
 * prevMap 이 있으면 순위 변동(delta)을 붙인다 — 직전 창에 없던 유저는 null(신규).
 */
function toRankEntry(r: LeaderboardRow, i: number, prevMap?: Map<string, number>): RankEntry {
  const entry: RankEntry = {
    rank: i + 1,
    nickname: displayNickname(r.nickname, r.user_id),
    registered: r.nickname != null,
    public_id: r.public_id ?? null,
    country: r.country ?? null,
    project: pickMainProject(r.projects ?? null),
    prompts: Number(r.prompts) || 0,
    chars: Number(r.chars) || 0,
  };
  if (prevMap) {
    const prev = prevMap.get(r.user_id);
    entry.delta = prev === undefined ? null : prev - (i + 1); // 양수 = 그만큼 올라섬
  }
  return entry;
}

/**
 * 순위 변동(§7.4)용 "직전 창" 조건. 지금 화면에 있는 두 보드만 지원한다.
 *  · all   → 어제까지 누적(오늘 친 건 빼고 세운 순위)
 *  · daily → 어제 하루
 * 나머지 보드(weekly·weekend·monthly)는 웹에 노출되지 않아 계산하지 않는다(null).
 */
export function prevDayFilter(type: BoardType, now: number): { sql: string; binds: string[] } | null {
  const yesterday = dayStr(utcDayNum(now) - 1);
  if (type === 'all') return { sql: 's.day <= ?', binds: [yesterday] };
  if (type === 'daily') return { sql: 's.day = ?', binds: [yesterday] };
  return null;
}

/** 특정 보드×지표의 top-N 랭킹을 D1에서 계산 */
export async function computeRanking(
  env: Env,
  type: BoardType,
  metric: Metric,
  limit: number,
  prevMap?: Map<string, number>,
): Promise<RankEntry[]> {
  const orderCol = METRIC_COL[metric];
  const now = Date.now();

  // daily_stats 는 (user_id, day, agent) 단위 행 — daily 도 유저별 합산이 필요해 전 보드 동일 쿼리.
  //
  // **users 에서 출발한다**(daily_stats 가 아니라). 가입만 하고 아직 한 번도 안 친 사람도
  // 0으로 보드에 서 있어야 하기 때문 — 웹 가입자(§14.9)는 events 가 아예 없어서, 예전처럼
  // daily_stats 를 드라이빙 테이블로 쓰면 리더보드에서 통째로 사라진다.
  // 기간 조건은 WHERE 가 아니라 **JOIN 의 ON** 에 둔다. WHERE 로 내리면 LEFT JOIN 이 INNER 로
  // 무너져(그 기간에 행이 없는 유저가 탈락) daily 보드에서 다시 0인 사람이 사라진다.
  const { sql: dayCond, binds: dayBinds } = dayFilter(type, now);
  const result = await env.DB.prepare(
    // 국가는 users 를 먼저 본다 — 유저가 직접 고칠 수 있는 값이라(프로필 편집) 여기가 정본이고,
    // 프로필 페이지(/user)도 users.country 를 보여준다. daily_stats 는 users 가 빌 때의 폴백.
    `SELECT u.user_id, u.nickname, u.public_id, u.projects,
            COALESCE(u.country, MAX(s.country)) AS country,
            COALESCE(SUM(s.prompts), 0) AS prompts, COALESCE(SUM(s.chars), 0) AS chars
     FROM users u LEFT JOIN daily_stats s ON s.user_id = u.user_id AND ${dayCond}
     GROUP BY u.user_id, u.nickname, u.public_id, u.projects, u.country, u.created_at
     ORDER BY ${orderCol} DESC, u.created_at ASC, u.user_id ASC
     LIMIT ?`,
  )
    .bind(...dayBinds, limit)
    .all<LeaderboardRow>();

  return result.results.map((r, i) => toRankEntry(r, i, prevMap));
}

/**
 * 직전 창의 user_id → 순위 맵. 지금 순위와 빼서 delta 를 만든다.
 * 프로젝트·닉네임이 필요 없으므로 컬럼을 최소로 뽑는다(같은 정렬 규칙 유지가 핵심).
 */
export async function computePrevRankMap(
  env: Env,
  type: BoardType,
  metric: Metric,
  limit: number,
): Promise<Map<string, number>> {
  const prev = prevDayFilter(type, Date.now());
  if (!prev) return new Map();
  const orderCol = METRIC_COL[metric];
  const result = await env.DB.prepare(
    `SELECT u.user_id,
            COALESCE(SUM(s.prompts), 0) AS prompts, COALESCE(SUM(s.chars), 0) AS chars
     FROM users u LEFT JOIN daily_stats s ON s.user_id = u.user_id AND ${prev.sql}
     GROUP BY u.user_id, u.created_at
     ORDER BY ${orderCol} DESC, u.created_at ASC, u.user_id ASC
     LIMIT ?`,
  )
    .bind(...prev.binds, limit)
    .all<{ user_id: string }>();
  return new Map(result.results.map((r, i) => [r.user_id, i + 1]));
}

/**
 * 구역(국가, 또는 국가+도시) 필터를 건 top-N 랭킹을 D1에서 실시간 계산한다.
 * 스냅샷을 쓰지 않는다(구역 조합이 많고 저트래픽 → 조회 시 직접 집계).
 * @param country ISO alpha-2(대문자). @param cityLower 소문자 도시 키(있으면 국가+도시로 좁힘).
 */
export async function computeZoneRanking(
  env: Env,
  type: BoardType,
  metric: Metric,
  limit: number,
  country: string,
  cityLower?: string | null,
): Promise<RankEntry[]> {
  const orderCol = METRIC_COL[metric];
  const now = Date.now();
  const { sql: dayCond, binds: dayBinds } = dayFilter(type, now);
  const cityClause = cityLower != null ? 'AND LOWER(u.city) = ?' : '';
  const binds: (string | number)[] = [...dayBinds, country];
  if (cityLower != null) binds.push(cityLower);
  binds.push(limit);

  // computeRanking 과 같은 이유로 users 에서 출발하고 기간 조건은 ON 에 둔다(활동 0인 가입자 포함).
  // 구역 필터(u.country / u.city)는 유저 속성이라 WHERE 에 남는다.
  const result = await env.DB.prepare(
    `SELECT u.user_id, u.nickname, u.public_id, u.projects, u.country AS country,
            COALESCE(SUM(s.prompts), 0) AS prompts, COALESCE(SUM(s.chars), 0) AS chars
     FROM users u LEFT JOIN daily_stats s ON s.user_id = u.user_id AND ${dayCond}
     WHERE u.country = ? ${cityClause}
     GROUP BY u.user_id, u.nickname, u.public_id, u.projects, u.country, u.created_at
     ORDER BY ${orderCol} DESC, u.created_at ASC, u.user_id ASC
     LIMIT ?`,
  )
    .bind(...binds)
    .all<LeaderboardRow>();

  // 구역 보드는 순위 변동을 계산하지 않는다(조합이 많고 저트래픽 — §7.4).
  return result.results.map((r, i) => toRankEntry(r, i));
}

/** 전 보드/지표를 계산해 스냅샷 객체 생성 */
export async function buildSnapshot(env: Env): Promise<Snapshot> {
  const now = Date.now();
  const boards = {} as Record<BoardType, BoardSnapshot>;
  for (const type of BOARDS) {
    // 순위 변동은 웹이 실제로 보여주는 두 보드(all·daily)만 — 나머지는 쿼리를 아낀다.
    const withDelta = prevDayFilter(type, now) !== null;
    const [prevP, prevC] = withDelta
      ? await Promise.all([
          computePrevRankMap(env, type, 'prompts', SNAPSHOT_LIMIT),
          computePrevRankMap(env, type, 'chars', SNAPSHOT_LIMIT),
        ])
      : [undefined, undefined];
    const [prompts, chars] = await Promise.all([
      computeRanking(env, type, 'prompts', SNAPSHOT_LIMIT, prevP),
      computeRanking(env, type, 'chars', SNAPSHOT_LIMIT, prevC),
    ]);
    boards[type] = { period: periodOf(type, now), prompts, chars };
  }
  return { builtAt: now, boards };
}

export async function putSnapshot(env: Env, snap: Snapshot): Promise<void> {
  await env.KV.put(SNAPSHOT_KEY, JSON.stringify(snap));
}

/** KV 스냅샷 반환. 없거나 TTL 초과면 재빌드(쓰기는 ctx.waitUntil로 비동기). */
export async function getSnapshot(env: Env, ctx?: ExecutionContext): Promise<Snapshot> {
  const ttl = Number(env.SNAPSHOT_TTL_MS) || DEFAULT_TTL_MS;
  const cached = await env.KV.get<Snapshot>(SNAPSHOT_KEY, 'json');
  const now = Date.now();
  if (cached && now - cached.builtAt <= ttl) return cached;

  const built = await buildSnapshot(env);
  const write = putSnapshot(env, built);
  if (ctx) ctx.waitUntil(write);
  else await write;
  return built;
}

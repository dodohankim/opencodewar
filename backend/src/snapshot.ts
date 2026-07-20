// 리더보드 스냅샷: D1 집계를 사전 계산해 KV에 저장하고, 읽기는 KV에서 서빙한다.
// - 쓰기: 간격당 1회(단일 키) → KV 쓰기 한도(무료 1천/일) 안에서 안전
// - 읽기: /leaderboard = KV get 1회 → D1 미접근
// - 신선도: SNAPSHOT_TTL_MS 초과 시 읽기 시점에 자동 재빌드(cron이 없거나 트래픽만 있어도 동작)

import type { BoardSnapshot, BoardType, Env, LeaderboardRow, Metric, Period, RankEntry, Snapshot } from './types';
import { kstToday, weekDays, weekendDays } from './time';
import { displayNickname } from './nickname';

export const SNAPSHOT_KEY = 'lb:snapshot:v1';
const SNAPSHOT_LIMIT = 100;
const DEFAULT_TTL_MS = 30 * 60 * 1000; // 30분
const BOARDS: BoardType[] = ['daily', 'weekly', 'weekend'];

// metric 이름 → 실제 컬럼(화이트리스트, SQL 인젝션 방지)
export const METRIC_COL: Record<Metric, string> = { prompts: 'prompts', chars: 'chars' };

export function periodOf(type: BoardType, now: number): Period {
  if (type === 'daily') return { day: kstToday(now) };
  const days = type === 'weekly' ? weekDays(now) : weekendDays(now);
  return { from: days[0], to: days[days.length - 1], days };
}

/** 특정 보드×지표의 top-N 랭킹을 D1에서 계산 */
export async function computeRanking(
  env: Env,
  type: BoardType,
  metric: Metric,
  limit: number,
): Promise<RankEntry[]> {
  const orderCol = METRIC_COL[metric];
  const now = Date.now();

  // daily_stats 는 (user_id, day, agent) 단위 행 — daily 도 유저별 합산이 필요해 전 보드 동일 쿼리.
  const days = type === 'daily' ? [kstToday(now)] : type === 'weekly' ? weekDays(now) : weekendDays(now);
  const placeholders = days.map(() => '?').join(',');
  const result = await env.DB.prepare(
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

  return result.results.map((r, i) => ({
    rank: i + 1,
    nickname: displayNickname(r.nickname, r.user_id),
    registered: r.nickname != null,
    country: r.country ?? null,
    prompts: Number(r.prompts) || 0,
    chars: Number(r.chars) || 0,
  }));
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
  const days = type === 'daily' ? [kstToday(now)] : type === 'weekly' ? weekDays(now) : weekendDays(now);
  const ph = days.map(() => '?').join(',');
  const cityClause = cityLower != null ? 'AND LOWER(u.city) = ?' : '';
  const binds: (string | number)[] = [...days, country];
  if (cityLower != null) binds.push(cityLower);
  binds.push(limit);

  const result = await env.DB.prepare(
    `SELECT s.user_id, u.nickname, u.country AS country,
            SUM(s.prompts) AS prompts, SUM(s.chars) AS chars
     FROM daily_stats s JOIN users u ON u.user_id = s.user_id
     WHERE s.day IN (${ph}) AND u.country = ? ${cityClause}
     GROUP BY s.user_id, u.nickname
     ORDER BY ${orderCol} DESC, s.user_id ASC
     LIMIT ?`,
  )
    .bind(...binds)
    .all<LeaderboardRow>();

  return result.results.map((r, i) => ({
    rank: i + 1,
    nickname: displayNickname(r.nickname, r.user_id),
    registered: r.nickname != null,
    country: r.country ?? null,
    prompts: Number(r.prompts) || 0,
    chars: Number(r.chars) || 0,
  }));
}

/** 전 보드/지표를 계산해 스냅샷 객체 생성 */
export async function buildSnapshot(env: Env): Promise<Snapshot> {
  const now = Date.now();
  const boards = {} as Record<BoardType, BoardSnapshot>;
  for (const type of BOARDS) {
    const [prompts, chars] = await Promise.all([
      computeRanking(env, type, 'prompts', SNAPSHOT_LIMIT),
      computeRanking(env, type, 'chars', SNAPSHOT_LIMIT),
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

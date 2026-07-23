/**
 * Cloudflare 네이티브 Rate Limiting 바인딩(wrangler.jsonc 의 unsafe.bindings 에서 정의).
 * key 당 simple.limit/period 로 카운트하며, 집계는 Cloudflare 위치(colo) 단위다.
 * @cloudflare/workers-types 버전에 따라 미포함일 수 있어 최소 형태로 직접 선언한다.
 */
export interface RateLimit {
  limit(options: { key: string }): Promise<{ success: boolean }>;
}

export interface Env {
  DB: D1Database;
  KV: KVNamespace;
  /** 정적 에셋(../web). 루트(/)는 run_worker_first 로 Worker가 먼저 받아 OG 재작성 후 이 바인딩으로 서빙. */
  ASSETS: Fetcher;
  /** POST /track 남용 방지 rate-limiter. 클라이언트 IP 기준(분당 상한은 wrangler.jsonc). */
  TRACK_RATE_LIMITER: RateLimit;
  /** 리더보드 스냅샷 신선도(ms). 미설정 시 30분. 로컬 테스트는 .dev.vars로 낮춤. */
  SNAPSHOT_TTL_MS?: string;
  /** 온디맨드 OG 렌더 서비스(VPS) 오리진. 예: https://og.example.com. 미설정 시 공통 og.png 만 씀. */
  RENDER_ORIGIN?: string;
  /** 렌더 서비스 인증 키(X-OCW-Render-Key). wrangler secret 으로 주입. */
  RENDER_KEY?: string;
  /** Google OAuth 클라이언트 ID(공개값, wrangler.jsonc vars). 미설정 시 /auth/* 는 안내만 반환. */
  GOOGLE_CLIENT_ID?: string;
  /** Google OAuth 클라이언트 secret. wrangler secret 으로 주입. */
  GOOGLE_CLIENT_SECRET?: string;
}

// 'all' = 전체 기간(all-time). daily·weekly·weekend·monthly 는 유지하되(CLI /me 등), 웹 리더보드는 현재 all 만 노출.
export type BoardType = 'daily' | 'weekly' | 'weekend' | 'monthly' | 'all';
export type Metric = 'prompts' | 'chars';

/** D1 리더보드 쿼리 원시 행 */
export interface LeaderboardRow {
  user_id: string;
  nickname: string | null;
  public_id: string | null;
  country: string | null;
  prompts: number;
  chars: number;
}

/** 공개 랭킹 항목 (user_id는 비밀키라 제외) */
export interface RankEntry {
  rank: number;
  nickname: string | null;
  /** 유저가 직접 등록한 닉네임인지 여부. false면 userId 파생 자동 닉네임(표시 전용). */
  registered: boolean;
  /** 공개 프로필 slug. 라우팅용 — 등록 유저는 닉네임으로, 익명 유저는 이 값으로 상세 진입. */
  public_id: string | null;
  country: string | null;
  prompts: number;
  chars: number;
}

export type Period = { day: string } | { from: string; to: string; days: string[] } | { all: true };

export interface BoardSnapshot {
  period: Period;
  prompts: RankEntry[];
  chars: RankEntry[];
}

/** KV에 저장되는 리더보드 스냅샷 (전 보드/지표 통합) */
export interface Snapshot {
  builtAt: number;
  boards: Record<BoardType, BoardSnapshot>;
}

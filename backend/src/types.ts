export interface Env {
  DB: D1Database;
  KV: KVNamespace;
  /** 정적 에셋(../web). 루트(/)는 run_worker_first 로 Worker가 먼저 받아 OG 재작성 후 이 바인딩으로 서빙. */
  ASSETS: Fetcher;
  /** 리더보드 스냅샷 신선도(ms). 미설정 시 30분. 로컬 테스트는 .dev.vars로 낮춤. */
  SNAPSHOT_TTL_MS?: string;
}

export type BoardType = 'daily' | 'weekly' | 'weekend';
export type Metric = 'prompts' | 'chars';

/** D1 리더보드 쿼리 원시 행 */
export interface LeaderboardRow {
  user_id: string;
  nickname: string | null;
  country: string | null;
  prompts: number;
  chars: number;
}

/** 공개 랭킹 항목 (user_id는 비밀키라 제외) */
export interface RankEntry {
  rank: number;
  nickname: string | null;
  /** 유저가 직접 등록한 닉네임인지 여부. false면 userId 파생 자동 닉네임(상세 페이지 없음). */
  registered: boolean;
  country: string | null;
  prompts: number;
  chars: number;
}

export type Period = { day: string } | { from: string; to: string; days: string[] };

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

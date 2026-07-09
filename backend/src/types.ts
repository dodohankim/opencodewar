export interface Env {
  DB: D1Database;
}

export type BoardType = 'daily' | 'weekly' | 'weekend';
export type Metric = 'prompts' | 'chars';

export interface LeaderboardRow {
  user_id: string;
  nickname: string | null;
  country: string | null;
  prompts: number;
  chars: number;
}

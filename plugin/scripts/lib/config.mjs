// Open Code War 플러그인 설정 (~/.open-code-war/config.json).
// userId는 설치 시 자동 발급되는 익명 식별자이자 인증 비밀키다. (DESIGN.md §4.4)
// 재설치/기기 이동에도 유지되도록 홈 디렉토리에 저장한다.

import { homedir } from 'node:os';
import { join } from 'node:path';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';

export const CONFIG_DIR = join(homedir(), '.open-code-war');
export const CONFIG_FILE = join(CONFIG_DIR, 'config.json');

// 배포된 커스텀 도메인. OCW_API_URL 환경변수로 덮어쓸 수 있다.
const DEFAULT_ENDPOINT = 'https://opencodewar.dev';

function newUserId() {
  return 'ocw_' + randomUUID().replace(/-/g, '');
}

export function loadConfig() {
  try {
    if (!existsSync(CONFIG_FILE)) return null;
    const cfg = JSON.parse(readFileSync(CONFIG_FILE, 'utf8'));
    if (!cfg || typeof cfg.userId !== 'string') return null;
    // 서버가 진실의 원천이지만, 오프라인 status 표시를 위해 로컬에도 미러링한다.
    return {
      nickname: null,
      endpoint: null,
      enabled: true,
      brief: true, // 세션 브리핑 표시 여부 (/ocw brief off 로 끔, DESIGN.md §19)
      bio: null,
      role: null,
      company: null,
      city: null,
      links: {},
      projects: [],
      projectDirs: {}, // { "<절대경로>": "<라벨>" } — 폴더→프로젝트 링크(DESIGN.md §20). 로컬 전용, 경로는 서버로 안 감.
      account: null,
      ...cfg,
    };
  } catch {
    return null;
  }
}

export function saveConfig(cfg) {
  mkdirSync(CONFIG_DIR, { recursive: true });
  writeFileSync(CONFIG_FILE, JSON.stringify(cfg, null, 2) + '\n');
  return cfg;
}

/** 설정을 읽고, 없으면 익명 userId를 발급해 새로 만든다. */
export function ensureConfig() {
  const existing = loadConfig();
  if (existing) return existing;
  return saveConfig({
    userId: newUserId(),
    nickname: null,
    endpoint: null,
    enabled: true,
    createdAt: Date.now(),
  });
}

/** 사용할 API 엔드포인트 (env > config > 기본값), 뒤 슬래시 제거. */
export function endpointOf(cfg) {
  const raw = process.env.OCW_API_URL || (cfg && cfg.endpoint) || DEFAULT_ENDPOINT;
  return raw.replace(/\/+$/, '');
}

/** 경로 끝 구분자 제거(루트 "/" 는 유지). link 저장·매칭이 같은 표기를 쓰게 한다. */
export function normalizeDir(p) {
  const s = String(p || '');
  return s.length > 1 ? s.replace(/[\\/]+$/, '') : s;
}

/**
 * cwd 가 어느 프로젝트에 링크돼 있는지(DESIGN.md §20.3).
 * projectDirs 의 키(절대경로)와 최장 접두사 매칭 — 하위 폴더에서 쳐도 상위 링크에 귀속된다.
 * 매칭 없으면 null(= 서버에 project 미전송).
 */
export function projectFor(cfg, cwd) {
  const dirs = cfg && cfg.projectDirs;
  if (!dirs || !cwd) return null;
  const c = normalizeDir(cwd);
  let bestLen = -1;
  let bestKey = null;
  for (const dir of Object.keys(dirs)) {
    const d = normalizeDir(dir);
    if (c !== d && !c.startsWith(d + '/') && !c.startsWith(d + '\\')) continue;
    if (d.length > bestLen) {
      bestLen = d.length;
      bestKey = dir; // 원본 키로 값을 찾는다(저장 표기가 달라도 안전)
    }
  }
  if (bestKey === null) return null;
  const label = dirs[bestKey];
  return typeof label === 'string' && label.trim() ? label.trim() : null;
}

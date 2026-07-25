#!/usr/bin/env node
// 세션 브리핑 진입점 (DESIGN.md §19). track.mjs(집계)와 역할이 다르다 — 이쪽은 "보여주기"만 한다.
//
//   brief.mjs --prefetch            SessionStart 용. detached 자식에게 넘기고 즉시 종료(세션 시작 지연 0).
//   brief.mjs --hook                UserPromptSubmit 용(Claude Code·Codex). stdin JSON 에서 session_id 를
//                                   읽어 {"systemMessage": "<한 줄>"} 을 출력한다. 보여줄 게 없으면 무출력.
//   brief.mjs --line [--session ID] pi·opencode 어댑터 용. 문구 한 줄만 stdout 으로 낸다.
//
// 원칙: 네트워크는 --prefetch 에서만 탄다. 표시 경로(--hook/--line)는 로컬 파일만 읽으므로
// 프롬프트 제출을 절대 지연시키지 않는다(§19.2).

import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { endpointOf, loadConfig } from './lib/config.mjs';
import { MAX_AGE_MS, composeBriefing, detectLang, loadBriefing, saveBriefing } from './lib/briefing.mjs';

const SELF = fileURLToPath(import.meta.url);
const FETCH_TIMEOUT_MS = 4000;
const STDIN_TIMEOUT_MS = 800;

/** session_id 를 못 얻는 호스트에서 중복 표시를 막는 대체 가드. */
const MIN_INTERVAL_MS = 30 * 60 * 1000;

function readStdin() {
  return new Promise((resolve) => {
    let data = '';
    const done = () => resolve(data);
    process.stdin.on('data', (c) => (data += c));
    process.stdin.on('end', done);
    process.stdin.on('error', done);
    setTimeout(done, STDIN_TIMEOUT_MS);
  });
}

function argOf(name) {
  const i = process.argv.indexOf(name);
  return i !== -1 ? process.argv[i + 1] : undefined;
}

/** /briefing 을 받아 캐시에 저장한다. 실패는 조용히 무시(집계·대화를 막지 않는다). */
async function runPrefetch() {
  const cfg = loadConfig();
  if (!cfg || cfg.enabled === false || cfg.brief === false) return;

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  try {
    const url = `${endpointOf(cfg)}/briefing?userId=${encodeURIComponent(cfg.userId)}`;
    const res = await fetch(url, { signal: ctrl.signal });
    if (!res.ok) return;
    const data = await res.json();
    const prev = loadBriefing();
    saveBriefing({
      data,
      fetchedAt: Date.now(),
      shownFor: null, // 새 데이터니 이번 세션에 다시 보여줄 수 있다
      // prevRank 는 "지난번 표시 시점"의 순위여야 변동이 의미를 갖는다 → prefetch 에서는 건드리지 않는다.
      prevRank: prev?.prevRank ?? null,
      shownAt: prev?.shownAt ?? 0,
    });
  } catch {
    // 오프라인·타임아웃 등 — 다음 세션에 다시 시도한다
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 이번에 보여줄 문구를 정하고 "봤다"고 기록한다. 없으면 null.
 * 표시 시점에만 prevRank 를 갱신해, 다음 브리핑의 "변동"이 지난 표시 대비가 되게 한다.
 */
function takeLine(sessionId) {
  const cfg = loadConfig();
  if (!cfg || cfg.brief === false) return null;

  const state = loadBriefing();
  if (!state || !state.data) return null;
  if (Date.now() - (state.fetchedAt ?? 0) > MAX_AGE_MS) return null;
  if (sessionId && state.shownFor === sessionId) return null;
  if (!sessionId && state.shownAt && Date.now() - state.shownAt < MIN_INTERVAL_MS) return null;

  const line = composeBriefing(state.data, state.prevRank ?? null, detectLang(cfg, state.data));
  if (!line) return null;

  const rank = state.data.rank;
  saveBriefing({
    ...state,
    shownFor: sessionId ?? state.shownFor ?? null,
    shownAt: Date.now(),
    prevRank: rank ? { global: rank.global ?? null, country: rank.country ?? null } : (state.prevRank ?? null),
  });
  return line;
}

async function hookMode() {
  const raw = await readStdin();
  let sessionId = null;
  try {
    sessionId = JSON.parse(raw).session_id ?? null;
  } catch {
    // 파싱 실패 시 세션 구분 없이 진행(MIN_INTERVAL_MS 가드가 중복을 막는다)
  }
  const line = takeLine(sessionId);
  if (line) process.stdout.write(JSON.stringify({ systemMessage: line }));
}

try {
  const mode = process.argv[2];
  if (mode === '--prefetch') {
    // 네트워크를 타므로 detached 자식에게 넘기고 부모는 즉시 종료한다(track.mjs 와 같은 패턴).
    const child = spawn(process.execPath, [SELF, '--prefetch-run'], { detached: true, stdio: 'ignore' });
    child.on('error', () => {});
    child.unref();
  } else if (mode === '--prefetch-run') {
    await runPrefetch();
  } else if (mode === '--line') {
    const line = takeLine(argOf('--session') ?? null);
    if (line) process.stdout.write(line + '\n');
  } else {
    await hookMode();
  }
} catch {
  // 어떤 오류도 에이전트 사용을 막지 않는다
}
process.exit(0);

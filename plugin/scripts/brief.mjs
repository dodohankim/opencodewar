#!/usr/bin/env node
// 세션 브리핑 진입점 (DESIGN.md §19). track.mjs(집계)와 역할이 다르다 — 이쪽은 "보여주기"만 한다.
//
//   brief.mjs --prefetch  SessionStart 용. detached 자식에게 넘기고 즉시 종료(세션 시작 지연 0).
//   brief.mjs --hook      SessionStart 표시용(Claude Code·Codex, 동기).
//                         {"systemMessage": "<한 줄>"} 을 출력한다. 보여줄 게 없으면 무출력.
//   brief.mjs --line      pi·opencode 어댑터 용. 문구 한 줄만 stdout 으로 낸다.
//
// 원칙: 네트워크는 --prefetch 에서만 탄다. 표시 경로(--hook/--line)는 로컬 파일만 읽는다(§19.2).
// 표시 빈도는 하루 1회 + 같은 종류 반복 금지 — 판정은 briefing.mjs 의 canShow (§19.12).

import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { endpointOf, loadConfig } from './lib/config.mjs';
import { MAX_AGE_MS, detectLang, loadBriefing, localDay, pickBriefing, saveBriefing } from './lib/briefing.mjs';

const SELF = fileURLToPath(import.meta.url);
const FETCH_TIMEOUT_MS = 4000;

/** 갱신을 detached 자식에게 넘긴다. 부모는 기다리지 않는다(track.mjs 와 같은 패턴). */
function spawnPrefetch() {
  try {
    const child = spawn(process.execPath, [SELF, '--prefetch-run'], { detached: true, stdio: 'ignore' });
    child.on('error', () => {});
    child.unref();
  } catch {
    // 갱신 실패가 세션 시작·표시를 막아선 안 된다
  }
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
      // 표시 기록은 새 데이터가 와도 지우지 않는다. 지우면 하루 1회 가드(§19.12)가 깨져서
      // 표시 → 갱신 → 기록 소멸 → 또 표시 로 끝없이 반복된다.
      lastShownDay: prev?.lastShownDay ?? null,
      lastKey: prev?.lastKey ?? null,
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
function takeLine() {
  const cfg = loadConfig();
  if (!cfg || cfg.brief === false) return null;

  const state = loadBriefing();
  if (!state || !state.data) return null;
  const now = Date.now();
  if (now - (state.fetchedAt ?? 0) > MAX_AGE_MS) return null;

  const picked = pickBriefing(state, state.data, state.prevRank ?? null, detectLang(cfg, state.data), now);
  if (!picked) return null;

  const rank = state.data.rank;
  saveBriefing({
    ...state,
    lastShownDay: localDay(now),
    lastKey: picked.key,
    shownAt: now,
    prevRank: rank ? { global: rank.global ?? null, country: rank.country ?? null } : (state.prevRank ?? null),
  });

  // 방금 띄운 숫자는 이미 낡았다 — prefetch 이후 친 프롬프트가 빠져 있다. 표시 직후 갱신을 걸어
  // "다음에 뜰 줄"이 최신이 되게 한다. detached 라 여기서 기다리지 않으므로
  // §19.2(표시 경로는 네트워크를 타지 않는다)는 그대로다.
  spawnPrefetch();
  return picked.line;
}

try {
  const mode = process.argv[2];
  if (mode === '--prefetch') {
    // 네트워크를 타므로 detached 자식에게 넘기고 부모는 즉시 종료한다(track.mjs 와 같은 패턴).
    spawnPrefetch();
  } else if (mode === '--prefetch-run') {
    await runPrefetch();
  } else if (mode === '--line') {
    const line = takeLine();
    if (line) process.stdout.write(line + '\n');
  } else {
    // --hook: SessionStart 동기 훅. stdin 은 읽지 않는다 — 하루 1회 가드는 전역이라 session_id 가 필요 없다.
    const line = takeLine();
    if (line) process.stdout.write(JSON.stringify({ systemMessage: line }));
  }
} catch {
  // 어떤 오류도 에이전트 사용을 막지 않는다
}
process.exit(0);

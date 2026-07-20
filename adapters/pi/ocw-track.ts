// Open Code War — pi 어댑터.
// input 이벤트(사용자 입력 수신)를 Claude Code 의 UserPromptSubmit 과 같은 의미로 쓴다.
//
// 설치: 이 파일을 ~/.pi/agent/extensions/ 에 심볼릭 링크하면 시작 시 자동 로드된다.
//
// 집계 로직은 여기 없다. Claude Code 훅과 똑같이 plugin/scripts/track.mjs 를 실행해
// 동일한 userId(~/.open-code-war/config.json)와 동일한 페이로드 규칙을 공유한다. (DESIGN.md §4.3)
// 이 파일이 자립형인 이유: pi(jiti)·opencode(bun) 로더가 심볼릭 링크된 파일의 상대 import 를
// 각기 다르게 해석해서, 공용 모듈을 import 하면 로드에 실패한다.

import { spawn } from 'node:child_process';
import { existsSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, delimiter, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const AGENT = 'pi';

// 호스트가 node 위에서 돌지 않을 수도 있으므로(예: bun 으로 컴파일된 실행 파일) node 를 직접 찾는다.
// process.execPath 를 맹신하면 track.mjs 대신 호스트 자신을 재귀 실행하게 된다.
function resolveNode(): string | null {
  if (process.env.OCW_NODE && existsSync(process.env.OCW_NODE)) return process.env.OCW_NODE;

  if (/^node(\.exe)?$/.test(basename(process.execPath))) return process.execPath;

  for (const dir of (process.env.PATH || '').split(delimiter)) {
    if (!dir) continue;
    const candidate = join(dir, 'node');
    try {
      if (existsSync(candidate)) return candidate;
    } catch {
      // 접근 불가한 PATH 항목은 건너뛴다
    }
  }
  return null;
}

// 확장이 주입한 메시지는 사용자가 친 프롬프트가 아니므로 집계하지 않는다.
// interactive(직접 입력)와 rpc(API 호출)만 센다 — Claude Code 가 헤드리스 실행도 세는 것과 같은 기준.
const COUNTED_SOURCES = new Set(['interactive', 'rpc']);

function resolveTrackScript(): string | null {
  const candidates: string[] = [];

  if (process.env.OCW_TRACK_SCRIPT) candidates.push(process.env.OCW_TRACK_SCRIPT);

  // 전역 디렉토리에 심볼릭 링크로 설치되는 것을 전제로 realpath 기준으로 레포를 거슬러 올라간다.
  // adapters/pi/ocw-track.ts → <repo>/plugin/scripts/track.mjs
  try {
    const here = dirname(realpathSync(fileURLToPath(import.meta.url)));
    candidates.push(join(here, '..', '..', 'plugin', 'scripts', 'track.mjs'));
  } catch {
    // realpath 실패는 무시하고 다음 후보로
  }

  // Claude Code 플러그인이 이미 설치돼 있으면 그 스크립트를 재사용한다.
  candidates.push(
    join(homedir(), '.claude', 'plugins', 'marketplaces', 'opencodewar', 'plugin', 'scripts', 'track.mjs'),
  );

  return candidates.find((p) => p && existsSync(p)) ?? null;
}

const TRACK_SCRIPT = resolveTrackScript();
const NODE = resolveNode();

/** 프롬프트 1건 집계. 절대 throw 하지 않고, 호출자를 기다리게 하지 않는다. */
function track(prompt: string): void {
  if (!TRACK_SCRIPT || !NODE) return;
  try {
    const child = spawn(NODE, [TRACK_SCRIPT, '--agent', AGENT], {
      detached: true,
      stdio: ['pipe', 'ignore', 'ignore'],
    });
    child.on('error', () => {});
    child.stdin.on('error', () => {});
    child.stdin.end(JSON.stringify({ prompt }));
    child.unref();
  } catch {
    // 집계 실패가 입력 처리를 막아선 안 된다
  }
}

export default function (pi: any) {
  pi.on('input', async (event: any) => {
    try {
      if (COUNTED_SOURCES.has(event?.source)) track(typeof event?.text === 'string' ? event.text : '');
    } catch {
      // 어떤 오류도 입력 처리를 막지 않는다
    }
    return { action: 'continue' };
  });
}

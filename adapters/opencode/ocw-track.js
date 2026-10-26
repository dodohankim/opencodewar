// Open Code War — OpenCode 어댑터.
// 사용자 프롬프트 수신을 Claude Code 의 UserPromptSubmit 과 같은 의미로 쓴다.
//
// 설치 (둘 중 하나):
//   1) npm:  opencode.json(c) 에  { "plugins": ["open-code-war"] }
//   2) 레포: 이 파일을 ~/.config/opencode/plugins/ 에 심볼릭 링크 (전역 자동 발견 경로)
//
// ※ OpenCode 2 는 V1 플러그인 API 를 실행하지 않는다. 그래서 이 파일은 두 API 를 함께 내보낸다.
//    · default.setup  → OpenCode 2    (Plugin.define 과 같은 모양, @opencode/plugin import 불필요)
//    · default.server → OpenCode 1.18.29+  (V1 로더는 "default export an object with server()" 를 요구한다)
//    · OpenCodeWar    → 그 이전 OpenCode 1 (export 된 함수를 훅 팩토리로 스캔)
//    셋 다 같은 훅 팩토리(legacyHooks)를 쓰고, 한 프로세스에서 두 번 불려도 한 번만 등록한다.
//
// 집계 로직은 여기 없다. Claude Code 훅과 똑같이 plugin/scripts/track.mjs 를 실행해
// 동일한 userId(~/.open-code-war/config.json)와 동일한 페이로드 규칙을 공유한다. (DESIGN.md §4.3)
// 이 파일이 자립형인 이유: pi(jiti)·opencode(bun) 로더가 심볼릭 링크된 파일의 상대 import 를
// 각기 다르게 해석해서, 공용 모듈을 import 하면 로드에 실패한다.
// V2 의 @opencode/plugin 패키지도 import 하지 않는다 — 그 패키지는 Plugin.define(= 항등 함수)만
// 제공하므로, 로더/패키지 해석 문제를 피하려고 같은 모양의 객체를 직접 내보낸다.

import { spawn } from 'node:child_process';
import { existsSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, delimiter, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const AGENT = 'opencode';
const PLUGIN_ID = 'open-code-war';

// opencode 는 bun 으로 컴파일된 단일 실행 파일이라 process.execPath 가 node 가 아니라
// opencode.exe 다. 그대로 쓰면 track.mjs 대신 opencode 를 재귀 실행하게 되므로 직접 찾는다.
function resolveNode() {
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

function resolveTrackScript() {
  const candidates = [];

  if (process.env.OCW_TRACK_SCRIPT) candidates.push(process.env.OCW_TRACK_SCRIPT);

  // 전역 디렉토리에 심볼릭 링크로 설치되는 것을 전제로 realpath 기준으로 레포를 거슬러 올라간다.
  // adapters/opencode/ocw-track.js → <repo>/plugin/scripts/track.mjs
  // npm 패키지(open-code-war)도 같은 배치라 이 후보가 그대로 맞는다.
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

// 세션 브리핑 스크립트는 track.mjs 와 같은 디렉토리에 있다(DESIGN.md §19).
const BRIEF_SCRIPT = (() => {
  if (!TRACK_SCRIPT) return null;
  const p = join(dirname(TRACK_SCRIPT), 'brief.mjs');
  return existsSync(p) ? p : null;
})();

const BRIEF_TIMEOUT_MS = 3000;

/** 세션 시작 시 브리핑을 미리 받아둔다(표시는 하지 않는다). 실패는 무시. */
function prefetchBrief() {
  if (!BRIEF_SCRIPT || !NODE) return;
  try {
    const child = spawn(NODE, [BRIEF_SCRIPT, '--prefetch'], { detached: true, stdio: 'ignore' });
    child.on('error', () => {});
    child.unref();
  } catch {
    // 브리핑 실패가 대화를 막아선 안 된다
  }
}

/** 표시할 브리핑 한 줄. 없으면 null. 문구·빈도 판정은 전부 brief.mjs 안에 있다(§19.12). */
function briefLine() {
  return new Promise((resolve) => {
    if (!BRIEF_SCRIPT || !NODE) return resolve(null);
    try {
      const child = spawn(NODE, [BRIEF_SCRIPT, '--line'], { stdio: ['ignore', 'pipe', 'ignore'] });
      let out = '';
      const finish = (v) => resolve(v);
      const timer = setTimeout(() => finish(null), BRIEF_TIMEOUT_MS);
      child.stdout.on('data', (c) => (out += c));
      child.on('error', () => {
        clearTimeout(timer);
        finish(null);
      });
      child.on('close', () => {
        clearTimeout(timer);
        finish(out.trim() || null);
      });
    } catch {
      resolve(null);
    }
  });
}

/**
 * 프롬프트 1건 집계. 절대 throw 하지 않고, 호출자를 기다리게 하지 않는다.
 * cwd 는 프로젝트 귀속(DESIGN.md §20)에 쓰인다 — 없으면 "기타"로 집계된다.
 */
function track(prompt, cwd) {
  if (!TRACK_SCRIPT || !NODE) return;
  try {
    const child = spawn(NODE, [TRACK_SCRIPT, '--agent', AGENT], {
      detached: true,
      stdio: ['pipe', 'ignore', 'ignore'],
    });
    child.on('error', () => {});
    child.stdin.on('error', () => {});
    child.stdin.end(
      JSON.stringify({
        prompt: typeof prompt === 'string' ? prompt : '',
        cwd: typeof cwd === 'string' ? cwd : '',
      }),
    );
    child.unref();
  } catch {
    // 집계 실패가 대화를 막아선 안 된다
  }
}

/**
 * 세션 메타(서브에이전트 여부 · 세션 디렉토리)를 세션당 한 번만 조회하고 캐시한다.
 * getSession(sessionID) 은 Session.Info(또는 null)를 돌려주는 함수.
 */
function sessionInfoCache(getSession) {
  const cache = new Map();
  return async function infoOf(sessionID) {
    if (!sessionID) return null;
    if (cache.has(sessionID)) return cache.get(sessionID);

    let info = null;
    try {
      info = await getSession(sessionID);
    } catch {
      // 조회 실패 시엔 집계하는 쪽으로 — 사용자 프롬프트일 가능성이 높다
    }

    // V2 는 location.directory, V1 은 directory 에 세션 작업 디렉토리가 있다.
    const directory = info?.location?.directory ?? info?.directory;
    const value = info
      ? { sub: Boolean(info.parentID), directory: typeof directory === 'string' ? directory : null }
      : null;

    if (cache.size > 500) cache.clear();
    cache.set(sessionID, value);
    return value;
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// OpenCode 2 — default export { id, setup }
// ─────────────────────────────────────────────────────────────────────────────

export default {
  id: PLUGIN_ID,

  // ── OpenCode 1.18.29+ : default export 객체의 server() 가 V1 훅 객체를 돌려준다 ──
  async server(input) {
    return legacyHooks(input);
  },

  // ── OpenCode 2 : setup 이 훅을 직접 등록한다 ──
  async setup(ctx) {
    // opencode 에는 SessionStart 훅이 없다 — 플러그인 로드 시점에 한 번 미리 받아둔다.
    prefetchBrief();

    // 사용자 프롬프트는 어드미션 훅(session.hook("prompt"))에서 잡는다.
    // V2 에는 TUI 토스트 API 가 없어서(서버 플러그인 → 클라이언트 알림 경로가 사라짐) 브리핑 "표시"는 생략한다.
    const infoOf = sessionInfoCache((sessionID) => ctx.session.get({ sessionID }));

    await ctx.session.hook('prompt', (event) => {
      // 훅은 await 되므로 프롬프트를 지연시키지 않도록 즉시 반환하고 뒤에서 처리한다.
      const sessionID = event?.sessionID;
      const text = typeof event?.prompt?.text === 'string' ? event.prompt.text : '';
      void (async () => {
        try {
          // 서브에이전트 세션(parentID 보유)은 사용자가 친 프롬프트가 아니므로 집계에서 뺀다.
          const info = await infoOf(sessionID);
          if (info?.sub) return;
          track(text, info?.directory ?? ctx.location?.directory);
        } catch {
          // 어떤 오류도 대화를 막지 않는다
        }
      })();
    });
  },
};

// ─────────────────────────────────────────────────────────────────────────────
// OpenCode 1 (레거시) — 함수가 훅 객체를 반환하는 V1 API. V2 는 이 경로를 쓰지 않는다.
// default.server() 와 명명 export 가 같은 팩토리를 쓰되, 로더가 둘 다 부르더라도 한 번만 등록한다.
// ─────────────────────────────────────────────────────────────────────────────

let legacyRegistered = false;

async function legacyHooks(input) {
  const client = input?.client;
  if (legacyRegistered) return {};
  legacyRegistered = true;

  prefetchBrief();

  // 브리핑은 이 프로세스가 사는 동안 한 번만 시도한다 — 입력마다 node 를 띄우지 않기 위해서다.
  let briefTried = false;

  const infoOf = sessionInfoCache(async (sessionID) => {
    const res = await client.session.get({ path: { id: sessionID } });
    return res?.data ?? null;
  });

  return {
    'chat.message': async (input, output) => {
      const sessionID = input?.sessionID ?? output?.message?.sessionID;
      const text = textOf(output?.parts);
      void (async () => {
        try {
          const info = await infoOf(sessionID);
          if (info?.sub) return;
          track(text, info?.directory);
          if (briefTried) return;
          briefTried = true;
          const line = await briefLine();
          if (line) {
            await client.tui.showToast({ body: { title: 'Open Code War', message: line, variant: 'info' } });
          }
        } catch {
          // 어떤 오류도 대화를 막지 않는다
        }
      })();
    },
  };
}

/** OpenCode 1.18.29 이전 로더용 명명 export — export 된 함수를 훅 팩토리로 스캔한다. */
export const OpenCodeWar = (input) => legacyHooks(input);

/** 사용자 메시지 파트에서 텍스트만 이어붙인다(글자 수 계산용). V1 전용. */
function textOf(parts) {
  if (!Array.isArray(parts)) return '';
  return parts
    .filter((p) => p && p.type === 'text' && typeof p.text === 'string')
    .map((p) => p.text)
    .join('');
}

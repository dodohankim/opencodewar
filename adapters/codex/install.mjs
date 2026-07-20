#!/usr/bin/env node
// Open Code War — Codex 어댑터 설치기.
//
//   node adapters/codex/install.mjs              # 설치(이미 있으면 경로만 갱신)
//   node adapters/codex/install.mjs --uninstall  # 제거
//
// Codex 에는 플러그인 디렉토리가 없다. 훅은 ~/.codex/hooks.json 또는 config.toml 의
// [hooks] 인라인 테이블에서만 읽는다. 그래서 다른 어댑터처럼 심볼릭 링크를 걸 수 없고,
// 사용자의 hooks.json 에 우리 항목을 "병합"해 넣어야 한다.
// 남의 파일을 건드리므로: 기존 항목은 보존하고, 덮어쓰기 전에 .bak 을 남기고, 여러 번
// 실행해도 중복이 생기지 않게 한다.

import { existsSync, mkdirSync, readFileSync, writeFileSync, copyFileSync, chmodSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const EVENT = 'UserPromptSubmit';
const MARKER = 'ocw-track.sh'; // 우리 항목을 알아보는 표식
const TIMEOUT_SEC = 10;

const HERE = dirname(fileURLToPath(import.meta.url));
const SCRIPT = join(HERE, 'ocw-track.sh');
const CODEX_HOME = process.env.CODEX_HOME || join(homedir(), '.codex');
const HOOKS_FILE = join(CODEX_HOME, 'hooks.json');

const uninstall = process.argv.includes('--uninstall');

function print(s) {
  process.stdout.write(s + '\n');
}

function fail(s) {
  process.stderr.write(s + '\n');
  process.exit(1);
}

/** 셸 명령 문자열로 들어가므로 공백이 있으면 따옴표로 감싼다. */
function shellQuote(p) {
  return /[\s"']/.test(p) ? `'${p.replace(/'/g, `'\\''`)}'` : p;
}

/** hooks.json 읽기. 없으면 빈 객체, 깨져 있으면 중단(사용자 파일을 날리지 않는다). */
function readHooks() {
  if (!existsSync(HOOKS_FILE)) return {};
  const raw = readFileSync(HOOKS_FILE, 'utf8');
  if (!raw.trim()) return {};
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('object 가 아님');
    return parsed;
  } catch (e) {
    fail(`${HOOKS_FILE} 를 읽을 수 없습니다(${e.message}). 직접 확인한 뒤 다시 실행하세요.`);
  }
}

function writeHooks(doc) {
  mkdirSync(CODEX_HOME, { recursive: true });
  if (existsSync(HOOKS_FILE)) copyFileSync(HOOKS_FILE, `${HOOKS_FILE}.bak`);
  writeFileSync(HOOKS_FILE, JSON.stringify(doc, null, 2) + '\n');
}

const doc = readHooks();
const events = doc.hooks && typeof doc.hooks === 'object' ? doc.hooks : {};
const groups = Array.isArray(events[EVENT]) ? events[EVENT] : [];

const isOurs = (h) => h && typeof h.command === 'string' && h.command.includes(MARKER);

if (uninstall) {
  const cleaned = groups
    .map((g) => (Array.isArray(g?.hooks) ? { ...g, hooks: g.hooks.filter((h) => !isOurs(h)) } : g))
    .filter((g) => !Array.isArray(g?.hooks) || g.hooks.length > 0);

  if (cleaned.length === groups.length && JSON.stringify(cleaned) === JSON.stringify(groups)) {
    print('등록된 Open Code War 훅이 없습니다.');
    process.exit(0);
  }

  if (cleaned.length) events[EVENT] = cleaned;
  else delete events[EVENT];
  doc.hooks = events;
  if (!Object.keys(events).length) delete doc.hooks;

  writeHooks(doc);
  print(`제거했습니다: ${HOOKS_FILE} (이전 파일은 hooks.json.bak)`);
  print('Codex 를 재시작하면 반영됩니다.');
  process.exit(0);
}

if (!existsSync(SCRIPT)) fail(`어댑터 스크립트를 찾을 수 없습니다: ${SCRIPT}`);
try {
  chmodSync(SCRIPT, 0o755);
} catch {
  // 권한 변경 실패는 치명적이지 않다 — 훅은 sh 로 실행된다
}

const command = `${shellQuote(SCRIPT)}`;
const entry = { type: 'command', command, timeout: TIMEOUT_SEC };

// 이미 등록돼 있으면 중복을 만들지 않고 경로/타임아웃만 최신으로 맞춘다(레포를 옮긴 경우).
let updated = false;
for (const g of groups) {
  if (!Array.isArray(g?.hooks)) continue;
  for (let i = 0; i < g.hooks.length; i++) {
    if (isOurs(g.hooks[i])) {
      g.hooks[i] = { ...g.hooks[i], ...entry };
      updated = true;
    }
  }
}
if (!updated) groups.push({ hooks: [entry] });

events[EVENT] = groups;
doc.hooks = events;
writeHooks(doc);

print(`${updated ? '갱신' : '설치'} 완료 — ${HOOKS_FILE}`);
print(`  ${EVENT} → ${command}`);
print('');
print('⚠️  한 단계 남았습니다: Codex 는 새로 추가·변경된 훅을 "신뢰"하기 전까지 실행하지 않습니다.');
print('   codex 를 실행하면 시작 화면에 "Hooks need review" 가 뜹니다.');
print('   → "Trust all and continue" 를 선택하세요. (선택 전에는 조용히 집계되지 않습니다)');
print('');
print('그 다음 프롬프트부터 집계됩니다. 이 설치기를 다시 돌려 경로가 바뀌면 신뢰도 다시 받아야 합니다.');

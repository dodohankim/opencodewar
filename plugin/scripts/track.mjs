#!/usr/bin/env node
// UserPromptSubmit 훅: 프롬프트 제출 1건을 API로 전송한다.
// 원칙(DESIGN.md §4.3):
//  - 프롬프트 "내용"은 전송하지 않는다. 글자 수(숫자)만 보낸다.
//  - 절대 사용자를 방해하지 않는다: 전송은 detached 자식 프로세스로 넘기고 즉시 종료(fire-and-forget).
//  - stdout에 아무것도 출력하지 않는다(프롬프트 컨텍스트 오염 방지). exit 0.

import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { ensureConfig, endpointOf } from './lib/config.mjs';
import { countChars } from './lib/chars.mjs';

const SELF = fileURLToPath(import.meta.url);
const SEND_TIMEOUT_MS = 2000;
const STDIN_TIMEOUT_MS = 800;

async function send(endpoint, payload) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), SEND_TIMEOUT_MS);
  try {
    await fetch(`${endpoint}/track`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: payload,
      signal: ctrl.signal,
    });
  } catch {
    // fire-and-forget: 실패해도 조용히 무시
  } finally {
    clearTimeout(timer);
  }
}

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

async function hookMode() {
  try {
    const cfg = ensureConfig();
    if (cfg.enabled === false) return; // /ocw disable 상태면 집계 안 함

    const raw = await readStdin();
    let prompt = '';
    try {
      const data = JSON.parse(raw);
      // 필드명은 버전에 따라 user_prompt / prompt — 둘 다 대응
      prompt = data.user_prompt ?? data.prompt ?? '';
    } catch {
      // 파싱 실패 시 chars=0으로 진행 (여전히 1건으로 집계)
    }

    const payload = JSON.stringify({ userId: cfg.userId, chars: countChars(prompt) });

    // 전송은 detached 자식에게 위임하고 부모는 즉시 종료 → 프롬프트 지연 0
    const child = spawn(process.execPath, [SELF, '--send', endpointOf(cfg), payload], {
      detached: true,
      stdio: 'ignore',
    });
    child.unref();
  } catch {
    // 어떤 오류도 프롬프트 처리를 막지 않는다
  }
}

if (process.argv[2] === '--send') {
  await send(process.argv[3], process.argv[4]);
  process.exit(0);
} else {
  await hookMode();
  process.exit(0);
}

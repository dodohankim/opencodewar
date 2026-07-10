#!/usr/bin/env node
// /ocw 슬래시 커맨드가 호출하는 CLI. 출력(stdout)은 커맨드 결과로 사용자에게 노출된다.
// 서브커맨드: nickname <이름> | status | whoami | enable | disable | help

import { ensureConfig, saveConfig, endpointOf } from './lib/config.mjs';

const args = process.argv.slice(2);
const sub = (args[0] || 'status').toLowerCase();
const rest = args.slice(1);

const cfg = ensureConfig();
const endpoint = endpointOf(cfg);

function print(s) {
  process.stdout.write(s + '\n');
}

async function registerNickname(name) {
  const nickname = name.trim();
  if (!nickname) {
    return print('사용법: `/ocw nickname <이름>` — 2~20자, 한글/영문/숫자/underscore/공백');
  }
  try {
    const res = await fetch(`${endpoint}/register`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ userId: cfg.userId, nickname }),
      signal: AbortSignal.timeout(4000),
    });
    const data = await res.json().catch(() => ({}));
    if (res.ok && data.ok) {
      cfg.nickname = data.nickname;
      saveConfig(cfg);
      return print(`✅ 닉네임 등록 완료: **${data.nickname}**\n리더보드에 이 이름으로 표시됩니다.`);
    }
    if (res.status === 409 || data.error === 'nickname_taken') {
      return print(`❌ 이미 사용 중인 닉네임입니다: ${nickname}`);
    }
    if (data.error === 'invalid_nickname') {
      return print('❌ 닉네임 형식이 올바르지 않습니다 (2~20자, 한글/영문/숫자/underscore/공백).');
    }
    return print(`❌ 등록 실패 (status ${res.status}).`);
  } catch {
    return print(`❌ 서버에 연결하지 못했습니다: ${endpoint}\n엔드포인트는 OCW_API_URL 환경변수 또는 config.endpoint로 설정합니다.`);
  }
}

async function setBio(text) {
  const bio = text.trim();
  if (bio.length > 160) {
    return print('사용법: `/ocw bio <소개>` — 최대 160자, 한 줄. 비우려면 `/ocw bio` (인자 없이).');
  }
  try {
    const res = await fetch(`${endpoint}/profile`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ userId: cfg.userId, bio }),
      signal: AbortSignal.timeout(4000),
    });
    const data = await res.json().catch(() => ({}));
    if (res.ok && data.ok) {
      cfg.bio = data.bio ?? null;
      saveConfig(cfg);
      return print(
        data.bio
          ? `✅ 자기소개 등록 완료:\n> ${data.bio}\n상세 페이지에 이 소개가 표시됩니다.`
          : '✅ 자기소개를 비웠습니다.',
      );
    }
    if (data.error === 'invalid_bio') {
      return print('❌ 자기소개 형식이 올바르지 않습니다 (최대 160자, 제어문자 불가).');
    }
    return print(`❌ 등록 실패 (status ${res.status}).`);
  } catch {
    return print(`❌ 서버에 연결하지 못했습니다: ${endpoint}`);
  }
}

async function status() {
  // 닉네임은 서버 기준으로 표시한다(미등록이면 자동 닉네임). 조회 실패 시에만 로컬값으로 폴백.
  let serverNick = null;
  let statLine = null;
  try {
    const res = await fetch(
      `${endpoint}/me?userId=${encodeURIComponent(cfg.userId)}&type=daily`,
      { signal: AbortSignal.timeout(4000) },
    );
    if (res.ok) {
      const d = await res.json();
      if (d.me) {
        serverNick = d.me.nickname ?? null;
        statLine = `- 오늘(일간): ${d.me.prompts} 프롬프트 · ${d.me.chars} 글자 · 순위 ${d.me.rank ?? '-'}/${d.me.total}`;
      }
    }
  } catch {
    // 순위 조회 실패는 조용히 생략
  }
  const nickname = serverNick ?? cfg.nickname ?? '(자동 생성)';
  const lines = ['**Open Code War — 내 정보**', `- 닉네임: ${nickname}`];
  if (statLine) lines.push(statLine);
  return print(lines.join('\n'));
}

function help() {
  return print(
    [
      '**Open Code War CLI**',
      '- `/ocw nickname <이름>` — 닉네임 등록/변경',
      '- `/ocw bio <소개>` — 자기소개 등록(상세 페이지 표시, 최대 160자)',
      '- `/ocw status` — 내 정보 및 오늘 순위',
      '- `/ocw disable` / `/ocw enable` — 집계 끄기/켜기',
      '',
      '프롬프트 내용은 수집하지 않습니다. 글자 수만 집계합니다.',
    ].join('\n'),
  );
}

async function main() {
  switch (sub) {
    case 'nickname':
      return registerNickname(rest.join(' '));
    case 'bio':
      return setBio(rest.join(' '));
    case 'enable':
      cfg.enabled = true;
      saveConfig(cfg);
      return print('● 집계를 켰습니다.');
    case 'disable':
      cfg.enabled = false;
      saveConfig(cfg);
      return print('⏸ 집계를 껐습니다. 다시 켜려면 `/ocw enable`.');
    case 'status':
    case 'whoami':
      return status();
    case 'help':
      return help();
    default:
      print(`알 수 없는 명령: ${sub}\n`);
      return help();
  }
}

await main();

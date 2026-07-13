#!/usr/bin/env node
// /ocw 슬래시 커맨드가 호출하는 CLI. 출력(stdout)은 커맨드 결과로 사용자에게 노출된다.
// 서브커맨드:
//   nickname <이름> | bio <소개> | role <직함> | company <회사>
//   link <website|github|x|linkedin> <url>
//   project add <이름> :: <설명> :: <url> | project list | project remove <번호> | project clear
//   status | whoami | enable | disable | help

import { ensureConfig, saveConfig, endpointOf } from './lib/config.mjs';

// ocw.md 는 인자를 "$ARGUMENTS" 로 감싸 넘기므로 보통 argv 는 하나의 문자열이다.
// 따옴표 없이 여러 토큰으로 와도 안전하도록 공백으로 재조립한 뒤 첫 토큰만 서브커맨드로 분리한다.
const argStr = process.argv.slice(2).join(' ').trim();
const firstSpace = argStr.indexOf(' ');
const sub = (firstSpace === -1 ? argStr : argStr.slice(0, firstSpace)).toLowerCase() || 'status';
const rest = firstSpace === -1 ? '' : argStr.slice(firstSpace + 1).trim();

const cfg = ensureConfig();
const endpoint = endpointOf(cfg);

const LINK_KEYS = ['website', 'github', 'x', 'linkedin'];
const MAX_PROJECTS = 5;

// 직함/회사/자기소개 공통 텍스트 필드 메타.
const TEXT_FIELDS = {
  bio: { max: 160, label: '자기소개' },
  role: { max: 40, label: '직함' },
  company: { max: 40, label: '회사' },
};

function print(s) {
  process.stdout.write(s + '\n');
}

/** POST /profile 부분 패치. { userId, ...patch } 를 보낸다. */
async function apiPost(patch) {
  const res = await fetch(`${endpoint}/profile`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ userId: cfg.userId, ...patch }),
    signal: AbortSignal.timeout(4000),
  });
  const data = await res.json().catch(() => ({}));
  return { res, data };
}

/** GET /me — 서버 기준 내 프로필/순위. 실패 시 null. (links/projects 편집의 기준값) */
async function fetchMe() {
  try {
    const res = await fetch(`${endpoint}/me?userId=${encodeURIComponent(cfg.userId)}&type=daily`, {
      signal: AbortSignal.timeout(4000),
    });
    if (!res.ok) return null;
    const d = await res.json();
    return d.me || null;
  } catch {
    return null;
  }
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

/** bio/role/company 설정. 빈 값이면 해제. */
async function setText(field, text) {
  const meta = TEXT_FIELDS[field];
  const value = text.trim();
  if (value.length > meta.max) {
    return print(`사용법: \`/ocw ${field} <내용>\` — 최대 ${meta.max}자. 비우려면 인자 없이 \`/ocw ${field}\`.`);
  }
  try {
    const { res, data } = await apiPost({ [field]: value });
    if (res.ok && data.ok) {
      cfg[field] = data[field] ?? null;
      saveConfig(cfg);
      const saved = data[field];
      return print(saved ? `✅ ${meta.label} 등록:\n> ${saved}` : `✅ ${meta.label}을(를) 비웠습니다.`);
    }
    if (data.error === `invalid_${field}`) {
      return print(`❌ ${meta.label} 형식이 올바르지 않습니다 (최대 ${meta.max}자, 제어문자 불가).`);
    }
    return print(`❌ 저장 실패 (status ${res.status}).`);
  } catch {
    return print(`❌ 서버에 연결하지 못했습니다: ${endpoint}`);
  }
}

/** link <종류> <url> — 소셜/개인 링크 설정. url 생략 시 해당 종류 해제. */
async function setLink(input) {
  const sp = input.indexOf(' ');
  const key = (sp === -1 ? input : input.slice(0, sp)).toLowerCase().trim();
  const url = (sp === -1 ? '' : input.slice(sp + 1)).trim();
  if (!LINK_KEYS.includes(key)) {
    return print(`사용법: \`/ocw link <종류> <url>\` — 종류: ${LINK_KEYS.join(' / ')}. 지우려면 url 없이 \`/ocw link ${LINK_KEYS[0]}\`.`);
  }
  // 다른 링크를 보존하기 위해 서버의 현재 links 를 읽어 해당 키만 교체한다.
  const me = await fetchMe();
  const links = me && me.links ? { ...me.links } : { ...(cfg.links || {}) };
  if (url) links[key] = url;
  else delete links[key];
  try {
    const { res, data } = await apiPost({ links });
    if (res.ok && data.ok) {
      cfg.links = data.links || {};
      saveConfig(cfg);
      return print(url ? `✅ 링크 등록: ${key} → ${url}` : `✅ ${key} 링크를 제거했습니다.`);
    }
    if (data.error === 'invalid_links') {
      return print('❌ 링크 형식이 올바르지 않습니다 (http(s):// 로 시작하는 URL, 최대 200자).');
    }
    return print(`❌ 저장 실패 (status ${res.status}).`);
  } catch {
    return print(`❌ 서버에 연결하지 못했습니다: ${endpoint}`);
  }
}

/** 서버에 projects 배열 전체를 저장하고 로컬 캐시를 갱신한다. */
async function pushProjects(projects, okMsg) {
  try {
    const { res, data } = await apiPost({ projects });
    if (res.ok && data.ok) {
      cfg.projects = data.projects || [];
      saveConfig(cfg);
      return print(okMsg);
    }
    if (data.error === 'invalid_projects') {
      return print('❌ 프로젝트 형식 오류 (이름 ≤40자, 설명 ≤80자, url 은 http(s), 최대 5개).');
    }
    return print(`❌ 저장 실패 (status ${res.status}).`);
  } catch {
    return print(`❌ 서버에 연결하지 못했습니다: ${endpoint}`);
  }
}

function projectUsage() {
  return [
    '사용법:',
    '- `/ocw project add <이름> :: <설명> :: <url>` (설명·url 선택, 최대 5개)',
    '- `/ocw project list`',
    '- `/ocw project remove <번호>`',
    '- `/ocw project clear`',
    '예) `/ocw project add Open Code War :: Claude Code 리더보드 :: https://opencodewar.dev`',
  ].join('\n');
}

/** project add|list|remove|clear — 홍보용 사이드프로젝트(최대 5개) 관리. */
async function project(input) {
  const sp = input.indexOf(' ');
  const action = (sp === -1 ? input : input.slice(0, sp)).toLowerCase() || 'list';
  const remainder = (sp === -1 ? '' : input.slice(sp + 1)).trim();

  // 다른 항목 보존을 위해 서버의 현재 projects 를 기준값으로 삼는다(실패 시 로컬 캐시).
  const me = await fetchMe();
  const current = Array.isArray(me?.projects)
    ? me.projects
    : Array.isArray(cfg.projects)
      ? cfg.projects
      : [];

  if (action === 'list') {
    if (!current.length) {
      return print('등록된 프로젝트가 없습니다.\n' + projectUsage());
    }
    const lines = ['**Shipping — 내 프로젝트**'];
    current.forEach((p, i) => {
      const parts = [`${i + 1}. ${p.name}`];
      if (p.desc) parts.push(`— ${p.desc}`);
      if (p.url) parts.push(`(${p.url})`);
      lines.push(parts.join(' '));
    });
    lines.push(`\n${current.length}/${MAX_PROJECTS} 사용 중.`);
    return print(lines.join('\n'));
  }

  if (action === 'add') {
    if (current.length >= MAX_PROJECTS) {
      return print(`❌ 프로젝트는 최대 ${MAX_PROJECTS}개입니다. 먼저 \`/ocw project remove <번호>\` 로 지우세요.`);
    }
    const [name, desc, url] = remainder.split(/\s*::\s*/).map((s) => (s || '').trim());
    if (!name) {
      return print(projectUsage());
    }
    const item = { name };
    if (desc) item.desc = desc;
    if (url) item.url = url;
    const next = [...current, item];
    return pushProjects(next, `✅ 프로젝트 추가: ${name} (${next.length}/${MAX_PROJECTS})`);
  }

  if (action === 'remove') {
    const idx = Number(remainder);
    if (!Number.isInteger(idx) || idx < 1 || idx > current.length) {
      return print(`사용법: \`/ocw project remove <번호>\` — 1~${current.length || 0} 사이. 목록은 \`/ocw project list\`.`);
    }
    const removed = current[idx - 1];
    const next = current.filter((_, i) => i !== idx - 1);
    return pushProjects(next, `✅ 제거: ${removed.name} (${next.length}/${MAX_PROJECTS})`);
  }

  if (action === 'clear') {
    if (!current.length) return print('이미 비어 있습니다.');
    return pushProjects([], '✅ 프로젝트를 모두 비웠습니다.');
  }

  return print(projectUsage());
}

/**
 * delete             → 프로필만 비움(bio·직함·회사·링크·프로젝트). 닉네임·사용량·순위는 유지.
 * delete all         → 완전 삭제 경고(확인 요구).
 * delete all confirm → 사용량·통계·프로필 전부 영구 삭제 + 집계 중지(삭제권).
 */
async function deleteData(arg) {
  const a = arg.trim().toLowerCase();

  // ── 완전 삭제(삭제권): /ocw delete all [confirm] ──
  if (a === 'all' || a === 'all confirm') {
    if (a !== 'all confirm') {
      return print(
        [
          '⚠️ **완전 삭제 — 되돌릴 수 없습니다.**',
          '사용량 기록·통계·프로필이 모두 영구 삭제되고 리더보드에서도 사라집니다.',
          '',
          '확실하면 → `/ocw delete all confirm`',
          '(프로필만 비우고 순위는 남기려면 → `/ocw delete`)',
        ].join('\n'),
      );
    }
    try {
      const res = await fetch(`${endpoint}/delete`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ userId: cfg.userId }),
        signal: AbortSignal.timeout(4000),
      });
      const data = await res.json().catch(() => ({}));
      if (res.ok && data.ok) {
        // 로컬 미러 초기화 + 집계 중지(다음 프롬프트에서 재생성 방지). userId 는 유지.
        Object.assign(cfg, { nickname: null, bio: null, role: null, company: null, links: {}, projects: [], enabled: false });
        saveConfig(cfg);
        return print('✅ 모든 데이터를 삭제했고 집계를 껐습니다.\n다시 시작하려면 `/ocw enable` 후 프롬프트를 입력하세요.');
      }
      return print(`❌ 삭제 실패 (status ${res.status}).`);
    } catch {
      return print(`❌ 서버에 연결하지 못했습니다: ${endpoint}`);
    }
  }

  // ── 기본: 프로필만 비우기(닉네임·사용량·순위는 그대로) ──
  try {
    const { res, data } = await apiPost({ bio: '', role: '', company: '', links: {}, projects: [] });
    if (res.ok && data.ok) {
      Object.assign(cfg, { bio: null, role: null, company: null, links: {}, projects: [] });
      saveConfig(cfg);
      return print(
        [
          '✅ 프로필을 비웠습니다 — 자기소개·직함·회사·링크·프로젝트 제거.',
          '닉네임과 사용량(리더보드 순위)은 그대로 유지됩니다.',
          '',
          '기록까지 완전히 지우려면 → `/ocw delete all`',
        ].join('\n'),
      );
    }
    return print(`❌ 실패 (status ${res.status}).`);
  } catch {
    return print(`❌ 서버에 연결하지 못했습니다: ${endpoint}`);
  }
}

async function status() {
  // 서버(/me)를 기준으로 표시하고, 조회 실패 시에만 로컬 config 로 폴백한다.
  const me = await fetchMe();
  const pick = (k, dflt) => (me ? me[k] ?? dflt : cfg[k] ?? dflt);

  const nickname = (me && me.nickname) || cfg.nickname || '(자동 생성)';
  const bio = pick('bio', null);
  const role = pick('role', null);
  const company = pick('company', null);
  const links = pick('links', {}) || {};
  const projects = pick('projects', []) || [];

  const lines = ['**Open Code War — 내 정보**', `- 닉네임: ${nickname}`];

  const roleLine = [role, company ? `@ ${company}` : ''].filter(Boolean).join(' ');
  if (roleLine) lines.push(`- 직함: ${roleLine}`);

  lines.push(bio ? `- 자기소개: ${bio}` : '- 자기소개: (없음) — `/ocw bio <소개>`');

  const linkKeys = Object.keys(links);
  lines.push(
    linkKeys.length
      ? `- 링크: ${linkKeys.map((k) => `${k}(${links[k]})`).join(' · ')}`
      : '- 링크: (없음) — `/ocw link github <url>`',
  );

  if (projects.length) {
    lines.push(`- 프로젝트(${projects.length}/${MAX_PROJECTS}): ${projects.map((p) => p.name).join(', ')}`);
  } else {
    lines.push(`- 프로젝트: (없음) — \`/ocw project add <이름> :: <설명> :: <url>\``);
  }

  if (me) {
    lines.push(`- 오늘(일간): ${me.prompts} 프롬프트 · ${me.chars} 글자 · 순위 ${me.rank ?? '-'}/${me.total}`);
  }
  return print(lines.join('\n'));
}

function help() {
  return print(
    [
      '**Open Code War CLI**',
      '- `/ocw nickname <이름>` — 닉네임 등록/변경',
      '- `/ocw bio <소개>` — 자기소개 (최대 160자)',
      '- `/ocw role <직함>` — 직함 (예: Frontend Engineer)',
      '- `/ocw company <회사>` — 소속/회사',
      '- `/ocw link <종류> <url>` — 링크 (종류: website/github/x/linkedin)',
      '- `/ocw project add <이름> :: <설명> :: <url>` — 사이드프로젝트 (최대 5개)',
      '- `/ocw project list | remove <번호> | clear` — 프로젝트 관리',
      '- `/ocw status` — 내 정보 및 오늘 순위',
      '- `/ocw disable` / `/ocw enable` — 집계 끄기/켜기',
      '- `/ocw delete` — 프로필만 비움(닉네임·순위·사용량 유지)',
      '- `/ocw delete all` — 사용량 포함 전부 영구 삭제(되돌릴 수 없음)',
      '',
      '값을 비우려면 인자 없이 실행하세요 (예: `/ocw bio`, `/ocw link github`).',
      '프롬프트 내용은 수집하지 않습니다. 글자 수만 집계합니다.',
      '개인정보처리방침: https://opencodewar.dev/privacy · 문의: contact@opencodewar.dev',
    ].join('\n'),
  );
}

async function main() {
  switch (sub) {
    case 'nickname':
      return registerNickname(rest);
    case 'bio':
    case 'role':
    case 'company':
      return setText(sub, rest);
    case 'link':
      return setLink(rest);
    case 'project':
    case 'projects':
      return project(rest);
    case 'delete':
      return deleteData(rest);
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

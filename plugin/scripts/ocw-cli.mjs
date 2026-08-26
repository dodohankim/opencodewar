#!/usr/bin/env node
// /ocw 슬래시 커맨드가 호출하는 CLI. 출력(stdout)은 커맨드 결과로 사용자에게 노출된다.
// 서브커맨드:
//   nickname <이름> | bio <소개> | role <직함> | company <회사>
//   link <website|github|x|linkedin> <url>
//   project add <이름> :: <설명> :: <url> | project list | project main <번호|이름> | project remove|delete <번호|이름> | project clear
//   project link <이름> | project unlink — 현재 폴더를 프로젝트에 연결/해제 (프롬프트 귀속, DESIGN.md §20)
//   project auto on|off — 링크 안 된 폴더의 폴더명 자동 집계 (옵트인, DESIGN.md §20.7)
//   project submarine <번호|이름> — 잠수함 모드 토글 (공개 페이지엔 "secret #n", DESIGN.md §20.7)
//   signup | login — Google 계정 연동 (DESIGN.md §14)
//   email public|private — 연동 이메일 프로필 공개 여부 (기본 비공개)
//   battle new <이름> <기간> | battle join <코드> | battle status [코드] | battle leave <코드> — 교전(§22)
//   random — 등록 유저 중 무작위 한 명의 공개 프로필 카드
//   brief on|off — 세션 시작 브리핑 표시 여부 (DESIGN.md §19)
//   status | whoami | enable | disable | help

import { autoProjectLabel, ensureConfig, saveConfig, endpointOf, normalizeDir, projectFor } from './lib/config.mjs';

// ocw.md 는 인자를 "$ARGUMENTS" 로 감싸 넘기므로 보통 argv 는 하나의 문자열이다.
// 따옴표 없이 여러 토큰으로 와도 안전하도록 공백으로 재조립한 뒤 첫 토큰만 서브커맨드로 분리한다.
const argStr = process.argv.slice(2).join(' ').trim();
const firstSpace = argStr.indexOf(' ');
const sub = (firstSpace === -1 ? argStr : argStr.slice(0, firstSpace)).toLowerCase() || 'status';
const rest = firstSpace === -1 ? '' : argStr.slice(firstSpace + 1).trim();

const cfg = ensureConfig();
const endpoint = endpointOf(cfg);

const LINK_KEYS = ['website', 'blog', 'github', 'x', 'linkedin'];
const MAX_PROJECTS = 10; // 서버 validate.ts MAX_PROJECTS 와 동일

// 직함/회사/자기소개/도시 공통 텍스트 필드 메타.
const TEXT_FIELDS = {
  bio: { max: 160, label: '자기소개' },
  role: { max: 40, label: '직함' },
  company: { max: 40, label: '회사' },
  city: { max: 40, label: '도시' },
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

/**
 * /ocw signup — Google 계정 연동 시작(DESIGN.md §14). 링크 코드를 받아 URL 을 출력하고,
 * 코드를 config.pendingLinkCode 에 저장해 둔다. 완료 반영은 resolvePendingLink 가 한다.
 */
async function signup() {
  try {
    const res = await fetch(`${endpoint}/auth/start`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ userId: cfg.userId }),
      signal: AbortSignal.timeout(4000),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data.url) {
      return print(`❌ 연동 시작 실패: ${data.error || `HTTP ${res.status}`}`);
    }
    cfg.pendingLinkCode = data.code;
    saveConfig(cfg);
    return print(
      [
        '**Google 계정 연동**',
        '아래 링크를 브라우저에서 열어 로그인하세요 (10분 유효):',
        '',
        data.url,
        '',
        '완료 후 아무 `/ocw` 명령이나 실행하면 반영됩니다 (예: `/ocw status`).',
        cfg.account && cfg.account.email ? `현재 연동: ${cfg.account.email} — 계속하면 다시 연동합니다.` : null,
      ]
        .filter((l) => l !== null)
        .join('\n'),
    );
  } catch {
    return print('❌ 서버에 연결할 수 없습니다. 잠시 후 다시 시도하세요.');
  }
}

/**
 * signup 후 브라우저에서 완료됐는지 다음 실행 때 회수한다(슬래시 커맨드는 폴링 불가 — DESIGN.md §14.3).
 * 완료 시 userId 교체(옮겨 타기)·병합 결과 안내까지 처리한다. 반환값은 안내 문구(없으면 null).
 */
async function resolvePendingLink() {
  const code = cfg.pendingLinkCode;
  if (!code) return null;
  try {
    const res = await fetch(
      `${endpoint}/auth/status?code=${encodeURIComponent(code)}&userId=${encodeURIComponent(cfg.userId)}`,
      { signal: AbortSignal.timeout(4000) },
    );
    if (!res.ok) {
      // forbidden 등 복구 불가 응답이면 코드를 버린다. 일시 오류(5xx)는 다음 실행 때 재시도.
      if (res.status === 400 || res.status === 403) {
        delete cfg.pendingLinkCode;
        saveConfig(cfg);
      }
      return null;
    }
    const d = await res.json().catch(() => null);
    if (!d) return null;
    if (d.status === 'done') {
      const lines = [];
      if (d.canonicalUserId && d.canonicalUserId !== cfg.userId) {
        cfg.userId = d.canonicalUserId;
        const m = d.merged;
        lines.push(
          m && (m.prompts || m.chars)
            ? `✅ Google 연동 완료 — 기존 계정으로 옮겨탔습니다. 이 기기의 기록을 합쳤습니다: +${m.prompts} 프롬프트 · +${m.chars} 글자`
            : '✅ Google 연동 완료 — 기존 계정으로 옮겨탔습니다.',
        );
      } else {
        lines.push('✅ Google 연동 완료 — 이제 다른 기기에서도 `/ocw signup` 으로 이 계정을 이어 쓸 수 있습니다.');
      }
      cfg.account = { email: d.email ?? null, emailPublic: false };
      delete cfg.pendingLinkCode;
      saveConfig(cfg);
      return lines.join('\n');
    }
    if (d.status === 'expired') {
      delete cfg.pendingLinkCode;
      saveConfig(cfg);
      return 'ℹ️ 연동 링크가 만료되었습니다. `/ocw signup` 으로 다시 시작하세요.';
    }
    return null; // pending — 조용히 대기
  } catch {
    return null; // 오프라인 등 — 다음 실행 때 재시도
  }
}

/**
 * /ocw email public|private — 연동 이메일을 공개 프로필에 노출할지(옵트인, 기본 비공개).
 * 비공개면 본인(status)만 볼 수 있고 웹 상세/공개 API 에는 나가지 않는다.
 */
async function emailVisibility(input) {
  const v = input.trim().toLowerCase();
  if (v !== 'public' && v !== 'private') {
    const linked = cfg.account && cfg.account.email;
    return print(
      [
        linked
          ? `현재: ${cfg.account.email} · ${cfg.account.emailPublic ? '공개' : '비공개(기본)'}`
          : '현재: Google 미연동 — `/ocw signup` 을 먼저 실행하세요.',
        '사용법: `/ocw email public` — 프로필에 이메일 공개 · `/ocw email private` — 비공개(기본)',
      ].join('\n'),
    );
  }
  try {
    const res = await fetch(`${endpoint}/account`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ userId: cfg.userId, emailPublic: v === 'public' }),
      signal: AbortSignal.timeout(4000),
    });
    const data = await res.json().catch(() => ({}));
    if (res.status === 404) return print('❌ Google 연동이 필요합니다 — `/ocw signup` 을 먼저 실행하세요.');
    if (!res.ok) return print(`❌ 변경 실패: ${data.error || `HTTP ${res.status}`}`);
    cfg.account = { ...(cfg.account || {}), emailPublic: v === 'public' };
    saveConfig(cfg);
    return print(
      v === 'public'
        ? '● 이메일을 프로필에 공개합니다. 다시 숨기려면 `/ocw email private`.'
        : '⏸ 이메일을 비공개로 전환했습니다(기본값). 본인 status 에만 표시됩니다.',
    );
  } catch {
    return print('❌ 서버에 연결할 수 없습니다. 잠시 후 다시 시도하세요.');
  }
}

/** /ocw random — 등록 유저 중 무작위 한 명의 공개 프로필 카드(서버가 공개 정보만 내려준다). */
async function randomUser() {
  try {
    const res = await fetch(`${endpoint}/random`, { signal: AbortSignal.timeout(4000) });
    const data = await res.json().catch(() => ({}));
    if (res.status === 404) return print('아직 등록된 유저가 없습니다.');
    if (!res.ok || !data.user) return print(`❌ 조회 실패: ${data.error || `HTTP ${res.status}`}`);

    const u = data.user;
    const lines = [`**🎲 랜덤 코드워리어 — ${u.nickname}**`];
    const roleLine = [u.role, u.company ? `@ ${u.company}` : ''].filter(Boolean).join(' ');
    if (roleLine) lines.push(`- 직함: ${roleLine}`);
    if (u.bio) lines.push(`- 자기소개: ${u.bio}`);
    if (u.email) lines.push(`- 이메일: ${u.email}`);
    const linkKeys = Object.keys(u.links || {});
    if (linkKeys.length) lines.push(`- 링크: ${linkKeys.map((k) => `${k}(${u.links[k]})`).join(' · ')}`);
    if (Array.isArray(u.projects) && u.projects.length) {
      lines.push(`- 프로젝트: ${u.projects.map((p) => p.name).join(', ')}`);
    }
    const zone = [u.country ? `${u.flag || ''} ${u.country}`.trim() : null, u.city].filter(Boolean).join(' · ');
    if (zone) lines.push(`- 구역: ${zone}`);
    lines.push(`- 전체: ${u.prompts} 프롬프트 · ${u.chars} 글자`);
    lines.push(`- 페이지: ${endpoint}/u/${encodeURIComponent(u.nickname)}`);
    return print(lines.join('\n'));
  } catch {
    return print('❌ 서버에 연결할 수 없습니다. 잠시 후 다시 시도하세요.');
  }
}

async function registerNickname(name) {
  const nickname = name.trim();
  if (!nickname) {
    return print('사용법: `/ocw nickname <이름>` — 2~15자, 한글/영문/숫자/underscore/공백');
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
      return print(
        `✅ 닉네임 등록 완료: **${data.nickname}**\n리더보드에 이 이름으로 표시됩니다.\n내 프로필: ${endpoint}/u/${encodeURIComponent(data.nickname)}`,
      );
    }
    if (res.status === 409 || data.error === 'nickname_taken') {
      return print(`❌ 이미 사용 중인 닉네임입니다: ${nickname}`);
    }
    if (data.error === 'invalid_nickname') {
      return print('❌ 닉네임 형식이 올바르지 않습니다 (2~15자, 한글/영문/숫자/underscore/공백).');
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
      return print(`❌ 프로젝트 형식 오류 (이름 ≤40자, 설명 ≤80자, url 은 http(s), 최대 ${MAX_PROJECTS}개).`);
    }
    return print(`❌ 저장 실패 (status ${res.status}).`);
  } catch {
    return print(`❌ 서버에 연결하지 못했습니다: ${endpoint}`);
  }
}

function projectUsage() {
  return [
    '사용법:',
    `- \`/ocw project add <이름> :: <설명> :: <url>\` (설명·url 선택, 최대 ${MAX_PROJECTS}개)`,
    '- `/ocw project list`',
    '- `/ocw project main <번호|이름>` — 대표 프로젝트 지정(맨 위·MAIN 표시, `none`으로 해제)',
    '- `/ocw project link <이름>` — 현재 폴더의 프롬프트를 이 프로젝트로 집계 (`unlink`로 해제)',
    '- `/ocw project auto on|off` — 링크 안 된 폴더도 폴더 이름으로 자동 집계 (옵트인)',
    '- `/ocw project submarine <번호|이름>` — 🤿 잠수함 모드 토글 (남에겐 "secret #n"으로 표시)',
    '- `/ocw project remove <번호|이름>` (별칭: delete)',
    '- `/ocw project clear`',
    '예) `/ocw project add Open Code War :: Claude Code 리더보드 :: https://opencodewar.dev`',
  ].join('\n');
}

const MAX_PROJECT_LABEL = 40; // 서버 normalizeProjectLabel 과 동일 상한

/**
 * project link|unlink — 현재 폴더 ↔ 프로젝트 라벨 연결(DESIGN.md §20.2).
 * 매핑은 로컬 config(projectDirs)에만 저장되고, 이후 이 폴더(하위 포함)에서 친 프롬프트에
 * 라벨이 붙어 전송된다. 경로 자체는 서버로 가지 않는다.
 */
function projectLink(action, remainder, ships) {
  const cwd = normalizeDir(process.cwd());
  const dirs = { ...(cfg.projectDirs || {}) };

  if (action === 'unlink') {
    const key = Object.keys(dirs).find((d) => normalizeDir(d) === cwd);
    if (!key) return print(`이 폴더는 연결돼 있지 않습니다.\n${cwd}`);
    const label = dirs[key];
    delete dirs[key];
    cfg.projectDirs = dirs;
    saveConfig(cfg);
    return print(`✅ 연결 해제: ${label}\n${cwd}`);
  }

  const label = remainder.trim();
  if (!label) {
    // 인자 없이 → 현재 폴더의 연결 상태 + 사용법
    const cur = projectFor(cfg, cwd);
    return print(
      [
        cur ? `이 폴더는 **${cur}** 에 연결돼 있습니다.` : '이 폴더는 연결돼 있지 않습니다.',
        cwd,
        '',
        '사용법: `/ocw project link <이름>` — 이 폴더(하위 포함)의 프롬프트를 그 프로젝트로 집계',
        '해제: `/ocw project unlink`',
      ].join('\n'),
    );
  }
  if (label.length > MAX_PROJECT_LABEL) {
    return print(`❌ 이름이 너무 깁니다 (최대 ${MAX_PROJECT_LABEL}자).`);
  }

  dirs[cwd] = label;
  cfg.projectDirs = dirs;
  saveConfig(cfg);

  const isShip = ships.some((p) => p.name.toLowerCase() === label.toLowerCase());
  return print(
    [
      `✅ 연결: 이 폴더의 프롬프트를 **${label}** 로 집계합니다.`,
      cwd,
      isShip
        ? '상세 페이지 차트에 프로젝트 이름으로 표시됩니다.'
        : `ℹ️ shipping 목록에 없는 이름이라 차트에는 "기타"로 합산됩니다(본인이 봐도 동일).\n   이름으로 보이게 하려면 \`/ocw project add ${label}\` 로 등록하세요.`,
    ].join('\n'),
  );
}

/**
 * project auto on|off — 링크 안 된 폴더의 자동 집계(폴더 이름 라벨, DESIGN.md §20.7).
 * 로컬 config 만 바꾼다(서버 통신 없음). 인자 없으면 현재 상태 + 이 폴더의 자동 라벨을 보여준다.
 */
function projectAuto(remainder) {
  const v = remainder.trim().toLowerCase();
  if (v === 'on' || v === 'off') {
    cfg.projectAuto = v === 'on';
    saveConfig(cfg);
    if (v === 'on') {
      return print(
        [
          '● 디렉토리 자동 집계 ON — 링크 안 된 폴더는 **폴더 이름**으로 집계됩니다.',
          '  · 전체 경로는 전송되지 않습니다 (git 저장소면 루트 폴더 이름, 아니면 현재 폴더 이름)',
          '  · shipping 에 등록한 이름이 아니면 전부 "기타"로 합산됩니다 (본인이 봐도 동일)',
          '끄기: `/ocw project auto off`',
        ].join('\n'),
      );
    }
    return print('⏸ 디렉토리 자동 집계 OFF — 링크 안 된 폴더는 다시 미지정("기타")으로 집계됩니다.');
  }
  const label = autoProjectLabel(process.cwd());
  return print(
    [
      `디렉토리 자동 집계: ${cfg.projectAuto === true ? '켜짐' : '꺼짐(기본)'}`,
      cfg.projectAuto === true && label ? `이 폴더의 자동 라벨: **${label}**` : null,
      '사용법: `/ocw project auto on` | `/ocw project auto off`',
      '',
      '켜면 링크 안 된 폴더의 프롬프트도 폴더 이름(git 루트 기준)으로 집계됩니다.',
      '경로 전체는 서버로 가지 않으며, shipping 미등록 라벨은 차트에 "기타"로만 합산됩니다.',
    ]
      .filter((l) => l !== null)
      .join('\n'),
  );
}

/** project add|list|remove|clear — 홍보용 사이드프로젝트(최대 10개) 관리. */
async function project(input) {
  const sp = input.indexOf(' ');
  const action = (sp === -1 ? input : input.slice(0, sp)).toLowerCase() || 'list';
  const remainder = (sp === -1 ? '' : input.slice(sp + 1)).trim();

  // 자동 집계 토글은 로컬 설정만 만지므로 서버 조회 전에 처리한다.
  if (action === 'auto') {
    return projectAuto(remainder);
  }

  // 다른 항목 보존을 위해 서버의 현재 projects 를 기준값으로 삼는다(실패 시 로컬 캐시).
  const me = await fetchMe();
  const current = Array.isArray(me?.projects)
    ? me.projects
    : Array.isArray(cfg.projects)
      ? cfg.projects
      : [];

  if (action === 'link' || action === 'unlink') {
    return projectLink(action, remainder, current);
  }

  if (action === 'list') {
    if (!current.length) {
      return print('등록된 프로젝트가 없습니다.\n' + projectUsage());
    }
    const lines = ['**Shipping — 내 프로젝트**'];
    current.forEach((p, i) => {
      const parts = [`${i + 1}. ${p.name}${p.main ? ' ⭐ (메인)' : ''}${p.sub ? ' 🤿 (잠수함)' : ''}`];
      if (p.desc) parts.push(`— ${p.desc}`);
      if (p.url) parts.push(`(${p.url})`);
      lines.push(parts.join(' '));
    });
    lines.push(`\n${current.length}/${MAX_PROJECTS} 사용 중.`);
    if (!current.some((p) => p.main)) {
      lines.push('메인 지정: `/ocw project main <번호|이름>`');
    }
    // 폴더 연결(로컬 config) 현황 — 프롬프트가 어느 프로젝트로 집계되는지 (DESIGN.md §20)
    const dirs = cfg.projectDirs || {};
    const dirKeys = Object.keys(dirs);
    if (dirKeys.length) {
      lines.push('', '**연결된 폴더** (이 기기, 프롬프트 귀속)');
      dirKeys.forEach((d) => lines.push(`- ${dirs[d]} ← ${d}`));
    } else {
      lines.push('폴더 연결: 프로젝트 폴더에서 `/ocw project link <이름>` — 프롬프트가 그 프로젝트로 집계됩니다.');
    }
    lines.push(
      `디렉토리 자동 집계: ${cfg.projectAuto === true ? '켜짐' : '꺼짐'} (\`/ocw project auto on|off\`)`,
    );
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

  if (action === 'main' || action === 'primary') {
    if (!current.length) {
      return print('등록된 프로젝트가 없습니다.\n' + projectUsage());
    }
    // 기존 main 플래그를 걷어낸 사본을 만드는 헬퍼.
    const strip = (p) => {
      const { main, ...rest } = p;
      return rest;
    };
    // `none|off|clear|해제` → 메인 지정 해제.
    if (['none', 'off', 'clear', '해제'].includes(remainder.toLowerCase())) {
      if (!current.some((p) => p.main)) return print('지정된 메인 프로젝트가 없습니다.');
      return pushProjects(current.map(strip), '✅ 메인 지정을 해제했습니다.');
    }
    let idx = Number(remainder);
    if (!Number.isInteger(idx) || idx < 1 || idx > current.length) {
      // 번호가 아니면 이름으로 찾는다(대소문자 무시).
      const byName = current.findIndex((p) => p.name.toLowerCase() === remainder.toLowerCase());
      if (!remainder || byName === -1) {
        return print(`사용법: \`/ocw project main <번호|이름>\` — 번호는 1~${current.length}, 해제는 \`none\`. 목록은 \`/ocw project list\`.`);
      }
      idx = byName + 1;
    }
    const chosen = current[idx - 1];
    // 선택 항목을 메인으로 지정하고 맨 앞으로, 나머지는 메인 해제.
    const next = [
      { ...strip(chosen), main: true },
      ...current.filter((_, i) => i !== idx - 1).map(strip),
    ];
    return pushProjects(next, `✅ 메인 지정: ${chosen.name} (맨 위 · MAIN)`);
  }

  if (action === 'submarine' || action === 'sub') {
    if (!current.length) {
      return print('등록된 프로젝트가 없습니다.\n' + projectUsage());
    }
    let idx = Number(remainder);
    if (!Number.isInteger(idx) || idx < 1 || idx > current.length) {
      // 번호가 아니면 이름으로 찾는다(대소문자 무시).
      const byName = current.findIndex((p) => p.name.toLowerCase() === remainder.toLowerCase());
      if (!remainder || byName === -1) {
        return print(
          `사용법: \`/ocw project submarine <번호|이름>\` — 잠수함 모드 토글. 번호는 1~${current.length}, 목록은 \`/ocw project list\`.`,
        );
      }
      idx = byName + 1;
    }
    const chosen = current[idx - 1];
    const turningOn = chosen.sub !== true;
    const next = current.map((p, i) => {
      if (i !== idx - 1) return p;
      const { sub, ...restP } = p;
      return turningOn ? { ...restP, sub: true } : restP;
    });
    // 잠수함 순번(secret #n) = 목록 순서상 잠수함 중 몇 번째인지 — 서버 공개 표기와 동일 규칙.
    const secretNo = next.slice(0, idx).filter((p) => p.sub === true).length;
    return pushProjects(
      next,
      turningOn
        ? `🤿 **${chosen.name}** 잠수함 모드 ON — 내 페이지에서만 실명, 다른 사람에게는 **"secret #${secretNo}"** 로 보입니다.\n해제: \`/ocw project submarine ${chosen.name}\``
        : `✅ **${chosen.name}** 잠수함 모드 OFF — 다시 공개 프로젝트로 표시됩니다.`,
    );
  }

  if (action === 'remove' || action === 'delete' || action === 'rm') {
    if (!current.length) {
      return print('등록된 프로젝트가 없습니다.\n' + projectUsage());
    }
    let idx = Number(remainder);
    if (!Number.isInteger(idx) || idx < 1 || idx > current.length) {
      // 번호가 아니면 이름으로 찾는다(대소문자 무시).
      const byName = current.findIndex((p) => p.name.toLowerCase() === remainder.toLowerCase());
      if (!remainder || byName === -1) {
        return print(`사용법: \`/ocw project remove <번호|이름>\` — 번호는 1~${current.length}. 목록은 \`/ocw project list\`.`);
      }
      idx = byName + 1;
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

// ── 교전(§22) — 최대 10명 개인전 ──────────────────────────────
const BATTLE_MIN_HOURS = 24;
const BATTLE_MAX_HOURS = 168; // 서버 battle.ts 와 동일 상한

/** "3d"·"48h"·"72" → 시간 정수. 해석 불가면 null. */
function parseBattleDuration(tok) {
  const m = /^(\d+)\s*(h|d|시간|일)?$/i.exec((tok || '').trim());
  if (!m) return null;
  const n = Number(m[1]);
  const unit = (m[2] || 'h').toLowerCase();
  return unit === 'd' || unit === '일' ? n * 24 : n;
}

function fmtBattleRemain(endsAt, now) {
  const hoursLeft = Math.max(0, Math.ceil((endsAt - now) / 3_600_000));
  return hoursLeft <= 24 ? `${hoursLeft}시간 남음` : `D-${Math.ceil(hoursLeft / 24)}`;
}

function battleUsage() {
  return [
    '사용법:',
    '- `/ocw battle new <이름> <기간>` — 교전 생성 (기간 24h~7d, 예: `3d`, `48h`)',
    '- `/ocw battle join <코드>` — 참가 (최대 10명)',
    '- `/ocw battle status [코드]` — 순위판',
    '- `/ocw battle leave <코드>` — 나가기',
    '예) `/ocw battle new 주말결투 3d`',
  ].join('\n');
}

/** 교전 순위판 한 벌 출력(메타 + 순위 + 초대 안내). */
function printBattleBoard(d) {
  const label = d.name ? `${d.name} (${d.code})` : d.code;
  const head = d.ended
    ? `**⚔️ ${label} — 종료**`
    : `**⚔️ ${label} — ${fmtBattleRemain(d.endsAt, d.now)}** · ${d.members}/${d.maxMembers}명 · ${d.metric}`;
  const lines = [head];
  const medal = ['🥇', '🥈', '🥉'];
  d.standings.forEach((s) => {
    const mark = d.me && d.me.rank === s.rank ? ' ← 나' : '';
    const val = d.metric === 'chars' ? `${s.chars} 글자` : `${s.prompts} prompts`;
    lines.push(`${medal[s.rank - 1] || `${s.rank}.`} ${s.nickname}${s.owner ? ' 🏳(방장)' : ''} — ${val}${mark}`);
  });
  if (!d.ended) {
    lines.push('', `초대: \`/ocw battle join ${d.code}\` · ${endpoint}/b/${d.code}`);
  }
  return print(lines.join('\n'));
}

async function battle(input) {
  const sp = input.indexOf(' ');
  const action = (sp === -1 ? input : input.slice(0, sp)).toLowerCase() || 'status';
  const remainder = (sp === -1 ? '' : input.slice(sp + 1)).trim();

  const post = async (path, body) => {
    const res = await fetch(`${endpoint}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ userId: cfg.userId, ...body }),
      signal: AbortSignal.timeout(4000),
    });
    return { res, data: await res.json().catch(() => ({})) };
  };

  if (action === 'new' || action === 'create') {
    const tokens = remainder.split(/\s+/).filter(Boolean);
    const hours = parseBattleDuration(tokens[tokens.length - 1]);
    const name = tokens.slice(0, -1).join(' ');
    if (!tokens.length || hours === null) return print(battleUsage());
    if (hours < BATTLE_MIN_HOURS || hours > BATTLE_MAX_HOURS) {
      return print(`❌ 기간은 최소 24시간(24h) ~ 최대 7일(7d)입니다. 예: \`/ocw battle new ${name || '이름'} 3d\``);
    }
    try {
      const { res, data } = await post('/battle/new', { hours, name: name || undefined });
      if (!res.ok || !data.ok) {
        if (data.error === 'invalid_name') return print(`❌ 이름은 최대 ${data.max}자입니다.`);
        return print(`❌ 생성 실패: ${data.error || `HTTP ${res.status}`}`);
      }
      return print(
        [
          `⚔️ **교전 개시! ${data.name ? `${data.name} ` : ''}(${data.code})** — ${Math.round(hours / 24) >= 1 && hours % 24 === 0 ? `${hours / 24}일` : `${hours}시간`}`,
          '지금부터 치는 프롬프트가 전부 집계됩니다.',
          '',
          `친구 초대 (최대 10명):`,
          `- \`/ocw battle join ${data.code}\``,
          `- ${endpoint}/b/${data.code}`,
        ].join('\n'),
      );
    } catch {
      return print(`❌ 서버에 연결하지 못했습니다: ${endpoint}`);
    }
  }

  if (action === 'join') {
    const code = remainder.toLowerCase();
    if (!code) return print('사용법: `/ocw battle join <코드>`');
    try {
      const { res, data } = await post('/battle/join', { code });
      if (!res.ok || !data.ok) {
        if (data.error === 'battle_not_found') return print(`❌ 코드 ${code} 교전을 찾을 수 없습니다.`);
        if (data.error === 'battle_ended') return print('❌ 이미 종료된 교전입니다.');
        if (data.error === 'battle_full') return print(`❌ 정원(${data.max}명)이 찼습니다.`);
        return print(`❌ 참가 실패: ${data.error || `HTTP ${res.status}`}`);
      }
      const label = data.name ? `${data.name} (${data.code})` : data.code;
      return print(
        [
          data.already ? `이미 참전 중입니다 — ⚔️ ${label}` : `⚔️ **참전 완료 — ${label}**`,
          `종료까지 ${fmtBattleRemain(data.endsAt, Date.now())}. 교전 시작 이후 친 프롬프트는 소급 집계됩니다.`,
          `순위판: \`/ocw battle status ${data.code}\` · ${endpoint}/b/${data.code}`,
        ].join('\n'),
      );
    } catch {
      return print(`❌ 서버에 연결하지 못했습니다: ${endpoint}`);
    }
  }

  if (action === 'leave') {
    const code = remainder.toLowerCase();
    if (!code) return print('사용법: `/ocw battle leave <코드>`');
    try {
      const { res, data } = await post('/battle/leave', { code });
      if (!res.ok || !data.ok) return print(`❌ 실패: ${data.error || `HTTP ${res.status}`}`);
      return print(`✅ 교전 ${code} 에서 나왔습니다.`);
    } catch {
      return print(`❌ 서버에 연결하지 못했습니다: ${endpoint}`);
    }
  }

  if (action === 'status' || action === 'list') {
    try {
      let codes = [];
      if (remainder) {
        codes = [remainder.toLowerCase()];
      } else {
        const res = await fetch(`${endpoint}/battle/mine?userId=${encodeURIComponent(cfg.userId)}`, {
          signal: AbortSignal.timeout(4000),
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) return print(`❌ 조회 실패: ${data.error || `HTTP ${res.status}`}`);
        codes = (data.battles || []).map((b) => b.code);
        if (!codes.length) {
          return print('참가 중인 교전이 없습니다.\n' + battleUsage());
        }
      }
      for (const code of codes) {
        const res = await fetch(
          `${endpoint}/battle?code=${encodeURIComponent(code)}&userId=${encodeURIComponent(cfg.userId)}`,
          { signal: AbortSignal.timeout(4000) },
        );
        const d = await res.json().catch(() => ({}));
        if (!res.ok) {
          print(`❌ ${code}: ${d.error || `HTTP ${res.status}`}`);
          continue;
        }
        printBattleBoard(d);
      }
      return;
    } catch {
      return print(`❌ 서버에 연결하지 못했습니다: ${endpoint}`);
    }
  }

  return print(battleUsage());
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
  const city = pick('city', null);

  const lines = ['**Open Code War — 내 정보**', `- 닉네임: ${nickname}`];

  // Google 연동 상태. 서버(/me) 우선, 실패 시 로컬 캐시.
  const account = (me && me.account) || cfg.account || null;
  lines.push(
    account && account.email
      ? `- 계정: ${account.email} (Google 연동 · 이메일 ${account.emailPublic ? '공개' : '비공개'})`
      : '- 계정: 미연동 — `/ocw signup` (계정 복구·기기 합산)',
  );

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

  // 구역: 국가(IP 자동) + 도시(자기선언). 국가/국기는 서버(/me)에서만 온다.
  const zones = (me && me.zones) || {};
  const flag = (zones.country && zones.country.flag) || '';
  const country = (me && me.country) || null;
  const zoneChip = [];
  if (country) zoneChip.push(`${flag} ${country}`.trim());
  zoneChip.push(city ? city : '(도시 미설정) — `/ocw city <도시>`');
  lines.push(`- 구역: ${zoneChip.join(' · ')}`);

  if (me) {
    lines.push(`- 오늘(일간): ${me.prompts} 프롬프트 · ${me.chars} 글자`);

    // 구역별 순위: 🌍 글로벌 · 🇰🇷 국가 · 도시. rank 없으면 '-'.
    const fmt = (z) => (z && z.rank != null ? `${z.rank}/${z.total}` : `-/${(z && z.total) || 0}`);
    const rankParts = [`🌍 ${fmt(zones.global)}`];
    if (zones.country) rankParts.push(`${zones.country.flag} ${fmt(zones.country)}`);
    if (zones.city) rankParts.push(`${zones.city.label} ${fmt(zones.city)}`);
    lines.push(`- 순위(일간): ${rankParts.join(' · ')}`);
  }

  // 세션 시작 시 터미널에 뜨는 한 줄 브리핑(DESIGN.md §19). 꺼져 있으면 켜는 법을 같이 알린다.
  lines.push(
    cfg.brief === false ? '- 세션 브리핑: 꺼짐 — `/ocw brief on`' : '- 세션 브리핑: 켜짐 (`/ocw brief off` 로 끄기)',
  );

  // 내 프로필 페이지 링크. 닉네임 미등록이면 페이지가 없으므로 생략.
  const nickForUrl = (me && me.nickname) || cfg.nickname || null;
  if (nickForUrl) {
    lines.push(`- 내 페이지: ${endpoint}/u/${encodeURIComponent(nickForUrl)}`);
  }

  lines.push('\n전체 명령 보기 → `/ocw help`');
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
      '- `/ocw city <도시>` — 내 도시 (도시 구역 랭킹 "이 구역 코드워리어")',
      '- `/ocw link <종류> <url>` — 링크 (종류: website/blog/github/x/linkedin · website·blog는 주소 표시, SNS는 아이콘)',
      '- `/ocw project add <이름> :: <설명> :: <url>` — 사이드프로젝트 (최대 10개)',
      '- `/ocw project main <번호|이름>` — 대표 프로젝트 지정 (맨 위·MAIN)',
      '- `/ocw project link <이름>` / `unlink` — 현재 폴더의 프롬프트를 프로젝트로 집계 (상세 차트 표시)',
      '- `/ocw project auto on|off` — 링크 안 된 폴더도 폴더 이름으로 자동 집계 (옵트인)',
      '- `/ocw project submarine <번호|이름>` — 🤿 잠수함 모드 (남에겐 "secret #n", 본인만 실명)',
      '- `/ocw project list | remove|delete <번호|이름> | clear` — 프로젝트 관리',
      '- `/ocw battle new <이름> <기간>` — ⚔️ 교전 생성 (최대 10명 개인전, 24h~7d)',
      '- `/ocw battle join <코드>` / `status` / `leave` — 교전 참가·순위판·나가기',
      '- `/ocw signup` — Google 계정 연동 (계정 복구·여러 기기 합산 · 별칭: login)',
      '- `/ocw email public|private` — 연동 이메일 프로필 공개/비공개 (기본 비공개)',
      '- `/ocw status` — 내 정보 및 오늘 순위',
      '- `/ocw random` — 등록 유저 중 무작위 한 명 구경하기',
      '- `/ocw brief on|off` — 세션 시작 브리핑(순위·계급·스트릭 한 줄) 켜기/끄기',
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
  // signup 후 브라우저 완료분이 있으면 어떤 명령이든 실행 시점에 먼저 반영한다.
  const linkNotice = await resolvePendingLink();
  if (linkNotice) print(linkNotice + '\n');

  switch (sub) {
    case 'signup':
    case 'login':
      return signup();
    case 'email':
      return emailVisibility(rest);
    case 'random':
      return randomUser();
    case 'nickname':
      return registerNickname(rest);
    case 'bio':
    case 'role':
    case 'company':
    case 'city':
      return setText(sub, rest);
    case 'link':
      return setLink(rest);
    case 'project':
    case 'projects':
      return project(rest);
    case 'battle':
      return battle(rest);
    case 'delete':
      return deleteData(rest);
    case 'brief': {
      const v = (rest || '').trim().toLowerCase();
      if (v === 'on' || v === 'off') {
        cfg.brief = v === 'on';
        saveConfig(cfg);
        return print(
          v === 'on'
            ? '● 세션 브리핑을 켰습니다. 다음 세션부터 순위·계급·스트릭이 한 줄로 표시됩니다.'
            : '⏸ 세션 브리핑을 껐습니다. 다시 켜려면 `/ocw brief on`.',
        );
      }
      return print(
        [
          `세션 브리핑: ${cfg.brief === false ? '꺼짐' : '켜짐'}`,
          '사용법: `/ocw brief on` | `/ocw brief off`',
          '',
          '세션을 시작할 때 순위·계급·스트릭 중 지금 알릴 만한 것 하나를 한 줄로 보여줍니다.',
          '알릴 변화가 없으면 아무것도 표시하지 않습니다.',
        ].join('\n'),
      );
    }
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

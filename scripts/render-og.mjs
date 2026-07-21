#!/usr/bin/env node
// 유저 OG 이미지 렌더러. web/og-user.html 템플릿에 실데이터를 주입해 1200×630 PNG 를 굽는다.
// 요청 경로 밖(로컬·GitHub Actions)에서 돌리는 것이 목적 — Cloudflare 무료 티어 CPU(10ms)로는
// 런타임 PNG 생성이 불가능하기 때문. (DESIGN 참고)
//
//   node scripts/render-og.mjs <nickname|public_id> [--api https://opencodewar.dev] [--out out.png]
//
// 식별자는 등록 닉네임 또는 공개 slug(public_id, 'u-'+10자)를 받는다 — slug 는 익명 유저용.
// Chrome 은 CHROME_BIN → 로컬 macOS 경로 순으로 찾는다(Actions 는 setup-chrome 가 CHROME_BIN 설정).

import { existsSync, readFileSync, writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const HERE = dirname(fileURLToPath(import.meta.url));
const TEMPLATE = join(HERE, '..', 'web', 'og-user.html');

function arg(flag, def) {
  const i = process.argv.indexOf(flag);
  return i !== -1 ? process.argv[i + 1] : def;
}

const seg = process.argv[2];
if (!seg || seg.startsWith('--')) {
  console.error('usage: node scripts/render-og.mjs <nickname|public_id> [--api URL] [--out file.png]');
  process.exit(1);
}
// public_id(slug)는 'u-'+10자[0-9a-z] — 닉네임엔 하이픈이 없어 구조로 구분된다.
const isPid = /^u-[0-9a-z]{10}$/.test(seg);
const API = (arg('--api', process.env.OCW_API_URL || 'https://opencodewar.dev')).replace(/\/+$/, '');
const OUT = arg('--out', join(process.cwd(), `og-${seg}.png`));

function findChrome() {
  if (process.env.CHROME_BIN && existsSync(process.env.CHROME_BIN)) return process.env.CHROME_BIN;
  const candidates = [
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium-browser',
    '/usr/bin/chromium',
  ];
  return candidates.find((p) => existsSync(p));
}

async function fetchJson(url) {
  const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
  if (!res.ok) throw new Error(`${url} → HTTP ${res.status}`);
  return res.json();
}

// KST(UTC+9) 'YYYY-MM-DD' 스탬프
function kstStamp() {
  const d = new Date(Date.now() + 9 * 3600 * 1000);
  return `${d.toISOString().slice(0, 10)} · KST`;
}

async function buildData() {
  const query = isPid ? `id=${encodeURIComponent(seg)}` : `nickname=${encodeURIComponent(seg)}`;
  const profile = await fetchJson(`${API}/user?${query}`);
  const days = profile.days || [];
  const last = days[days.length - 1] || { prompts: 0, chars: 0 };
  const totals = profile.totals || { prompts: 0, chars: 0 };
  const nick = profile.nickname || seg; // 익명 유저는 응답의 자동 닉네임을 표시명으로

  // 오늘 순위: daily 리더보드에서 조회(식별자 매칭). 실패해도 이미지는 만든다.
  let rank = 0;
  let total = 0;
  try {
    const lb = await fetchJson(`${API}/leaderboard?type=daily&metric=prompts&limit=100`);
    total = lb.count || (lb.ranking || []).length;
    const row = (lb.ranking || []).find((r) => (isPid ? r.public_id === seg : r.nickname === seg));
    if (row) rank = row.rank;
  } catch {
    // 순위 조회 실패는 무시
  }

  return {
    nick,
    rank,
    total,
    country: profile.country || '',
    flag: profile.flag || '',
    city: profile.city || '',
    today: { prompts: last.prompts || 0, chars: last.chars || 0 },
    d30: { prompts: totals.prompts || 0, chars: totals.chars || 0 },
    series: days.map((d) => d.prompts || 0),
    stamp: kstStamp(),
  };
}

const chrome = findChrome();
if (!chrome) {
  console.error('Chrome 을 찾을 수 없습니다. CHROME_BIN 을 설정하세요.');
  process.exit(1);
}

const data = await buildData();

// 템플릿의 /*OCW_DATA*/...​/*END*/ 마커를 실제 JSON 으로 치환(쿼리 인코딩 문제 회피)
const template = readFileSync(TEMPLATE, 'utf8');
const injected = template.replace(
  /\/\*OCW_DATA\*\/[\s\S]*?\/\*END\*\//,
  `/*OCW_DATA*/${JSON.stringify(data)}/*END*/`,
);

const dir = mkdtempSync(join(tmpdir(), 'ocw-og-'));
const htmlPath = join(dir, 'og.html');
writeFileSync(htmlPath, injected);

execFileSync(
  chrome,
  [
    '--headless',
    '--disable-gpu',
    '--hide-scrollbars',
    '--force-color-profile=srgb',
    '--window-size=1200,630',
    `--screenshot=${OUT}`,
    `file://${htmlPath}`,
  ],
  { stdio: 'ignore' },
);

console.log(`rendered: ${OUT}`);
console.log(`  ${data.nick} · today ${data.today.prompts}p/${data.today.chars}c · #${data.rank}/${data.total} · 30d ${data.d30.prompts}p`);

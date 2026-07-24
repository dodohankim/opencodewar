#!/usr/bin/env node
// 유저 OG 이미지 CLI 렌더러(로컬 수동용). web/og-user.html 템플릿에 실데이터를 주입해 1200×630 PNG 를 굽는다.
// 데이터·주입 로직은 og-lib.mjs 를 공유한다(VPS 온디맨드 서버와 동일 소스).
//
//   node scripts/render-og.mjs <nickname|public_id> [--api https://opencodewar.dev] [--out out.png]
//
// Chrome 은 CHROME_BIN → 로컬 macOS 경로 순으로 찾는다.

import { existsSync, readFileSync, writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { buildData, injectTemplate } from './og-lib.mjs';

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
const API = arg('--api', process.env.OCW_API_URL || 'https://opencodewar.dev');
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

const chrome = findChrome();
if (!chrome) {
  console.error('Chrome 을 찾을 수 없습니다. CHROME_BIN 을 설정하세요.');
  process.exit(1);
}

const data = await buildData(API, seg);
const injected = injectTemplate(readFileSync(TEMPLATE, 'utf8'), data);

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
console.log(
  `  ${data.nick} · ${data.heroChars}c/${data.heroPrompts}p ${data.heroIsToday ? 'today' : data.heroDayLabel} · 🔥${data.streak}${data.streakLongest > data.streak ? '/best' + data.streakLongest : ''}${data.since ? ' since ' + data.since : ''}`,
);

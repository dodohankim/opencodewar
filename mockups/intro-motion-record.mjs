import { chromium } from 'playwright';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';

const here = path.dirname(new URL(import.meta.url).pathname);
const html = path.join(here, 'intro-motion.html');
const vdir = path.join(here, 'video');
fs.mkdirSync(vdir, { recursive: true });

const browser = await chromium.launch({ channel: 'chrome' });
const ctx = await browser.newContext({
  viewport: { width: 1280, height: 720 }, deviceScaleFactor: 1,
  recordVideo: { dir: vdir, size: { width: 1280, height: 720 } },
});
const t0 = Date.now();
const page = await ctx.newPage();
await page.goto('file://' + html + '?record=1');
await page.waitForFunction(() => window.__started, null, { timeout: 30000 });
const offset = Math.max(0, (Date.now() - t0) / 1000 - 0.4);   // 재생 시작 0.4초 전부터(검은 리드인)
await page.waitForFunction(() => window.__done, null, { timeout: 120000 });
await page.waitForTimeout(1800);                    // 타이틀 카드 여운
const video = page.video();
await ctx.close();
const webm = await video.path();
await browser.close();

const out = path.join(here, 'intro-motion.mp4');
execFileSync('ffmpeg', ['-y', '-ss', offset.toFixed(2), '-i', webm, '-r', '30', '-c:v', 'libx264', '-pix_fmt', 'yuv420p',
  '-crf', '19', '-preset', 'slow', '-movflags', '+faststart', '-an', out], { stdio: 'inherit' });
console.log('OUT', out, 'offset', offset.toFixed(2));

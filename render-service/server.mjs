// Open Code War — 온디맨드 OG 렌더 서비스 (VPS/Coolify).
// Cloudflare 워커는 무료 CPU 10ms 로 PNG 를 못 만든다 → 이 서비스가 요청 시점에 렌더한다.
// Worker(og.ts)가 KV 미스일 때만 여기 /og/<public_id>.png 를 호출하고, 결과를 KV(TTL)에 캐시한다.
//
// 보호: X-OCW-Render-Key 헤더가 RENDER_KEY 와 일치해야 렌더한다(공개 남용 방지).
// 데이터·템플릿 로직은 og-lib.mjs(레포 공용)를 그대로 쓴다.

import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import puppeteer from 'puppeteer-core';
import { buildData, injectTemplate, PUBLIC_ID_RE } from './og-lib.mjs';

const PORT = Number(process.env.PORT) || 3000;
const API = process.env.OCW_API || 'https://opencodewar.dev';
const RENDER_KEY = process.env.RENDER_KEY || '';
const CHROME = process.env.PUPPETEER_EXECUTABLE_PATH || '/usr/bin/chromium';
const TEMPLATE = readFileSync(new URL('./og-user.html', import.meta.url), 'utf8');

// 브라우저를 한 번 띄워 재사용한다(요청마다 새 페이지만) — 콜드스타트/메모리 절약.
let browserPromise = null;
async function getBrowser() {
  if (browserPromise) {
    const b = await browserPromise;
    if (b.connected) return b;
  }
  browserPromise = puppeteer.launch({
    executablePath: CHROME,
    headless: true,
    args: ['--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage'],
  });
  return browserPromise;
}

async function renderPng(publicId) {
  const data = await buildData(API, publicId);
  const html = injectTemplate(TEMPLATE, data);
  const browser = await getBrowser();
  const page = await browser.newPage();
  try {
    await page.setViewport({ width: 1200, height: 630, deviceScaleFactor: 1 });
    // 템플릿은 외부 리소스가 없고 데이터 주입 스크립트도 동기라 load 로 충분하다.
    await page.setContent(html, { waitUntil: 'load' });
    return await page.screenshot({ type: 'png', clip: { x: 0, y: 0, width: 1200, height: 630 } });
  } finally {
    await page.close().catch(() => {});
  }
}

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://localhost');

    if (url.pathname === '/health') {
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      return res.end('ok');
    }

    const m = url.pathname.match(/^\/og\/(u-[0-9a-z]{10})\.png$/);
    if (m && req.method === 'GET') {
      if (RENDER_KEY && req.headers['x-ocw-render-key'] !== RENDER_KEY) {
        res.writeHead(403, { 'Content-Type': 'text/plain' });
        return res.end('forbidden');
      }
      const png = await renderPng(m[1]);
      res.writeHead(200, { 'Content-Type': 'image/png', 'Cache-Control': 'no-store' });
      return res.end(png);
    }

    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('not found');
  } catch (err) {
    console.error('render error:', err?.message || err);
    res.writeHead(500, { 'Content-Type': 'text/plain' });
    res.end('render failed');
  }
});

server.listen(PORT, () => console.log(`ocw render service listening on :${PORT} (api=${API})`));

// 종료 시 브라우저 정리
for (const sig of ['SIGTERM', 'SIGINT']) {
  process.on(sig, async () => {
    try {
      if (browserPromise) (await browserPromise).close();
    } catch {}
    process.exit(0);
  });
}

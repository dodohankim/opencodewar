#!/usr/bin/env node
// Cloudflare Workers Paid 플랜 사용량 체크(Workers·KV·D1). GraphQL Analytics + REST 로 이번 결제 주기
// (매달 BILLING_DAY일 00:00 UTC부터) 누적 사용량을 집계해 월 포함량 대비 게이지, 월말 예상, 예상 초과 요금을 보여준다.
//
//   node scripts/cf-usage.mjs [--json]
//
// 크레덴셜: 리포 루트 .env 의 CLOUDFLARE_API_TOKEN (Account Analytics Read + D1/KV Read 권한).
// 계정 ID 는 CLOUDFLARE_ACCOUNT_ID 가 없으면 /accounts API 로 자동 해석한다.
// 결제일은 CF_BILLING_DAY(기본 18 — 2026-11 Workers Paid 가입, 결제일 18일).
//
// 포함량·단가 출처: developers.cloudflare.com (workers/platform/pricing, kv/platform/pricing, d1/platform/pricing)
// 수치가 바뀌면 아래 PLAN 만 고치면 된다. (기준: 2026-11 문서) usage-report/src/index.ts 와 같은 값.

import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const API = 'https://api.cloudflare.com/client/v4';
const JSON_MODE = process.argv.includes('--json');

// price 는 unit 단위당 달러. 스토리지는 GB-월 단가라 "지금 크기가 한 달 내내 유지된다"고 보고 계산한다.
const GB = 1024 ** 3;
const PLAN = {
  base: 5,
  workersRequests: { included: 10_000_000, price: 0.3, unit: 1e6 },
  workersCpuMs: { included: 30_000_000, price: 0.02, unit: 1e6 },
  kvReads: { included: 10_000_000, price: 0.5, unit: 1e6 },
  kvWrites: { included: 1_000_000, price: 5, unit: 1e6 },
  kvDeletes: { included: 1_000_000, price: 5, unit: 1e6 },
  kvLists: { included: 1_000_000, price: 5, unit: 1e6 },
  kvStorage: { included: 1 * GB, price: 0.5, unit: GB },
  d1RowsRead: { included: 25_000_000_000, price: 0.001, unit: 1e6 },
  d1RowsWritten: { included: 50_000_000, price: 1, unit: 1e6 },
  d1Storage: { included: 5 * GB, price: 0.75, unit: GB },
};
const D1_PER_DB_BYTES = 10 * GB; // 유료 플랜 DB 1개당 10 GB

// ---- .env 로딩(기존 환경변수 우선) ----
const envPath = join(HERE, '..', '.env');
if (existsSync(envPath)) {
  for (const line of readFileSync(envPath, 'utf8').split('\n')) {
    const m = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (m && !(m[1] in process.env)) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
}
const TOKEN = process.env.CLOUDFLARE_API_TOKEN;
if (!TOKEN) {
  console.error('CLOUDFLARE_API_TOKEN 이 없습니다 (.env 또는 환경변수).');
  process.exit(1);
}
const BILLING_DAY = Number(process.env.CF_BILLING_DAY) || 18;

async function cf(path) {
  const res = await fetch(`${API}${path}`, { headers: { Authorization: `Bearer ${TOKEN}` } });
  const body = await res.json();
  if (!body.success) throw new Error(`${path} 실패: ${JSON.stringify(body.errors)}`);
  return body.result;
}

async function gql(query) {
  const res = await fetch(`${API}/graphql`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query }),
  });
  const body = await res.json();
  if (body.errors?.length) throw new Error(`GraphQL 실패: ${JSON.stringify(body.errors)}`);
  return body.data.viewer.accounts[0];
}

// 이번 결제 주기: 가장 최근의 BILLING_DAY 00:00 UTC ~ 다음 달 같은 날(그 달에 없는 날이면 말일).
function billingPeriod(now, billingDay) {
  const at = (y, m) => {
    const last = new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
    return new Date(Date.UTC(y, m, Math.min(billingDay, last)));
  };
  const y = now.getUTCFullYear();
  let m = now.getUTCMonth();
  let start = at(y, m);
  if (start > now) start = at(y, --m);
  const end = at(y, m + 1);
  return {
    start,
    end,
    totalDays: (end - start) / 864e5,
    elapsedDays: (now - start) / 864e5,
  };
}

// ---- 수집 ----
const accountId = process.env.CLOUDFLARE_ACCOUNT_ID || (await cf('/accounts'))[0].id;

const now = new Date();
const today = now.toISOString().slice(0, 10);
const yesterday = new Date(now.getTime() - 864e5).toISOString().slice(0, 10);
const period = billingPeriod(now, BILLING_DAY);
const periodStart = period.start.toISOString().slice(0, 10);
const scale = period.totalDays / Math.max(1, period.elapsedDays); // 월말 예상 배율(첫날은 하루로 본다)

const acct = await gql(`{
  viewer { accounts(filter: { accountTag: "${accountId}" }) {
    workers: workersInvocationsAdaptive(filter: { datetime_geq: "${periodStart}T00:00:00Z" }, limit: 1000) {
      sum { requests errors cpuTimeUs }
      dimensions { scriptName }
    }
    workersToday: workersInvocationsAdaptive(filter: { datetime_geq: "${today}T00:00:00Z" }, limit: 1000) {
      sum { requests }
      dimensions { scriptName }
    }
    kvOps: kvOperationsAdaptiveGroups(filter: { date_geq: "${periodStart}" }, limit: 1000) {
      sum { requests }
      dimensions { actionType }
    }
    kvStorage: kvStorageAdaptiveGroups(filter: { date_geq: "${yesterday}" }, limit: 100, orderBy: [date_DESC]) {
      max { byteCount keyCount }
      dimensions { date namespaceId }
    }
    d1: d1AnalyticsAdaptiveGroups(filter: { date_geq: "${periodStart}" }, limit: 1000) {
      sum { rowsRead rowsWritten readQueries writeQueries }
      dimensions { databaseId }
    }
  } }
}`);

const sumOf = (rows, key) => rows.reduce((a, r) => a + (r.sum[key] ?? 0), 0);
const workersTotal = sumOf(acct.workers, 'requests');
const cpuMsTotal = sumOf(acct.workers, 'cpuTimeUs') / 1000;
const todayByScript = new Map(acct.workersToday.map((w) => [w.dimensions.scriptName, w.sum.requests]));
const workersByScript = acct.workers
  .map((w) => ({
    name: w.dimensions.scriptName,
    requests: w.sum.requests,
    today: todayByScript.get(w.dimensions.scriptName) ?? 0,
    errors: w.sum.errors,
    cpuMs: Math.round(w.sum.cpuTimeUs / 1000),
  }))
  .sort((a, b) => b.requests - a.requests);

const kvOps = {};
for (const o of acct.kvOps) kvOps[o.dimensions.actionType] = (kvOps[o.dimensions.actionType] ?? 0) + o.sum.requests;

// 네임스페이스별 최신 날짜의 byteCount 만 취해 합산(오늘 행이 아직 없으면 어제 행 사용)
const kvNsBytes = new Map();
for (const row of acct.kvStorage) {
  const id = row.dimensions.namespaceId.replace(/-/g, '');
  if (!kvNsBytes.has(id)) kvNsBytes.set(id, { bytes: row.max.byteCount, keys: row.max.keyCount });
}
const kvStorageTotal = [...kvNsBytes.values()].reduce((a, v) => a + v.bytes, 0);

// 네임스페이스 이름 매핑(권한 없으면 ID 로 표기)
let nsTitles = {};
try {
  const list = await cf(`/accounts/${accountId}/storage/kv/namespaces?per_page=100`);
  nsTitles = Object.fromEntries(list.map((n) => [n.id, n.title]));
} catch { /* 이름 없이 진행 */ }

// D1 스토리지: DB 목록 → 개별 상세의 file_size 합산
let d1Dbs = [];
try {
  const list = await cf(`/accounts/${accountId}/d1/database?per_page=100`);
  d1Dbs = await Promise.all(
    list.map(async (db) => {
      const detail = await cf(`/accounts/${accountId}/d1/database/${db.uuid}`);
      return { name: db.name, bytes: detail.file_size ?? 0 };
    }),
  );
} catch { /* D1 read 권한 없으면 스킵 */ }
const d1StorageTotal = d1Dbs.reduce((a, d) => a + d.bytes, 0);

// ---- 요약(JSON 겸용) ----
// 누적 항목은 월말 예상 = 지금까지 × 배율, 스토리지는 지금 크기 그대로.
const metric = (used, rate, cumulative = true) => {
  const projected = cumulative ? used * scale : used;
  return {
    used,
    included: rate.included,
    pct: +((used / rate.included) * 100).toFixed(2),
    projected: Math.round(projected),
    projectedPct: +((projected / rate.included) * 100).toFixed(2),
    overageUsd: +((Math.max(0, projected - rate.included) / rate.unit) * rate.price).toFixed(2),
  };
};

const summary = {
  date: today,
  accountId,
  period: {
    start: periodStart,
    end: period.end.toISOString().slice(0, 10),
    totalDays: period.totalDays,
    elapsedDays: +period.elapsedDays.toFixed(2),
  },
  workers: {
    requests: metric(workersTotal, PLAN.workersRequests),
    cpuMs: metric(Math.round(cpuMsTotal), PLAN.workersCpuMs),
    byScript: workersByScript,
  },
  kv: {
    reads: metric(kvOps.read ?? 0, PLAN.kvReads),
    writes: metric(kvOps.write ?? 0, PLAN.kvWrites),
    deletes: metric(kvOps.delete ?? 0, PLAN.kvDeletes),
    lists: metric(kvOps.list ?? 0, PLAN.kvLists),
    storage: metric(kvStorageTotal, PLAN.kvStorage, false),
    namespaces: [...kvNsBytes.entries()].map(([id, v]) => ({ id, title: nsTitles[id] ?? id, ...v })),
  },
  d1: {
    rowsRead: metric(sumOf(acct.d1, 'rowsRead'), PLAN.d1RowsRead),
    rowsWritten: metric(sumOf(acct.d1, 'rowsWritten'), PLAN.d1RowsWritten),
    storage: metric(d1StorageTotal, PLAN.d1Storage, false),
    databases: d1Dbs.map((d) => ({ ...d, pctOfDbCap: +((d.bytes / D1_PER_DB_BYTES) * 100).toFixed(2) })),
  },
};
const allMetrics = [
  ['Workers requests', summary.workers.requests],
  ['Workers CPU ms', summary.workers.cpuMs],
  ['KV reads', summary.kv.reads],
  ['KV writes', summary.kv.writes],
  ['KV deletes', summary.kv.deletes],
  ['KV lists', summary.kv.lists],
  ['KV storage', summary.kv.storage],
  ['D1 rows read', summary.d1.rowsRead],
  ['D1 rows written', summary.d1.rowsWritten],
  ['D1 storage', summary.d1.storage],
];
const overageUsd = +allMetrics.reduce((a, [, m]) => a + m.overageUsd, 0).toFixed(2);
summary.estimate = { baseUsd: PLAN.base, overageUsd, totalUsd: +(PLAN.base + overageUsd).toFixed(2) };

if (JSON_MODE) {
  console.log(JSON.stringify(summary, null, 2));
  process.exit(0);
}

// ---- 터미널 렌더링 ----
const tty = process.stdout.isTTY;
const paint = (code, s) => (tty ? `\x1b[${code}m${s}\x1b[0m` : s);
const num = (n) => n.toLocaleString('en-US');
const mb = (b) => (b >= GB ? `${(b / GB).toFixed(2)} GB` : `${(b / 1024 ** 2).toFixed(2)} MB`);
const colorOf = (pct) => (pct >= 90 ? 31 : pct >= 70 ? 33 : 32); // red / yellow / green

const BAR_W = 22;
function gauge(pct) {
  // 1/8 블록으로 부드러운 게이지. 채워진 부분만 상태색, 나머지는 회색.
  const cells = Math.max(0, Math.min(BAR_W, (pct / 100) * BAR_W));
  const full = Math.floor(cells);
  const frac = Math.round((cells - full) * 8);
  const partial = full < BAR_W && frac > 0 ? '▏▎▍▌▋▊▉█'[frac - 1] : '';
  const rest = BAR_W - full - (partial ? 1 : 0);
  return paint(colorOf(pct), '█'.repeat(full) + partial) + paint(90, '░'.repeat(rest));
}

function row(label, m, fmt = num) {
  const pctStr = paint(1, paint(colorOf(m.pct), `${m.pct.toFixed(1).padStart(5)}%`));
  const proj = paint(colorOf(m.projectedPct), `월말 ${m.projectedPct.toFixed(1)}%`);
  console.log(
    `  ${label.padEnd(12)} ${pctStr}  ${gauge(m.pct)}  ${paint(90, `${fmt(m.used)} / ${fmt(m.included)}`)}  ${proj}`,
  );
}
const section = (title) =>
  console.log('\n' + paint(1, ` ${title} `) + paint(90, '─'.repeat(Math.max(0, 54 - title.length))));
const sub = (s) => console.log(paint(90, `    · ${s}`));

const day = Math.min(Math.floor(period.elapsedDays) + 1, period.totalDays);
console.log(
  '\n' + paint(1, ' Cloudflare Workers Paid 사용량') +
  paint(90, `  주기 ${summary.period.start} ~ ${summary.period.end} UTC · ${day}/${period.totalDays}일째 · 계정 ${accountId.slice(0, 6)}…`),
);

section('Workers (계정 전체 합산)');
row('requests', summary.workers.requests);
row('CPU ms', summary.workers.cpuMs);
for (const s of workersByScript) {
  const err = s.errors ? paint(31, `  errors ${num(s.errors)}`) : '';
  sub(`${s.name.padEnd(24)} ${num(s.requests).padStart(9)}  오늘 ${num(s.today).padStart(7)}  CPU ${num(s.cpuMs)}ms${err}`);
}

section('KV');
row('reads', summary.kv.reads);
row('writes', summary.kv.writes);
row('deletes', summary.kv.deletes);
row('lists', summary.kv.lists);
row('storage', summary.kv.storage, mb);
for (const ns of summary.kv.namespaces) {
  sub(`${ns.title.padEnd(24)} ${mb(ns.bytes).padStart(10)}  keys ${num(ns.keys)}`);
}

section('D1');
row('rows read', summary.d1.rowsRead);
row('rows written', summary.d1.rowsWritten);
if (d1Dbs.length) {
  row('storage', summary.d1.storage, mb);
  for (const db of summary.d1.databases) {
    sub(`${db.name.padEnd(24)} ${mb(db.bytes).padStart(10)}  (DB당 10GB 의 ${db.pctOfDbCap.toFixed(1)}%)`);
  }
}

// 요약 + 경고
const overNow = allMetrics.filter(([, m]) => m.pct >= 100);
const overSoon = allMetrics.filter(([, m]) => m.pct < 100 && m.projectedPct >= 80);
const [topName, top] = [...allMetrics].sort((a, b) => b[1].projectedPct - a[1].projectedPct)[0];

console.log();
if (overNow.length) {
  console.log(paint(31, ` 🔴 포함량 초과(과금 중): ${overNow.map(([n, m]) => `${n} ${m.pct.toFixed(1)}%`).join(', ')}`));
} else if (overSoon.length) {
  console.log(paint(33, ` ⚠ 월말 80% 이상 예상: ${overSoon.map(([n, m]) => `${n} ${m.projectedPct.toFixed(1)}%`).join(', ')}`));
} else {
  console.log(paint(32, ` ✓ 전 항목 포함량 안`) + paint(90, ` — 월말 예상 최고: ${topName} ${top.projectedPct.toFixed(1)}%`));
}
console.log(
  ` 💵 이번 주기 예상 청구 $${summary.estimate.totalUsd.toFixed(2)}` +
  paint(90, overageUsd > 0 ? ` (기본료 $${PLAN.base} + 초과 $${overageUsd.toFixed(2)})` : ' (기본료만)'),
);
console.log();

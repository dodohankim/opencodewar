#!/usr/bin/env node
// Cloudflare 무료 티어 사용량 체크(Workers·KV·D1). GraphQL Analytics + REST 로 오늘(UTC) 사용량을 집계해
// 무료 한도 대비 게이지로 보여준다. 일일 한도는 매일 00:00 UTC 리셋.
//
//   node scripts/cf-usage.mjs [--json]
//
// 크레덴셜: 리포 루트 .env 의 CLOUDFLARE_API_TOKEN (Account Analytics Read + D1/KV Read 권한).
// 계정 ID 는 CLOUDFLARE_ACCOUNT_ID 가 없으면 /accounts API 로 자동 해석한다.
//
// 한도 출처: developers.cloudflare.com (workers/platform/limits, kv/platform/pricing, d1/platform/pricing)
// 수치가 바뀌면 아래 LIMITS 만 고치면 된다. (기준: 2026-07 문서)

import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const API = 'https://api.cloudflare.com/client/v4';
const JSON_MODE = process.argv.includes('--json');

const LIMITS = {
  workersRequestsPerDay: 100_000,
  kvReadsPerDay: 100_000,
  kvWritesPerDay: 1_000,
  kvDeletesPerDay: 1_000,
  kvListsPerDay: 1_000,
  kvStorageBytes: 1 * 1024 ** 3, // 계정·네임스페이스 각각 1 GB
  d1RowsReadPerDay: 5_000_000,
  d1RowsWrittenPerDay: 100_000,
  d1StorageBytes: 5 * 1024 ** 3, // 계정 합산 5 GB
  d1PerDbBytes: 500 * 1024 ** 2, // 무료 플랜 DB 1개당 500 MB
};

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

// ---- 수집 ----
const accountId = process.env.CLOUDFLARE_ACCOUNT_ID || (await cf('/accounts'))[0].id;

const now = new Date();
const today = now.toISOString().slice(0, 10);
const yesterday = new Date(now.getTime() - 864e5).toISOString().slice(0, 10);
const todayStart = `${today}T00:00:00Z`;

const acct = await gql(`{
  viewer { accounts(filter: { accountTag: "${accountId}" }) {
    workers: workersInvocationsAdaptive(filter: { datetime_geq: "${todayStart}" }, limit: 100) {
      sum { requests errors }
      dimensions { scriptName }
    }
    kvOps: kvOperationsAdaptiveGroups(filter: { date: "${today}" }, limit: 100) {
      sum { requests }
      dimensions { actionType }
    }
    kvStorage: kvStorageAdaptiveGroups(filter: { date_geq: "${yesterday}" }, limit: 100, orderBy: [date_DESC]) {
      max { byteCount keyCount }
      dimensions { date namespaceId }
    }
    d1: d1AnalyticsAdaptiveGroups(filter: { date: "${today}" }, limit: 100) {
      sum { rowsRead rowsWritten readQueries writeQueries }
      dimensions { databaseId }
    }
  } }
}`);

const workersTotal = acct.workers.reduce((a, w) => a + w.sum.requests, 0);
const workersByScript = acct.workers
  .map((w) => ({ name: w.dimensions.scriptName, requests: w.sum.requests, errors: w.sum.errors }))
  .sort((a, b) => b.requests - a.requests);

const kvOps = Object.fromEntries(acct.kvOps.map((o) => [o.dimensions.actionType, o.sum.requests]));

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

const d1RowsRead = acct.d1.reduce((a, d) => a + d.sum.rowsRead, 0);
const d1RowsWritten = acct.d1.reduce((a, d) => a + d.sum.rowsWritten, 0);

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
const metric = (used, limit) => ({ used, limit, pct: +((used / limit) * 100).toFixed(2) });

const summary = {
  date: today,
  accountId,
  workers: {
    requests: metric(workersTotal, LIMITS.workersRequestsPerDay),
    byScript: workersByScript,
  },
  kv: {
    reads: metric(kvOps.read ?? 0, LIMITS.kvReadsPerDay),
    writes: metric(kvOps.write ?? 0, LIMITS.kvWritesPerDay),
    deletes: metric(kvOps.delete ?? 0, LIMITS.kvDeletesPerDay),
    lists: metric(kvOps.list ?? 0, LIMITS.kvListsPerDay),
    storage: metric(kvStorageTotal, LIMITS.kvStorageBytes),
    namespaces: [...kvNsBytes.entries()].map(([id, v]) => ({ id, title: nsTitles[id] ?? id, ...v })),
  },
  d1: {
    rowsRead: metric(d1RowsRead, LIMITS.d1RowsReadPerDay),
    rowsWritten: metric(d1RowsWritten, LIMITS.d1RowsWrittenPerDay),
    storage: metric(d1StorageTotal, LIMITS.d1StorageBytes),
    databases: d1Dbs.map((d) => ({ ...d, pctOfDbCap: +((d.bytes / LIMITS.d1PerDbBytes) * 100).toFixed(2) })),
  },
};

if (JSON_MODE) {
  console.log(JSON.stringify(summary, null, 2));
  process.exit(0);
}

// ---- 터미널 렌더링 ----
const tty = process.stdout.isTTY;
const paint = (code, s) => (tty ? `\x1b[${code}m${s}\x1b[0m` : s);
const num = (n) => n.toLocaleString('en-US');
const mb = (b) => (b >= 1024 ** 3 ? `${(b / 1024 ** 3).toFixed(2)} GB` : `${(b / 1024 ** 2).toFixed(2)} MB`);
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

const worst = [];
function row(section, label, m, fmt = num) {
  const pctStr = paint(1, paint(colorOf(m.pct), `${m.pct.toFixed(1).padStart(5)}%`));
  console.log(`  ${label.padEnd(12)} ${pctStr}  ${gauge(m.pct)}  ${paint(90, `${fmt(m.used)} / ${fmt(m.limit)}`)}`);
  if (m.pct >= 80) worst.push(`${section} ${label} ${m.pct.toFixed(1)}%`);
}
const section = (title) =>
  console.log('\n' + paint(1, ` ${title} `) + paint(90, '─'.repeat(Math.max(0, 54 - title.length))));
const sub = (s) => console.log(paint(90, `    · ${s}`));

const untilReset = new Date(`${today}T24:00:00Z`) - now;
const hh = String(Math.floor(untilReset / 36e5)).padStart(2, '0');
const mm = String(Math.floor((untilReset % 36e5) / 6e4)).padStart(2, '0');

console.log(
  '\n' + paint(1, ' Cloudflare 무료 티어 사용량') +
  paint(90, `  ${today} UTC · 리셋까지 ${hh}:${mm} · 계정 ${accountId.slice(0, 6)}…`),
);

section('Workers (계정 전체 합산)');
row('Workers', 'requests', summary.workers.requests);
for (const s of workersByScript) {
  const share = ((s.requests / LIMITS.workersRequestsPerDay) * 100).toFixed(1);
  const err = s.errors ? paint(31, `  errors ${num(s.errors)}`) : '';
  sub(`${s.name.padEnd(24)} ${num(s.requests).padStart(8)}  (한도의 ${share}%)${err}`);
}

section('KV');
row('KV', 'reads', summary.kv.reads);
row('KV', 'writes', summary.kv.writes);
row('KV', 'deletes', summary.kv.deletes);
row('KV', 'lists', summary.kv.lists);
row('KV', 'storage', summary.kv.storage, mb);
for (const ns of summary.kv.namespaces) {
  sub(`${ns.title.padEnd(24)} ${mb(ns.bytes).padStart(10)}  keys ${num(ns.keys)}`);
}

section('D1');
row('D1', 'rows read', summary.d1.rowsRead);
row('D1', 'rows written', summary.d1.rowsWritten);
if (d1Dbs.length) {
  row('D1', 'storage', summary.d1.storage, mb);
  for (const db of summary.d1.databases) {
    sub(`${db.name.padEnd(24)} ${mb(db.bytes).padStart(10)}  (DB당 500MB 의 ${db.pctOfDbCap.toFixed(1)}%)`);
  }
}

// 최고 사용률 요약 + 경고
const allMetrics = [
  ['Workers requests', summary.workers.requests.pct],
  ['KV reads', summary.kv.reads.pct],
  ['KV writes', summary.kv.writes.pct],
  ['KV deletes', summary.kv.deletes.pct],
  ['KV lists', summary.kv.lists.pct],
  ['KV storage', summary.kv.storage.pct],
  ['D1 rows read', summary.d1.rowsRead.pct],
  ['D1 rows written', summary.d1.rowsWritten.pct],
  ['D1 storage', summary.d1.storage.pct],
];
const [topName, topPct] = allMetrics.sort((a, b) => b[1] - a[1])[0];

console.log();
if (worst.length) {
  console.log(paint(33, ` ⚠ 80% 이상 도달: ${worst.join(', ')}`));
} else {
  console.log(paint(32, ` ✓ 전 항목 여유`) + paint(90, ` — 최고 사용률: ${topName} ${topPct.toFixed(1)}%`));
}
console.log();

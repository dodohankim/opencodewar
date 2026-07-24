// Cloudflare 무료 티어 사용량 일일 리포트 → Discord 웹훅.
// 매일 23:50 UTC(KST 08:50) 크론으로 실행 — 한도 리셋(00:00 UTC) 직전이라 "오늘 하루 총 사용량"이 된다.
// 수집 로직은 scripts/cf-usage.mjs 와 동일 소스(GraphQL Analytics + REST). 한도 수치 바뀌면 두 곳 모두 갱신.

interface Env {
  ACCOUNT_ID: string;
  CF_ANALYTICS_TOKEN: string; // secret: Account Analytics Read + KV/D1 Read
  DISCORD_WEBHOOK_URL: string; // secret
}

const API = 'https://api.cloudflare.com/client/v4';

// 무료 한도 (기준: 2026-07 문서 — workers/platform/limits, kv/platform/pricing, d1/platform/pricing)
const LIMITS = {
  workersRequestsPerDay: 100_000,
  kvReadsPerDay: 100_000,
  kvWritesPerDay: 1_000,
  kvDeletesPerDay: 1_000,
  kvListsPerDay: 1_000,
  kvStorageBytes: 1 * 1024 ** 3,
  d1RowsReadPerDay: 5_000_000,
  d1RowsWrittenPerDay: 100_000,
  d1StorageBytes: 5 * 1024 ** 3,
};

async function cf(env: Env, path: string): Promise<any> {
  const res = await fetch(`${API}${path}`, {
    headers: { Authorization: `Bearer ${env.CF_ANALYTICS_TOKEN}` },
  });
  const body: any = await res.json();
  if (!body.success) throw new Error(`${path} 실패: ${JSON.stringify(body.errors)}`);
  return body.result;
}

async function gql(env: Env, query: string): Promise<any> {
  const res = await fetch(`${API}/graphql`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${env.CF_ANALYTICS_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query }),
  });
  const body: any = await res.json();
  if (body.errors?.length) throw new Error(`GraphQL 실패: ${JSON.stringify(body.errors)}`);
  return body.data.viewer.accounts[0];
}

// 1.2k / 384k / 5M 식 축약(디스코드 모바일 폭에 맞춤)
function compact(n: number): string {
  if (n >= 1e6) return `${+(n / 1e6).toFixed(1)}M`;
  if (n >= 1e3) return `${+(n / 1e3).toFixed(1)}k`;
  return String(n);
}
const mb = (b: number) =>
  b >= 1024 ** 3 ? `${(b / 1024 ** 3).toFixed(2)}GB` : `${(b / 1024 ** 2).toFixed(1)}MB`;

const BAR_W = 12;
function gauge(pct: number): string {
  const cells = Math.max(0, Math.min(BAR_W, (pct / 100) * BAR_W));
  const full = Math.floor(cells);
  const frac = Math.round((cells - full) * 8);
  const partial = full < BAR_W && frac > 0 ? '▏▎▍▌▋▊▉█'[frac - 1] : '';
  return ('█'.repeat(full) + partial).padEnd(BAR_W, '░');
}

interface Metric {
  label: string;
  used: number;
  limit: number;
  pct: number;
  fmt: (n: number) => string;
}
const metric = (label: string, used: number, limit: number, fmt = compact): Metric => ({
  label,
  used,
  limit,
  pct: (used / limit) * 100,
  fmt,
});

async function buildReport(env: Env) {
  const now = new Date();
  const today = now.toISOString().slice(0, 10);
  const yesterday = new Date(now.getTime() - 864e5).toISOString().slice(0, 10);

  const acct = await gql(
    env,
    `{
      viewer { accounts(filter: { accountTag: "${env.ACCOUNT_ID}" }) {
        workers: workersInvocationsAdaptive(filter: { datetime_geq: "${today}T00:00:00Z" }, limit: 100) {
          sum { requests errors }
          dimensions { scriptName }
        }
        kvOps: kvOperationsAdaptiveGroups(filter: { date: "${today}" }, limit: 100) {
          sum { requests }
          dimensions { actionType }
        }
        kvStorage: kvStorageAdaptiveGroups(filter: { date_geq: "${yesterday}" }, limit: 100, orderBy: [date_DESC]) {
          max { byteCount }
          dimensions { date namespaceId }
        }
        d1: d1AnalyticsAdaptiveGroups(filter: { date: "${today}" }, limit: 100) {
          sum { rowsRead rowsWritten }
          dimensions { databaseId }
        }
      } }
    }`,
  );

  const workersTotal = acct.workers.reduce((a: number, w: any) => a + w.sum.requests, 0);
  const workersErrors = acct.workers.reduce((a: number, w: any) => a + w.sum.errors, 0);
  const byScript = acct.workers
    .map((w: any) => ({ name: w.dimensions.scriptName, requests: w.sum.requests }))
    .sort((a: any, b: any) => b.requests - a.requests);

  const kvOps: Record<string, number> = Object.fromEntries(
    acct.kvOps.map((o: any) => [o.dimensions.actionType, o.sum.requests]),
  );

  // 네임스페이스별 최신 날짜 행만 합산(오늘 행이 아직 없으면 어제 행)
  const nsSeen = new Map<string, number>();
  for (const row of acct.kvStorage) {
    const id = row.dimensions.namespaceId;
    if (!nsSeen.has(id)) nsSeen.set(id, row.max.byteCount);
  }
  const kvStorageTotal = [...nsSeen.values()].reduce((a, b) => a + b, 0);

  const d1RowsRead = acct.d1.reduce((a: number, d: any) => a + d.sum.rowsRead, 0);
  const d1RowsWritten = acct.d1.reduce((a: number, d: any) => a + d.sum.rowsWritten, 0);

  let d1StorageTotal = 0;
  try {
    const dbs = await cf(env, `/accounts/${env.ACCOUNT_ID}/d1/database?per_page=100`);
    for (const db of dbs) {
      const detail = await cf(env, `/accounts/${env.ACCOUNT_ID}/d1/database/${db.uuid}`);
      d1StorageTotal += detail.file_size ?? 0;
    }
  } catch {
    /* D1 read 권한 없으면 스토리지만 생략 */
  }

  const sections: Array<[string, Metric[]]> = [
    ['Workers', [metric('requests', workersTotal, LIMITS.workersRequestsPerDay)]],
    [
      'KV',
      [
        metric('reads', kvOps.read ?? 0, LIMITS.kvReadsPerDay),
        metric('writes', kvOps.write ?? 0, LIMITS.kvWritesPerDay),
        metric('deletes', kvOps.delete ?? 0, LIMITS.kvDeletesPerDay),
        metric('lists', kvOps.list ?? 0, LIMITS.kvListsPerDay),
        metric('storage', kvStorageTotal, LIMITS.kvStorageBytes, mb),
      ],
    ],
    [
      'D1',
      [
        metric('rows read', d1RowsRead, LIMITS.d1RowsReadPerDay),
        metric('rows written', d1RowsWritten, LIMITS.d1RowsWrittenPerDay),
        metric('storage', d1StorageTotal, LIMITS.d1StorageBytes, mb),
      ],
    ],
  ];

  return { today, sections, byScript, workersErrors };
}

async function sendDiscord(env: Env, payload: unknown) {
  const res = await fetch(env.DISCORD_WEBHOOK_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  if (!res.ok) throw new Error(`Discord 웹훅 실패: ${res.status} ${await res.text()}`);
}

async function report(env: Env) {
  const { today, sections, byScript, workersErrors } = await buildReport(env);

  const all = sections.flatMap(([name, ms]) => ms.map((m) => ({ ...m, section: name })));
  const top = [...all].sort((a, b) => b.pct - a.pct)[0];
  const over80 = all.filter((m) => m.pct >= 80);

  const lines: string[] = [];
  for (const [name, ms] of sections) {
    lines.push(name);
    for (const m of ms) {
      lines.push(
        ` ${m.label.padEnd(12)} ${m.pct.toFixed(1).padStart(5)}% ${gauge(m.pct)} ${m.fmt(m.used)}/${m.fmt(m.limit)}`,
      );
    }
  }
  lines.push('');
  lines.push('Workers by script');
  for (const s of byScript) lines.push(` ${s.name.padEnd(22)} ${compact(s.requests).padStart(7)}`);

  const color = top.pct >= 90 ? 0xed4245 : top.pct >= 70 ? 0xfee75c : 0x57f287;
  const status = over80.length
    ? `⚠ 80% 이상: ${over80.map((m) => `${m.section} ${m.label} ${m.pct.toFixed(1)}%`).join(', ')}`
    : `✓ 전 항목 여유 — 최고 사용률: ${top.section} ${top.label} ${top.pct.toFixed(1)}%`;
  const errNote = workersErrors ? `\n🔥 Worker 오류 ${workersErrors}건 발생` : '';

  await sendDiscord(env, {
    username: 'CF Usage',
    embeds: [
      {
        title: `Cloudflare 무료 티어 사용량 — ${today} (UTC)`,
        description: `${status}${errNote}\n\`\`\`\n${lines.join('\n')}\n\`\`\``,
        color,
        footer: { text: '일일 한도 리셋 00:00 UTC (KST 09:00)' },
        timestamp: new Date().toISOString(),
      },
    ],
  });
}

export default {
  async scheduled(_event: ScheduledEvent, env: Env, ctx: ExecutionContext) {
    ctx.waitUntil(
      report(env).catch(async (err) => {
        // 수집 실패도 침묵하지 않고 웹훅으로 알린다(웹훅 자체 실패면 로그로만 남음).
        console.error('usage report failed:', err);
        await sendDiscord(env, {
          username: 'CF Usage',
          content: `⚠ 사용량 리포트 생성 실패: ${err instanceof Error ? err.message : String(err)}`,
        }).catch(() => {});
      }),
    );
  },
};

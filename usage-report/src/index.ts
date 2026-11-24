// Cloudflare Workers Paid 플랜 사용량 리포트 → Discord 웹훅.
// 6시간마다 00:10·06:10·12:10·18:10 UTC(KST 09:10·15:10·21:10·03:10) 크론으로 실행한다.
// 유료 플랜의 포함량은 일 단위가 아니라 월 단위이고, 구독 갱신일(BILLING_DAY, 매달 18일)에 리셋된다.
// 그래서 이번 결제 주기 첫날부터 지금까지 누적한 값을 포함량과 비교하고, 월말 예상치와 예상 초과 요금을 낸다.
// 하루(UTC) 사용량은 하루 단위 변화를 보려고 따로 싣는다. 00시(UTC) 발송분은 막 끝난 어제 하루의 총량을,
// 나머지 발송분은 아직 진행 중인 오늘의 중간 집계를 싣는다(reportDay).
// 수집 로직은 scripts/cf-usage.mjs 와 동일 소스(GraphQL Analytics + REST). 포함량·단가가 바뀌면 두 곳 모두 갱신.

interface Env {
  ACCOUNT_ID: string;
  OCW_DB_ID: string; // ocw-db (D1) — 유저 리포트용
  BILLING_DAY: string; // Workers Paid 구독 갱신일(매달 n일, UTC 기준으로 계산)
  CF_ANALYTICS_TOKEN: string; // secret: Account Analytics Read + KV/D1 Read
  DISCORD_WEBHOOK_URL: string; // secret — #cloudflare-리포트 (CF 사용량 리포트)
  DISCORD_WEBHOOK_URL_USER: string; // secret — #ocw-리포트 (OCW 유저 리포트)
}

const API = 'https://api.cloudflare.com/client/v4';

// Workers Paid 월 포함량과 초과 단가 (기준: 2026-11 문서 — workers/platform/pricing, kv/platform/pricing, d1/platform/pricing)
// price 는 unit 단위당 달러. 스토리지는 GB-월 단가라 "지금 크기가 한 달 내내 유지된다"고 보고 계산한다.
const GB = 1024 ** 3;
const PLAN = {
  base: 5, // 월 기본료(USD)
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
type Rate = { included: number; price: number; unit: number };

// 이번 결제 주기: 가장 최근의 BILLING_DAY 00:00 UTC ~ 다음 달 같은 날.
// 그 달에 BILLING_DAY 가 없으면(예: 31일) 그 달 말일로 당긴다.
function billingPeriod(now: Date, billingDay: number) {
  const at = (y: number, m: number) => {
    const last = new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
    return new Date(Date.UTC(y, m, Math.min(billingDay, last)));
  };
  let y = now.getUTCFullYear();
  let m = now.getUTCMonth();
  let start = at(y, m);
  if (start > now) {
    m -= 1;
    start = at(y, m);
  }
  const end = at(y, m + 1);
  const totalDays = (end.getTime() - start.getTime()) / 864e5;
  const elapsedDays = (now.getTime() - start.getTime()) / 864e5;
  return { start, end, totalDays, elapsedDays };
}

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
  if (n >= 1e9) return `${+(n / 1e9).toFixed(1)}B`; // D1 rows read 포함량 25B
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
  used: number; // 이번 주기 누적(스토리지는 지금 크기)
  today: number | null; // 오늘(UTC) 사용량, 스토리지는 null
  projected: number; // 월말 예상(스토리지는 지금 크기 그대로)
  rate: Rate;
  pct: number; // 포함량 대비 지금 사용률
  projectedPct: number;
  overageUsd: number; // 월말 예상치 기준 초과 요금
  fmt: (n: number) => string;
}

function metric(
  label: string,
  used: number,
  today: number | null,
  rate: Rate,
  scale: number, // 월말 예상 배율(총 일수 ÷ 지난 일수), 스토리지는 1
  fmt = compact,
): Metric {
  const projected = used * scale;
  return {
    label,
    used,
    today,
    projected,
    rate,
    pct: (used / rate.included) * 100,
    projectedPct: (projected / rate.included) * 100,
    overageUsd: (Math.max(0, projected - rate.included) / rate.unit) * rate.price,
    fmt,
  };
}

// 하루 줄에 실을 UTC 날짜. 00시(UTC) 발송분은 오늘이 막 시작돼 거의 비어 있으므로 어제 하루 총량을 싣는다.
function reportDay(now = new Date()) {
  const final = now.getUTCHours() === 0;
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()) - (final ? 864e5 : 0));
  const end = new Date(start.getTime() + 864e5);
  const day = start.toISOString().slice(0, 10);
  const prev = new Date(start.getTime() - 864e5).toISOString().slice(0, 10);
  return { day, prev, start, end, final, label: final ? '어제' : '오늘' };
}

async function buildReport(env: Env) {
  const now = new Date();
  const rd = reportDay(now);
  const today = rd.day;
  const yesterday = new Date(now.getTime() - 864e5).toISOString().slice(0, 10);
  const period = billingPeriod(now, Number(env.BILLING_DAY) || 18);
  const periodStart = period.start.toISOString().slice(0, 10);
  // 주기 첫날 몇 시간만 지난 시점에는 배율이 지나치게 커지므로 최소 하루가 지난 것으로 본다.
  const scale = period.totalDays / Math.max(1, period.elapsedDays);

  const acct = await gql(
    env,
    `{
      viewer { accounts(filter: { accountTag: "${env.ACCOUNT_ID}" }) {
        workers: workersInvocationsAdaptive(filter: { datetime_geq: "${periodStart}T00:00:00Z" }, limit: 1000) {
          sum { requests errors cpuTimeUs }
          dimensions { scriptName }
        }
        workersToday: workersInvocationsAdaptive(filter: { datetime_geq: "${rd.start.toISOString()}", datetime_lt: "${rd.end.toISOString()}" }, limit: 1000) {
          sum { requests errors cpuTimeUs }
          dimensions { scriptName }
        }
        kvOps: kvOperationsAdaptiveGroups(filter: { date_geq: "${periodStart}" }, limit: 1000) {
          sum { requests }
          dimensions { actionType date }
        }
        kvStorage: kvStorageAdaptiveGroups(filter: { date_geq: "${yesterday}" }, limit: 100, orderBy: [date_DESC]) {
          max { byteCount }
          dimensions { date namespaceId }
        }
        d1: d1AnalyticsAdaptiveGroups(filter: { date_geq: "${periodStart}" }, limit: 1000) {
          sum { rowsRead rowsWritten }
          dimensions { date }
        }
      } }
    }`,
  );

  const sumOf = (rows: any[], key: string) => rows.reduce((a: number, r: any) => a + (r.sum[key] ?? 0), 0);
  const workersTotal = sumOf(acct.workers, 'requests');
  const workersToday = sumOf(acct.workersToday, 'requests');
  const cpuMsTotal = sumOf(acct.workers, 'cpuTimeUs') / 1000;
  const cpuMsToday = sumOf(acct.workersToday, 'cpuTimeUs') / 1000;
  const workersErrors = sumOf(acct.workersToday, 'errors');

  const todayByScript = new Map<string, number>(
    acct.workersToday.map((w: any) => [w.dimensions.scriptName, w.sum.requests]),
  );
  const byScript = acct.workers
    .map((w: any) => ({
      name: w.dimensions.scriptName,
      requests: w.sum.requests,
      today: todayByScript.get(w.dimensions.scriptName) ?? 0,
    }))
    .sort((a: any, b: any) => b.requests - a.requests);

  const kvPeriod: Record<string, number> = {};
  const kvToday: Record<string, number> = {};
  for (const o of acct.kvOps) {
    const t = o.dimensions.actionType;
    kvPeriod[t] = (kvPeriod[t] ?? 0) + o.sum.requests;
    if (o.dimensions.date === today) kvToday[t] = (kvToday[t] ?? 0) + o.sum.requests;
  }

  // 네임스페이스별 최신 날짜 행만 합산(오늘 행이 아직 없으면 어제 행)
  const nsSeen = new Map<string, number>();
  for (const row of acct.kvStorage) {
    const id = row.dimensions.namespaceId;
    if (!nsSeen.has(id)) nsSeen.set(id, row.max.byteCount);
  }
  const kvStorageTotal = [...nsSeen.values()].reduce((a, b) => a + b, 0);

  const d1Today = acct.d1.filter((d: any) => d.dimensions.date === today);

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

  const ms = (n: number) => compact(Math.round(n));
  const sections: Array<[string, Metric[]]> = [
    [
      'Workers',
      [
        metric('requests', workersTotal, workersToday, PLAN.workersRequests, scale),
        metric('CPU ms', cpuMsTotal, cpuMsToday, PLAN.workersCpuMs, scale, ms),
      ],
    ],
    [
      'KV',
      [
        metric('reads', kvPeriod.read ?? 0, kvToday.read ?? 0, PLAN.kvReads, scale),
        metric('writes', kvPeriod.write ?? 0, kvToday.write ?? 0, PLAN.kvWrites, scale),
        metric('deletes', kvPeriod.delete ?? 0, kvToday.delete ?? 0, PLAN.kvDeletes, scale),
        metric('lists', kvPeriod.list ?? 0, kvToday.list ?? 0, PLAN.kvLists, scale),
        metric('storage', kvStorageTotal, null, PLAN.kvStorage, 1, mb),
      ],
    ],
    [
      'D1',
      [
        metric('rows read', sumOf(acct.d1, 'rowsRead'), sumOf(d1Today, 'rowsRead'), PLAN.d1RowsRead, scale),
        metric('rows written', sumOf(acct.d1, 'rowsWritten'), sumOf(d1Today, 'rowsWritten'), PLAN.d1RowsWritten, scale),
        metric('storage', d1StorageTotal, null, PLAN.d1Storage, 1, mb),
      ],
    ],
  ];

  return { rd, period, sections, byScript, workersErrors };
}

// ocw-db 를 REST 로 읽기 쿼리(바인딩 대신 REST — 로컬 --test-scheduled 에서도 실DB 그대로 조회됨)
async function d1Query(env: Env, sql: string, params: unknown[] = []): Promise<any> {
  const res = await fetch(
    `${API}/accounts/${env.ACCOUNT_ID}/d1/database/${env.OCW_DB_ID}/query`,
    {
      method: 'POST',
      headers: { Authorization: `Bearer ${env.CF_ANALYTICS_TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ sql, params }),
    },
  );
  const body: any = await res.json();
  if (!body.success) throw new Error(`D1 쿼리 실패: ${JSON.stringify(body.errors)}`);
  return body.result[0].results;
}

// OCW 유저 리포트 embed — 오늘(UTC) 가입·활성 유저. daily_stats.day 는 UTC 일자.
async function buildUserEmbed(env: Env) {
  const rd = reportDay();
  const today = rd.day;
  const yesterday = rd.prev;
  const todayStartMs = rd.start.getTime();
  const todayEndMs = rd.end.getTime();
  const yesterdayStartMs = todayStartMs - 864e5;

  const [row] = await d1Query(
    env,
    `SELECT
      (SELECT COUNT(*) FROM users WHERE created_at >= ?1 AND created_at < ?5) AS signups_today,
      (SELECT COUNT(*) FROM users WHERE created_at >= ?2 AND created_at < ?1) AS signups_yesterday,
      (SELECT COUNT(*) FROM users) AS total_users,
      (SELECT COUNT(DISTINCT user_id) FROM daily_stats WHERE day = ?3) AS active_today,
      (SELECT COUNT(DISTINCT user_id) FROM daily_stats WHERE day = ?4) AS active_yesterday,
      (SELECT COALESCE(SUM(prompts), 0) FROM daily_stats WHERE day = ?3) AS prompts_today,
      (SELECT COALESCE(SUM(chars), 0) FROM daily_stats WHERE day = ?3) AS chars_today`,
    [todayStartMs, yesterdayStartMs, today, yesterday, todayEndMs],
  );

  return {
    title: `OCW 유저 리포트 — ${today} (UTC)${dayTag(rd)}`,
    description: [
      `👥 ${rd.label} 가입 **${row.signups_today}명** (누적 ${row.total_users}명)`,
      `⚡ ${rd.label} 활성 **${row.active_today}명** · 프롬프트 ${compact(row.prompts_today)}건 · ${compact(row.chars_today)}자`,
      `${rd.final ? '그제' : '어제'}: 가입 ${row.signups_yesterday}명 · 활성 ${row.active_yesterday}명`,
    ].join('\n'),
    color: 0x5865f2,
  };
}

async function sendDiscord(webhookUrl: string, payload: unknown) {
  const res = await fetch(webhookUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  if (!res.ok) throw new Error(`Discord 웹훅 실패: ${res.status} ${await res.text()}`);
}

// 11/18 식 날짜(UTC)
const md = (d: Date) => `${d.getUTCMonth() + 1}/${d.getUTCDate()}`;
const usd = (n: number) => `$${n.toFixed(2)}`;

async function buildUsageEmbed(env: Env) {
  const { rd, period, sections, byScript, workersErrors } = await buildReport(env);

  const all = sections.flatMap(([name, ms]) => ms.map((m) => ({ ...m, section: name })));
  const top = [...all].sort((a, b) => b.projectedPct - a.projectedPct)[0];
  const overNow = all.filter((m) => m.pct >= 100); // 이미 포함량을 넘어 과금 중
  const overSoon = all.filter((m) => m.pct < 100 && m.projectedPct >= 80); // 월말에 80% 이상 예상
  const overageUsd = all.reduce((a, m) => a + m.overageUsd, 0);

  const lines: string[] = [];
  for (const [name, ms] of sections) {
    lines.push(name);
    for (const m of ms) {
      lines.push(
        ` ${m.label.padEnd(12)} ${m.pct.toFixed(1).padStart(5)}% ${gauge(m.pct)} ${m.fmt(m.used)}/${m.fmt(m.rate.included)}`,
      );
    }
  }
  lines.push('');
  lines.push(`${rd.label}(UTC ${rd.day})`);
  for (const [name, ms] of sections) {
    const parts = ms.filter((m) => m.today !== null).map((m) => `${m.label} ${m.fmt(m.today!)}`);
    lines.push(` ${name.padEnd(8)}${parts.join(' · ')}`);
  }
  lines.push('');
  lines.push(`${'Workers by script'.padEnd(23)} ${'주기'.padStart(5)} ${rd.label.padStart(5)}`);
  for (const s of byScript) {
    lines.push(` ${s.name.padEnd(22)} ${compact(s.requests).padStart(7)} ${compact(s.today).padStart(7)}`);
  }

  const color = overNow.length ? 0xed4245 : overSoon.length || overageUsd > 0 ? 0xfee75c : 0x57f287;
  const fmtList = (ms: typeof all, pick: (m: (typeof all)[number]) => number) =>
    ms.map((m) => `${m.section} ${m.label} ${pick(m).toFixed(1)}%`).join(', ');
  const statusLines = [
    overNow.length
      ? `🔴 포함량 초과(과금 중): ${fmtList(overNow, (m) => m.pct)}`
      : overSoon.length
        ? `⚠ 월말 80% 이상 예상: ${fmtList(overSoon, (m) => m.projectedPct)}`
        : `✓ 전 항목 포함량 안 — 월말 예상 최고: ${top.section} ${top.label} ${top.projectedPct.toFixed(1)}%`,
    `💵 이번 주기 예상 청구 ${usd(PLAN.base + overageUsd)}` +
      (overageUsd > 0 ? ` (기본료 ${usd(PLAN.base)} + 초과 ${usd(overageUsd)})` : ' (기본료만)'),
  ];
  const errNote = workersErrors ? `\n🔥 ${rd.label} Worker 오류 ${workersErrors}건 발생` : '';
  const day = Math.min(Math.floor(period.elapsedDays) + 1, period.totalDays);
  const lastDay = new Date(period.end.getTime() - 864e5);

  return {
    title: `Cloudflare Workers Paid 사용량 — ${rd.day} (UTC)${dayTag(rd)}`,
    description: `${statusLines.join('\n')}${errNote}\n\`\`\`\n${lines.join('\n')}\n\`\`\``,
    color,
    footer: {
      text: `결제 주기 ${md(period.start)}~${md(lastDay)} · ${day}/${period.totalDays}일째 · 월 포함량은 매달 ${period.start.getUTCDate()}일 리셋`,
    },
    timestamp: new Date().toISOString(),
  };
}

type ReportKind = 'all' | 'usage' | 'user';

// 00시(UTC) 발송분은 끝난 하루의 총량, 나머지는 아직 덜 끝난 하루라 제목에 표시한다.
const dayTag = (rd: ReturnType<typeof reportDay>) => (rd.final ? ' · 하루 총량' : ' · 중간 집계');

const errorEmbed = (title: string, err: unknown) => ({
  title,
  description: `⚠ 조회 실패: ${err instanceof Error ? err.message : String(err)}`,
  color: 0xed4245,
});

// 리포트별 독립 발송 — 사용량은 #cloudflare-리포트, 유저 리포트는 #ocw-리포트(별도 웹훅).
// 한쪽 조회/발송이 실패해도 다른 쪽은 정상 발송(allSettled).
async function report(env: Env, kind: ReportKind) {
  const sends: Promise<void>[] = [];
  if (kind !== 'user') {
    const embed = await buildUsageEmbed(env).catch((err) => errorEmbed('Cloudflare Workers Paid 사용량', err));
    sends.push(sendDiscord(env.DISCORD_WEBHOOK_URL, { username: 'CF Usage', embeds: [embed] }));
  }
  if (kind !== 'usage') {
    const embed = await buildUserEmbed(env).catch((err) => errorEmbed('OCW 유저 리포트', err));
    sends.push(sendDiscord(env.DISCORD_WEBHOOK_URL_USER, { username: 'CF Usage', embeds: [embed] }));
  }
  const results = await Promise.allSettled(sends);
  const failed = results.filter((r) => r.status === 'rejected');
  if (failed.length) {
    throw new Error(failed.map((r) => (r as PromiseRejectedResult).reason).join('; '));
  }
}

export default {
  async scheduled(event: ScheduledEvent, env: Env, ctx: ExecutionContext) {
    // 로컬 트리거(send-now.sh)는 cron 문자열로 리포트를 선택한다: "usage" | "user" | 그 외 = 전체.
    // 프로덕션 크론("10 0,6,12,18 * * *")은 항상 전체 발송.
    const kind: ReportKind = event.cron === 'usage' ? 'usage' : event.cron === 'user' ? 'user' : 'all';
    ctx.waitUntil(
      report(env, kind).catch(async (err) => {
        // 발송 실패도 침묵하지 않고 웹훅으로 알린다(웹훅 자체 실패면 로그로만 남음).
        console.error('report failed:', err);
        await sendDiscord(env.DISCORD_WEBHOOK_URL, {
          username: 'CF Usage',
          content: `⚠ 리포트 발송 실패(${kind}): ${err instanceof Error ? err.message : String(err)}`,
        }).catch(() => {});
      }),
    );
  },
};

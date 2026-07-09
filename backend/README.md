# Open Code War — Backend (M1)

Cloudflare Worker + D1 기반 리더보드 API 스켈레톤. 런타임 의존성 없음(순수 fetch 라우터).

## 요구사항

- Node.js 24 (`source ~/.nvm/nvm.sh && nvm use 24`)
- Cloudflare 계정 (원격 배포 시)

## 설치

```bash
npm install
```

## 로컬 개발

```bash
# 1) 로컬 D1에 마이그레이션 적용
npm run db:migrate:local

# 2) 데모 시드 데이터 주입 (선택)
npm run db:seed:local

# 3) 개발 서버 (로컬 D1 사용)
npm run dev
```

## 검증 (테스트 / 타입체크)

```bash
npm run typecheck   # tsc --noEmit
npm run test        # KST 날짜 계산 단위 테스트 (vitest)
```

## API

모든 응답은 JSON, CORS 허용(GET/POST). `userId`는 **인증 비밀키**이므로 공개 응답(`/leaderboard`)에는 절대 포함되지 않는다.

| 메서드 | 경로 | 설명 |
|--------|------|------|
| GET | `/health` | 헬스체크 |
| POST | `/track` | 입력 이벤트 수집. body: `{ "userId": "...", "chars": 42 }` |
| POST | `/register` | 닉네임 등록. body: `{ "userId": "...", "nickname": "..." }` (중복 시 409) |
| GET | `/leaderboard?type=daily\|weekly\|weekend&metric=prompts\|chars&limit=100` | 랭킹 |
| GET | `/me?userId=...&type=...&metric=...` | 내 집계와 순위 |

- `type`: `daily`(KST 오늘) / `weekly`(이번 주 월~일) / `weekend`(이번 주 금·토·일)
- `metric`: `prompts`(기본) / `chars`
- 국가(`country`)는 요청의 `cf.country`에서 자동 부착 (로컬에서는 null일 수 있음)
- `/leaderboard`는 **KV 스냅샷**에서 서빙되며 응답에 `builtAt`(집계 시각) 포함 (아래 캐싱 참고)

### 예시

```bash
curl -X POST localhost:8787/track \
  -H 'content-type: application/json' \
  -d '{"userId":"local_test_user_1","chars":128}'

curl 'localhost:8787/leaderboard?type=daily&metric=prompts'
curl 'localhost:8787/me?userId=seed_user_09&type=weekend'
```

## 리더보드 캐싱 (KV 스냅샷) — DESIGN.md §13

리더보드는 매 요청 D1을 조회하지 않고, **KV에 저장된 사전 집계 스냅샷**(단일 키 `lb:snapshot:v1`)을 서빙한다.

- **재빌드 시점**: (a) Cron `*/30 * * * *`(운영 30분), (b) 읽기 시 `SNAPSHOT_TTL_MS` 초과면 자동 재빌드
- **간격 설정**: `wrangler.jsonc` `vars.SNAPSHOT_TTL_MS`(운영 1800000=30분). 로컬은 `.dev.vars`로 낮춤(예 `SNAPSHOT_TTL_MS=60000`=1분).
- **비용**: KV 쓰기 = 간격당 1회(30분→48/일, 무료 1천/일 이내). `/leaderboard` 읽기 = KV get 1회.
- `/me`는 정확한 개인 순위를 위해 **실시간 D1**(저빈도) 유지.

### 로컬에서 캐시/cron 테스트

```bash
# dev는 --test-scheduled 로 /__scheduled 를 노출한다 (package.json)
npm run dev

# 스냅샷 강제 재빌드 (cron 시뮬레이션)
curl localhost:8787/__scheduled

# KV 스냅샷 확인
npx wrangler kv key get --binding KV --local "lb:snapshot:v1"
```

> KV는 로컬(Miniflare)에서 quota 없이 동작한다.

## 원격 배포

```bash
# 1) D1 생성 후 database_id 를 wrangler.jsonc 에 반영
npx wrangler d1 create ocw-db

# 2) KV 네임스페이스 생성 후 id 를 wrangler.jsonc 에 반영
npx wrangler kv namespace create ocw-kv

# 3) 원격 마이그레이션 + 배포
npm run db:migrate:remote
npm run deploy
```

## 범위 / TODO

- [x] D1 스키마(events / users / daily_stats), `/track` `/register` `/leaderboard` `/me`
- [x] **KV 스냅샷 캐싱 + Cron 재빌드**(M4 캐싱), 쓰기 다이어트(last_seen 제거·events 인덱스 제거)
- [ ] **rate-limit** (userId·IP 기준) — DESIGN.md §9. 현재는 입력 검증 + 글자 수 상한만 적용.
- [ ] 닉네임 비속어 필터
- [ ] `events` 보존정책(프루닝)

> 자기신고 데이터 특성상 값 위조는 원천 차단되지 않는다(DESIGN.md §9). 재미용 리더보드 기준의 검증 수준.

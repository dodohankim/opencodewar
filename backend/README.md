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

### 예시

```bash
curl -X POST localhost:8787/track \
  -H 'content-type: application/json' \
  -d '{"userId":"local_test_user_1","chars":128}'

curl 'localhost:8787/leaderboard?type=daily&metric=prompts'
curl 'localhost:8787/me?userId=seed_user_09&type=weekend'
```

## 원격 배포

```bash
# 1) D1 생성 후 반환된 database_id를 wrangler.jsonc에 반영
npx wrangler d1 create ocw-db

# 2) 원격 마이그레이션
npm run db:migrate:remote

# 3) 배포
npm run deploy
```

## M1 범위 / TODO

- [x] D1 스키마(events / users / daily_stats), `/track` `/register` `/leaderboard` `/me`
- [ ] **rate-limit** (userId·IP 기준) — DESIGN.md §9. 현재는 입력 검증 + 글자 수 상한만 적용.
- [ ] 닉네임 비속어 필터
- [ ] 플러그인 훅 연동(M2), 웹 연동(M3)

> 자기신고 데이터 특성상 값 위조는 원천 차단되지 않는다(DESIGN.md §9). 재미용 리더보드 기준의 검증 수준.

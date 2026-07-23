# Open Code War — 설계 문서 (v0.1)

> 코딩 에이전트 사용자들이 "누가 제일 많이 입력했나"를 겨루는 리더보드 게임.
> 에이전트 훅으로 입력을 수집 → Cloudflare에 집계 → 웹에서 일간·주간·주말 랭킹과 지도로 표시.

- 상태: **설계 단계 (구현 전)**
- 코드네임: OCW
- 1차 타겟: **대한민국(KR)** / 최종: 전 세계 국가별 지구본 랭킹

---

## 1. 목표와 비목표

### 목표
- 코딩 에이전트(Claude Code·Codex·OpenCode·pi)에 훅/어댑터를 설치한 사람의 **입력 활동량**을 익명으로 수집한다.
- 유저별 **리더보드**를 웹으로 공개한다. (일간 / 주간 / 주말)
- 처음엔 한반도, 나중엔 지구본에서 **국가별 랭킹**을 시각화한다.
- **Anthropic/Claude 톤**의 디자인으로 만든다.

### 비목표 (v1 범위 밖)
- 프롬프트 **내용** 수집·저장 (프라이버시상 절대 안 함)
- 상금·현금성 보상 (조작 검증 부담이 커짐 — 나중에 별도 논의)
- 실시간 대전/멀티플레이 (v1은 배치 집계 기반 랭킹)

---

## 2. 핵심 컨셉 & 용어

| 용어 | 정의 |
|------|------|
| **입력(prompt)** | 사용자가 Claude Code 엔터를 눌러 제출한 1건 |
| **프롬프트 수** | 제출 건수의 합 (리더보드 기본 점수) |
| **글자 수(chars)** | 제출한 프롬프트의 유니코드 문자 수 합 (보조 점수) |
| **익명 ID(userId)** | 설치 시 발급되는 되돌릴 수 없는 랜덤 식별자 |
| **닉네임(nickname)** | 유저가 선택적으로 등록하는 표시 이름 |
| **일간/주간/주말** | KST(UTC+9) 기준 집계 구간. 주말 = 금·토·일 |

---

## 3. 시스템 아키텍처

```
┌────────────────────────────┐      POST /track       ┌──────────────────────────┐
│  Claude Code 플러그인       │  ── userId,chars ──▶   │  Cloudflare Worker        │
│  UserPromptSubmit 훅        │                        │  - cf.country 자동판별    │
│  /ocw 닉네임 슬래시커맨드   │  ── POST /register ──▶ │  - events 기록            │
│  ~/.open-code-war/config    │                        │  - daily_stats 업서트     │
└────────────────────────────┘                        └───────────┬──────────────┘
                                                                   │  D1 (SQLite)
                                       GET /leaderboard            ▼
┌────────────────────────────┐   GET /countries        ┌──────────────────────────┐
│  리더보드 웹 (정적)         │  ◀──── JSON ────────    │  집계 쿼리                │
│  일간·주간·주말 탭          │                         │  일간/주간/주말/국가별    │
│  한반도 지도 → 지구본       │                         └──────────────────────────┘
└────────────────────────────┘
```

- **수집**: 플러그인의 `UserPromptSubmit` 훅이 제출 시마다 Worker로 이벤트 전송(내용 제외).
- **저장/집계**: Worker가 요청 국가(`cf.country`)를 붙여 D1에 기록하고, KST 일자별 집계를 업서트.
- **표시**: 정적 웹이 Worker의 읽기 API를 호출해 랭킹/지도 렌더.

---

## 4. 데이터 수집 (플러그인 & 훅)

### 4.1 훅 종류
- **`UserPromptSubmit`**: 프롬프트 제출마다 실행. 입력 카운트의 핵심.
- (선택) `SessionStart`: 최초 실행 시 설정 파일 없으면 익명 ID 생성.

### 4.2 훅이 받는 입력 (stdin JSON, Claude Code 제공)
```jsonc
{
  "hook_event_name": "UserPromptSubmit",
  "session_id": "…",
  "transcript_path": "…",
  "cwd": "…",
  "prompt": "사용자가 입력한 실제 텍스트"   // ← 서버로 절대 전송하지 않음
}
```

### 4.3 훅이 서버로 보내는 것 (POST /track)
```jsonc
{
  "userId": "ocw_9f3a…",   // 익명 ID
  "chars": 42,              // prompt의 유니코드 문자 수 (내용 아님)
  "clientTs": 1750000000000 // 클라이언트 시각(참고용, 신뢰 X)
}
```
- **원칙**: `prompt` 원문은 보내지 않는다. 글자 수만 계산해서 보낸다.
- **Fail-open**: 네트워크 실패/타임아웃이 나도 Claude Code 사용을 절대 방해하지 않는다. 짧은 타임아웃(예: 1.5s) + 백그라운드 fire-and-forget.
- **구현 언어**: 유니코드(한글) 문자 수 정확 계산 + 크로스플랫폼 위해 **작은 Node 스크립트** 권장. (bash+curl은 글자 수 계산이 부정확)

### 4.4 익명 ID & 닉네임 (로그인 없음)
- **결정: 전통적 로그인(비번/OAuth) 없음.** 설치 시 발급되는 `userId`가 **신원인 동시에 비밀키(=API 키)** 역할을 한다. 서버는 "이 `userId`로 요청하는 사람이 그 계정 주인"이라고 신뢰한다 (GitHub PAT 모델).
- 신원 스펙트럼 중 **1단계(익명 ID + 닉네임)** 채택. → 0: 익명 ID만 / **1: 익명 ID+닉네임(MVP)** / 2: 진짜 로그인(sybil 어뷰징 대응 필요해질 때).
- **설치/등록 플로우** (플러그인은 설치 중 대화형 입력창을 띄우기 어려움 주의):
  1. `SessionStart` 훅에서 `~/.open-code-war/config.json`에 랜덤 `userId` **자동 생성**(조용히).
  2. 닉네임은 유저가 한 번 등록: (A) 슬래시 커맨드 `/ocw nickname <이름>` → `POST /register`, 또는 (B) 웹에서 `userId` 붙여넣고 클레임.
  3. 미등록 시 리더보드에 "익명 코더"로 표시.
- 닉네임 **유일성** + **비속어 필터** 필요.
- ⚠️ 로그인이 없으므로 **여러 ID 생성(sybil) 어뷰징은 원천 차단 불가** — MVP는 감수, 경쟁 과열 시 2단계(OAuth) 도입.

```jsonc
// ~/.open-code-war/config.json
{ "userId": "ocw_9f3a…", "nickname": "dohan", "createdAt": 1750000000000 }
```

---

## 5. 데이터 모델 (D1 / SQLite)

```sql
-- 원시 이벤트 (append-only, 감사/재집계용)
CREATE TABLE events (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id    TEXT    NOT NULL,
  chars      INTEGER NOT NULL DEFAULT 0,
  country    TEXT,                       -- cf.country, 예: 'KR'
  created_at INTEGER NOT NULL            -- 서버 수신 시각(UTC epoch ms)
);
CREATE INDEX idx_events_user_time ON events(user_id, created_at);
CREATE INDEX idx_events_time      ON events(created_at);

-- 유저 프로필
CREATE TABLE users (
  user_id     TEXT PRIMARY KEY,
  nickname    TEXT UNIQUE,               -- NULL 허용(익명)
  country     TEXT,
  created_at  INTEGER NOT NULL,
  last_seen_at INTEGER
);

-- KST 일자별 집계 (리더보드 조회 최적화)
CREATE TABLE daily_stats (
  user_id  TEXT    NOT NULL,
  day      TEXT    NOT NULL,             -- 'YYYY-MM-DD' (KST 기준)
  prompts  INTEGER NOT NULL DEFAULT 0,
  chars    INTEGER NOT NULL DEFAULT 0,
  country  TEXT,
  PRIMARY KEY (user_id, day)
);
CREATE INDEX idx_daily_day ON daily_stats(day);
```

- `/track` 처리 시: `events` insert + `daily_stats` upsert(`prompts+1`, `chars+=N`)를 한 트랜잭션에서.
- 리더보드는 `daily_stats`만 스캔 → 빠름. `events`는 재집계·어뷰징 분석용으로 보관.

---

## 6. API 설계 (Worker 엔드포인트)

| 메서드 | 경로 | 용도 | 비고 |
|--------|------|------|------|
| POST | `/track` | 입력 이벤트 수집 | rate-limit, cf.country 부착 |
| POST | `/register` | 닉네임 등록/변경 | 유일성·비속어 검사 |
| GET | `/leaderboard?type=daily\|weekly\|weekend&metric=prompts\|chars&limit=100` | 랭킹 조회 | 캐시 가능 |
| GET | `/me?userId=…` | 내 순위·통계 | |
| GET | `/countries?type=…` | 국가별 합계 (지구본용) | |

### 6.1 리더보드 응답 예시
```jsonc
{
  "type": "daily", "metric": "prompts", "day": "2026-07-09",
  "updatedAt": 1750000000000,
  "ranking": [
    { "rank": 1, "nickname": "dohan", "prompts": 128, "chars": 5120, "country": "KR" },
    { "rank": 2, "nickname": null,    "prompts": 97,  "chars": 4010, "country": "KR" }
  ]
}
```

---

## 7. 집계 & 리더보드 로직

### 7.1 KST 기준 날짜
- KST = UTC+9, 서머타임 없음. 서버 수신 epoch ms `ts`로부터:
  `dayKST = new Date(ts + 9*3600*1000).toISOString().slice(0,10)`

### 7.2 구간 정의
- **일간**: `day = 오늘(KST)`
- **주간**: 이번 주 월~일 (KST). `WHERE day BETWEEN 월요일 AND 일요일 GROUP BY user_id`
- **주말(금·토·일)**: 이번 주의 금·토·일 3일. 평일에는 "다가오는 주말"이 0부터 쌓이는 형태로 노출.

```sql
-- 일간 (프롬프트 기준)
SELECT user_id, prompts, chars FROM daily_stats
WHERE day = :todayKST ORDER BY prompts DESC LIMIT :limit;

-- 주간
SELECT user_id, SUM(prompts) p, SUM(chars) c FROM daily_stats
WHERE day BETWEEN :monday AND :sunday
GROUP BY user_id ORDER BY p DESC LIMIT :limit;

-- 주말(금토일)
SELECT user_id, SUM(prompts) p, SUM(chars) c FROM daily_stats
WHERE day IN (:fri, :sat, :sun)
GROUP BY user_id ORDER BY p DESC LIMIT :limit;
```

- 조회 시 `users`와 조인해 닉네임/국가 매핑.
- 응답은 짧게 캐시(예: 30~60초)해 D1 부하 완화.

---

## 8. 프론트엔드 / 웹

### 8.1 화면
1. **리더보드 메인**: 탭 `일간 / 주간 / 주말` × 지표 토글 `프롬프트수 / 글자수`.
   - 순위, 닉네임(없으면 "익명 코더"), 프롬프트 수, 글자 수, 국가 뱃지.
   - 상위 1~3위 강조, 내 순위 하이라이트.
2. **지도 시각화 (후속 페이즈로 연기)**:
   - 한반도/지구본 지도는 Phase 1 시안에서 **제외**. 아래 8.3에 개념만 기록.
   - vN **지구본**: `globe.gl`로 국가별 랭킹 점/히트.
3. **내 프로필**: `userId`로 내 순위·추이 확인, 닉네임 등록.

### 8.2 디자인 — "Claude 디자인"
- 크림/종이색 배경, 코럴 포인트 컬러, 정갈한 산세리프의 **Anthropic 톤 재현** (상표 자산 원본은 사용 불가).
- `artifact-design` / `frontend-design` 스킬 활용, **Artifact로 즉시 미리보기**하며 시안 반복.
- 라이트/다크 모드 모두 지원.

### 8.3 지역(시/도) 표시 — MVP는 국가까지만
- **결정: 지도 시각화 전체(한반도·지구본)를 후속 페이즈로 연기.** Phase 1 시안에서도 제거. 아래는 나중을 위한 기록.
- **결정: MVP는 국가 단위(`cf.country`)까지만.** 국내 시/도 색칠은 후속 단계로 미룸.
- 참고: Cloudflare Worker의 `request.cf` 객체는 국가 외에 `region`(시/도)·`city`·`latitude/longitude`도 **무료·자동 제공**한다. 로그인/별도 API 불필요.
- 하지만 **정확도가 낮다**: IP 추정이라 **모바일(통신사 게이트웨이 IP)·VPN·회사망**에서 실제 위치와 어긋남. 지역명은 **영문 로마자**("Gyeonggi-do")로 옴 → 한글 매핑 필요.
- **후속(국내 지도) 권장안**: `cf.region`을 **기본값 자동 채움 + 유저가 시/도 직접 보정 선택**. 순수 자동값만으로 지도 색칠하면 오탐 컴플레인 확실.

---

## 9. 프라이버시 · 보안 · 어뷰징

### 프라이버시 (신뢰가 곧 설치율)
- **프롬프트 내용 미수집.** 글자 수(정수)만 전송.
- 익명 ID, 닉네임은 선택. ID는 신원으로 역추적 불가.
- README에 "무엇을 수집/미수집하는지" 명시. **옵트인** 성격 강조.

### 보안 / 어뷰징
- `/track`에 **rate-limit** (예: userId·IP당 분당 N건 상한). → `hi` 도배 완화.
- 카운트 인정 **최소 글자 수** 임계값(선택).
- **한계 인지**: 훅은 클라이언트에서 돌아 값 위조가 원천 차단은 아님. 재미용엔 충분, 상금 랭킹으로 가면 검증 장치 추가 필요.
- 닉네임 비속어 필터 + 유일성.

---

## 10. 마일스톤 / 로드맵

| 단계 | 내용 | 산출물 |
|------|------|--------|
| **M0** | 설계 확정 (이 문서) | DESIGN.md 합의 |
| **M1** | 백엔드 스켈레톤 | Worker + D1 스키마 + `/track` `/leaderboard` (테스트 데이터) |
| **M2** | 수집 플러그인 | `UserPromptSubmit` 훅, 익명 ID, `/register` 닉네임 |
| **M3** | 리더보드 웹 | Claude 디자인, 일·주·주말 탭 (실데이터 연동) |
| **M4** | 한반도 시각화 | 국내 무대/지도 |
| **M5** | 지구본 + 국가 랭킹 | 글로벌 확장 |
| **M6** | 어뷰징 방어·배포 | rate-limit 강화, 배포/설치 문서 |

---

## 11. 결정 사항

### ✅ 확정
- **지역 범위(MVP)**: 국가 단위(`cf.country`)까지만. 시/도는 후속. (§8.3)
- **지도 시각화 연기**: 한반도/지구본은 후속 페이즈로. Phase 1 시안에서 제거(개념만 기록). (§8.3)
- **신원/로그인**: 전통 로그인 없음. 익명 `userId` = 신원 겸 비밀키, 닉네임 선택 등록. (§4.4)
- **디자인 톤**: 차분한 유틸리티 지향 — 채도 낮춘 clay 단일 강조, e스포츠식 과장(골드·레이더·펄스) 배제. (§8.2)
- **이름**: "Open Code War"(OCW) 유지 권장. (§12 근거)

### ⬜ 다음 논의
1. **도메인**: OCW 리더보드 웹 주소.
2. **닉네임 등록 방식**: 슬래시 커맨드(A) vs 웹 클레임(B) vs 둘 다.
3. **어뷰징 정책 강도**: rate-limit 수치, 최소 글자 수 임계값 도입 여부.
4. **훅 스크립트 배포 형태**: Node 스크립트 번들 vs 최소 셸. (크로스플랫폼)
5. **글자 수 세는 기준**: 유니코드 코드포인트 vs 자소 클러스터(이모지·조합).

---

## 12. 확장 비전 (Phase 2+)

리더보드(Phase 1)는 **훅이자 성장 엔진**이다. 그 위에 커뮤니티·채용 레이어를 얹는다.

- **코더 프로필 / 자기소개**: 닉네임 위에 자기소개·기술 스택·링크(GitHub 등). 리더보드 순위가 곧 "활동 증명 배지".
- **구직 (코더 → 일자리)**: 코더가 "구직 중" 상태와 희망 조건을 프로필에 노출.
- **구인 (회사 → 코더)**: 회사/팀이 공고를 올리고, 리더보드 상위·활동 코더에게 접근.
- **핵심 논리**: OCW의 입력 랭킹 = **채용 시장에서 신뢰 가능한 활동/실력 신호**. 게임으로 모으고, 프로필·채용으로 남긴다.
- ⚠️ 채용 레이어로 가면 **실명/검증(로그인·OAuth)·개인정보·어뷰징 방지**가 훨씬 중요 → 그 시점에 신원 2단계로 승격. (§4.4)

### 이름 추천 — "Open Code War" 유지
- 장점: 게임 훅에 강렬·기억성, 이미 폴더/컨셉과 일치, 개발자 정서(경쟁·밈)와 맞음.
- 우려: 채용 레이어의 "프로페셔널" 톤과 'War'가 충돌 가능.
- 결론: **브랜드는 OCW 유지**, 채용 레이어는 하위 서비스로 수용(예: "OCW Careers"). "War"는 리더보드 서브브랜드로 남김.

---

## 13. 아키텍처 · 비용 노트 (캐싱 / 쓰기 절감)

### 무료 플랜 한도 (기록, 사용자 제공)
| | 읽기 | 쓰기 | 저장 |
|---|---|---|---|
| **D1 Free** | 500만 행 / **일** | 10만 행 / **일** | 최대 5 GB |
| **KV Free** | 10만 요청 / **일** | 1천 요청 / **일** (쓰기·삭제·list) | 최대 1 GB |

- **핵심 제약: KV 쓰기 1천/일**. → 캐시는 **자주 못 쓴다**. 배치 갱신(예: 30분)엔 적합, 요청/분당 갱신엔 부적합.
- D1은 **행 단위 과금** — 캐시 없는 리더보드는 스캔한 행만큼 읽기 소모.

### 결정: 리더보드는 실시간이 아니라 **배치 집계 스냅샷**
- **운영 30분 / 로컬 테스트 1분** 간격으로 사전 집계. (로컬은 quota 없음 → 1분 OK. 운영에서 1분이면 KV 쓰기 1천/일 초과하므로 30분.)
- 방식: **Cron Trigger**가 (board × metric) top-N을 계산해 스냅샷 저장(KV 또는 D1 `leaderboard_snapshots` 테이블). `/leaderboard`는 스냅샷만 읽음.
  - KV 쓰기: 6키(3보드×2지표) × 48회/일 = **288/일 < 1천** ✓
  - `/leaderboard` 읽기: KV get (10만/일 여유) → D1 안 건드림.
  - UX: "N분마다 갱신 · 집계 시각 HH:MM" 표기.
- 대안/보완: **Cache API 엣지 캐시**(TTL=간격) — cron·KV 없이 응답 캐시. PoP별·miss 시 D1 1회. 더 단순.

### 쓰기 절감 (프롬프트당 ~6행 → ~2–3행)
1. **`last_seen_at` 매 track 쓰기 제거** — 가장 쉬운 큰 절감(하루 1회 이하로).
2. **인덱스 최소화** — 인덱스도 "쓴 행"에 포함. 읽기에 꼭 필요한 것만.
3. **`events` 원시 적재 재고** — 리더보드는 `daily_stats`만 있으면 됨. 감사 불필요하면 events 생략/샘플링/보존기간(프루닝).
4. `daily_stats` upsert는 유지(집계 핵심).

### 남은 것
- Cron + 스냅샷(또는 Cache API) 구현, 웹에 "집계 시각" 표기, 간격 env화(운영 30m/테스트 1m).

---

## 14. 로그인 / 계정 연동 (Google OAuth) — 설계

> §4.4 "로그인 없음"을 대체하는 **선택적** 계정 연동. 비로그인(익명)은 현행 그대로 유지된다.

### 14.1 목표 / 비목표

**목표**
- **계정 복구** — 로컬 config(userId) 유실 시 Google 로그인으로 되찾기. 현재 가장 아픈 문제.
- **멀티 기기 합산** — 회사/집 기기를 한 계정으로.
- **소유권** — 닉네임·프로필이 계정에 귀속. (웹 "email: Available after sign-in" 자리)

**비목표**
- 사용량 위조 방지 (§14.6 — 로그인은 신원 증명이지 정직성 검증이 아님)
- 로그인 강제 — 익명 참가는 계속 1급 시민. 진입장벽 없음이 이 서비스의 생명.
- 웹 세션 / 웹 프로필 편집 — 2단계. (콜백에서 쿠키만 심어두면 확장 가능)

### 14.2 원칙: 진입점은 플러그인, 브라우저는 OAuth 동의에만

- **wrangler 스타일 로컬 콜백 서버(localhost 리슨)는 만들지 않는다.** 슬래시 커맨드는 단명 프로세스라 브라우저 완료를 기다릴 수 없다.
- 대신 `gh auth login` 스타일 **링크 코드** 방식 — CLI는 URL만 출력하고, OAuth 콜백은 Worker가 받는다.
- **로컬에 Google 토큰을 저장하지 않는다.** 자격증명은 지금처럼 userId 하나. Google 연동은 "이 userId의 주인" 증명·복구 수단일 뿐이다.
  → 별도 auth 관리 CLI 불필요. 기존 ocw-cli에 `signup` 서브커맨드 + config 필드 추가로 충분.

### 14.3 플로우

```
/ocw signup
  → POST /auth/start {userId}
      서버: 링크 코드 발급 (KV, TTL 10분, 1회용, userId 바인딩)
      CLI:  config.pendingLinkCode 저장 + URL 출력
브라우저: GET /auth/link/<code>
  → 302 Google OAuth (state = code + nonce)
  → GET /auth/callback: 코드 교환 → id_token(google_sub, email)
      - 연동 확인 페이지: "닉네임 <X> 계정에 이 Google 계정을 연동합니다" [확인]  ← link-jacking 방지
      - accounts upsert + KV에 결과 기록 → 완료 페이지 ("터미널로 돌아가세요")
다음 /ocw 명령(또는 track 훅) 실행 시:
  → pendingLinkCode 있으면 GET /auth/status?code
      done → (필요시) userId 교체 + 병합 결과 안내, 코드 삭제
      만료 → 안내 후 코드 삭제
```

폴링 없음 — 슬래시 커맨드 특성(단명, 4초 타임아웃)에 맞춘 "다음 실행 시 해소(pendingLinkCode)" 패턴.

### 14.4 "옮겨 타기" 두 케이스

| 케이스 | 서버 | CLI |
|---|---|---|
| **첫 가입** (google_sub 신규) | accounts에 (google_sub → 현재 userId) 저장 | 변화 없음 — 데이터 이동 없이 소유권만 계정에 귀속 |
| **기존 계정 재로그인** (다른 기기/재설치) | canonical userId 반환. 로컬 익명 사용량 있으면 일회성 병합: events·daily_stats를 canonical로 UPDATE/합산, 옛 users 행 삭제, 프로필 충돌은 canonical 우선 | config.userId를 canonical로 교체 → 이후 훅도 자동으로 새 userId로 집계 |

병합은 자동 + 결과 안내("두 기록을 합쳤습니다: +N 프롬프트"). 슬래시 커맨드는 대화형 확인이 불가하다.

### 14.5 스키마 / 엔드포인트 / 설정

```sql
-- 0009_accounts.sql
CREATE TABLE accounts (
  account_id TEXT PRIMARY KEY,        -- 'acc_' + random
  google_sub TEXT UNIQUE NOT NULL,
  email      TEXT,
  user_id    TEXT NOT NULL,           -- canonical (users.user_id)
  created_at INTEGER NOT NULL
);
```

| 엔드포인트 | 역할 |
|---|---|
| `POST /auth/start` {userId} | 링크 코드 발급 → {code, url, expiresAt} |
| `GET /auth/link/:code` | 302 → Google OAuth |
| `GET /auth/callback` | 코드 교환·검증 → 연동 확인/완료 페이지 |
| `GET /auth/status?code` | CLI가 다음 실행 때 결과 조회 → {status, canonicalUserId?, email?, merged?} |

- `GOOGLE_CLIENT_ID`(vars) / `GOOGLE_CLIENT_SECRET`(wrangler secret), redirect URI `https://opencodewar.dev/auth/callback`
- id_token 검증: token 엔드포인트에서 TLS로 직접 수신하므로 서명(JWKS) 검증은 생략하고 `aud`·`iss` 확인만 (MVP 기준 안전).

### 14.6 보안 / 악용 분석 (솔직한 한계)

- **사용량 위조는 로그인과 무관하게 여전히 가능.** 훅이 클라이언트에서 돌므로 자기 userId로 `/track`을 curl 호출하면 그만이다. 현재 방어: IP당 60건/분 rate limit + 이벤트당 chars ≤ 20,000 클램프 → **상한 내 조작(이론상 하루 86,400 프롬프트)은 막지 못한다.** 자가 보고 리더보드의 본질적 한계(WakaTime 등 동일). 재미용 스코프에서는 수용, 상금·보상이 걸리면 서명 클라이언트/이상치 탐지 필요.
- **다중 계정** — 익명 참가 허용이므로 계정 무한 생성 가능(현행과 동일).
- **link-jacking** — 공격자가 자기 링크 URL을 피해자에게 클릭시키면 피해자의 Google이 공격자 userId에 연동될 수 있다 → 콜백에서 자동 연동하지 않고 **확인 페이지**(연동 대상 닉네임 표시 + 명시적 버튼)를 거쳐 완화.
- **코드 브루트포스** — 코드 엔트로피 ≥ 64bit, 1회용, TTL 10분, 시도 rate limit.
- **병합 악용** — 타인 데이터 병합은 그 userId(비밀키) 없이는 불가.

### 14.7 구현 순서

1. `0009_accounts.sql` 마이그레이션
2. Worker auth 라우트 4개 + 병합 로직 (+ 테스트)
3. Google Cloud OAuth 클라이언트 생성 + secret 등록
4. CLI `signup`(별칭 `login`) + pendingLinkCode 해소 + status에 연동 상태 표시
5. 연동 확인/완료/에러 웹 페이지

### 14.8 결정 사항 (2026-07-23 확정)

- ✅ **Google 로그인 도입 확정** — 위 설계대로 구현·배포. OAuth 클라이언트는 GCP `opencodewar` 프로젝트,
  동의 화면 "Open Code War"(외부·프로덕션 게시됨, scope: openid email).
- ✅ 명령 이름: `signup` (별칭 `login`).
- ✅ 프로필 이메일 공개는 **옵트인** — `/ocw email public|private`(기본 private, accounts.email_public).
  비공개면 본인 status 에만 표시되고 공개 API(/user)·웹 상세에는 나가지 않는다.
- ✅ `/ocw delete all` 은 accounts(Google 연동)도 함께 삭제.
- ⬜ 연동 해제 `/ocw unlink` — 보류.

**어뷰징 조사 결론(2026-07-23)**: 개인(Pro/Max) 유저의 실사용을 제3자가 검증할 Anthropic API·OAuth·서명은
존재하지 않음(Analytics API 는 Team/Enterprise org admin 전용). statusline 광고 플랫폼들(ADtention·
Claude Code Ads·Kickbacks — 실제 돈이 걸림)도 암호학적 검증 없이 서버측 카운팅 + 휴리스틱 + 지급 보류로
운영. 즉 완전 차단은 현재 불가 → 로그인(밴 지속성) + §14.6 억제책이 실질 상한. Anthropic 이 개인 usage
OAuth 를 열면 그때 "verified" 트랙 추가.

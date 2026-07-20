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

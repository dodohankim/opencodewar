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
-- 유저 상세(/user·/user/hours)의 유저별 events 조회용. 0002 에서 제거했다가 0011 에서 복구.
CREATE INDEX idx_events_user_time ON events(user_id, created_at);
-- (idx_events_time — 전역 시간축 인덱스는 조회처가 없어 0002 에서 제거, 미복구)

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

### 7.1 UTC 기준 날짜 (공용 시계)
- 리더보드의 "하루"는 전 세계가 동일해야 공정하므로 **UTC** 로 끊는다. 서버 수신 epoch ms `ts`:
  `dayUTC = new Date(ts).toISOString().slice(0,10)` (코드: `time.ts`의 `utcToday`)
- 개인 상세 페이지만 프로필 주인 로컬 TZ 로 재집계한다(`tz.ts`). 스트릭(§17)도 UTC 를 쓴다.

### 7.2 구간 정의
- **일간**: `day = 오늘(UTC)`
- **주간**: 이번 주 월~일 (UTC). `WHERE day BETWEEN 월요일 AND 일요일 GROUP BY user_id`
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

### 7.3 랭킹 항목의 대표 프로젝트 (`project`)

리더보드 행마다 **대표 프로젝트 1개**를 같이 실어 보낸다 — 순위표가 명함첩으로도 읽히게
(§12 확장 비전, "터미널 개발자 SNS"). `RankEntry.project = { name, url? } | null`.

- 고르는 규칙(`pickMainProject()`, `snapshot.ts`): `projects` 배열에서 **`main: true` 인 항목**,
  없으면 **첫 항목**. 유저 상세의 shipping 목록 맨 위에 오는 것과 **같은 프로젝트**다.
- `desc` 는 싣지 않는다(리더보드에서 안 쓴다 → 스냅샷 크기 절감).
- `url` 이 http(s) 절대 URL 이 아니면 **이름만** 남긴다. `name` 이 없으면 항목 자체를 `null`.
- 쿼리는 `u.projects` 를 SELECT + GROUP BY 에 추가(글로벌·구역 랭킹 둘 다). 조인 키가 user_id 라
  그룹 안에서 항상 동일한 값이다.
- 스냅샷 스키마가 바뀌므로 `SNAPSHOT_KEY` 를 **v3** 으로 올렸다(배포 즉시 재빌드 유도).
- 웹은 `coder` 오른쪽 `shipping` 열에 이름을 렌더하고, `url` 이 있으면 이름 자체를 링크로
  건다 — **아웃바운드라 `?ref=opencodewar`** (§18). 미등록 유저는 `–` 를 남겨
  "여기에 내 프로젝트를 걸 수 있다"가 보이게 한다.

---

## 8. 프론트엔드 / 웹

### 8.1 화면
1. **리더보드 메인**: 탭 `일간 / 주간 / 주말` × 지표 토글 `프롬프트수 / 글자수`.
   - 순위, 닉네임(없으면 "익명 코더"), 대표 프로젝트(`shipping`, §7.3), 프롬프트 수, 글자 수, 국가 뱃지.
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
2. **인덱스 최소화** — 인덱스도 "쓴 행"에 포함. 읽기에 꼭 필요한 것만. (0002 에서 events 인덱스 전부 제거 → 0008부터 유저 상세가 events 를 유저별 조회하게 되어 0011 에서 `idx_events_user_time` 만 복구. 없으면 상세 1회 열람 = events 전체 rows_read 과금.)
3. **`events` 원시 적재 재고** — 리더보드는 `daily_stats`만 있으면 됨. 감사 불필요하면 events 생략/샘플링/보존기간(프루닝).
4. `daily_stats` upsert는 유지(집계 핵심).

### 읽기 지연 (D1 왕복 최소화)
- D1 은 쿼리마다 네트워크 왕복(실측 ~150–200ms). 순차 `await` N번 = N×왕복이 그대로 TTFB 에 얹힌다.
- **유저 상세 `/user`**: 프로필·이메일·이벤트·일별 집계 4쿼리를 `DB.batch()` 하나(단일 왕복)로. 부속 쿼리는 `user_id` 를 `(SELECT user_id FROM users WHERE …)` 서브쿼리로 재조회. `/user/hours` 도 동일(TZ 를 모르는 채 넉넉한 UTC 창으로 뽑고 응답 후 정확한 로컬 하루로 필터).
- **`/u/<nick>` HTML**: 에셋 fetch 와 OG 메타용 D1 조회를 병렬(`Promise` 동시 시작).

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
- ~~웹 세션 / 웹 프로필 편집 — 2단계~~ → **§14.9 로 구현 완료(2026-07-26)**

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

### 14.9 웹 로그인 / 마이페이지 / 프로필 편집 (2026-07-26)

§14.1 에서 "2단계"로 미뤄뒀던 것. **터미널을 안 켜고도 가입·로그인·프로필 수정이 되게** 하는 게 목적이다
(플러그인만이 유일한 진입점이면 명함첩(§ 제품방향)으로서의 문턱이 너무 높다).

#### 자격증명이 두 갈래가 된다

| | CLI | 웹 |
|---|---|---|
| 주체 확인 | 요청 body 의 비밀 `userId` | HttpOnly 쿠키 세션(`ocw_sess`) |
| 엔드포인트 | `/track` `/register` `/profile` `/account` | `/api/nickname` `/api/profile` `/api/account` |

**웹에는 `userId` 를 절대 내려보내지 않는다.** `userId` 는 `/track` 권한까지 가진 bearer 비밀키라, 한 번
브라우저 JS 에 노출되면 XSS 하나로 계정이 통째로 털린다. 그래서 `/api/session` 응답에도 없고, 웹이
"이게 내 페이지인가"를 판단할 땐 공개 slug(`publicId`)를 비교한다.

`/api/*` 는 CLI 엔드포인트와 검증·저장 로직을 공유한다(`setNickname` / `updateProfile` / `setEmailPublic`
를 추출해 양쪽이 호출). 주체를 어디서 얻느냐만 다르다.

#### 세션

- KV `sess:<hex32>` → `{userId, googleSub, email, createdAt}`, TTL 30일.
- 쿠키 `ocw_sess`: `HttpOnly; Secure; SameSite=Lax; Path=/`.
- CSRF 방어 2겹: SameSite=Lax(크로스사이트 POST 에 쿠키 미포함) + `/api/*` 상태변경 요청의 `Origin` 검사.
- `json()` 이 붙이는 `Access-Control-Allow-Origin: *` 는 credentials 와 함께 못 쓰이므로(브라우저가 거부)
  외부 사이트가 남의 세션으로 `/api/session` 을 읽을 수 없다. `Allow-Credentials` 는 **붙이지 않는다.**

#### 플로우

```
GET /auth/login?next=/u/foo
  → KV authweb:<code> = {nonce, next}, TTL 10분, 1회용
  → 302 Google (state = 'web.<code>.<nonce>')
GET /auth/callback            ← CLI 연동과 같은 redirect_uri 를 공유한다
  state 가 'web.' 로 시작 → 웹 로그인, 아니면 CLI 연동(§14.3)
  accounts 에 google_sub 있음 → 그 user_id 로 세션
                     없음 → 웹 단독 가입: users+accounts 신규 생성
  → Set-Cookie + 302 (기존 유저는 next, 신규는 /u/<public_id>?setup=1)
```

- **redirect_uri 를 하나로 유지**한 건 GCP 콘솔에 등록된 URI 가 `/auth/callback` 하나뿐이기 때문이다.
  플로우 구분은 `state` 접두사로 한다 → **콘솔 설정 변경 없이 배포 가능.**
- **link-jacking 확인 페이지(§14.6)가 여기엔 없다.** 저건 "이미 있는 남의 익명 userId 에 내 Google 을
  붙이는" 상황을 막는 장치인데, 웹 로그인은 붙일 대상 자체가 없다(브라우저에서 시작해 브라우저에서 끝난다).
- `next` 는 내부 경로만 허용(`/` 로 시작 + `//`·`/\` 금지) — open redirect 차단.

#### 웹 단독 가입 (CLI 미설치자)

`newWebUserId()` 가 플러그인과 **같은 36자 형식**(`ocw_` + hex32)으로 발급한다. 이 값이 나중에 CLI
`/ocw signup` 의 canonical userId 가 되어 `config.userId` 에 들어가므로, `isValidUserId`(≤64자)를
통과하지 못하면 그 기기의 `/track` 이 전부 400 이 된다 — `test/session.test.ts` 가 이걸 지킨다.

기록은 0에서 시작하고, 나중에 그 사람이 CLI 를 깔고 `/ocw signup` 하면 기존 병합 로직(§14.4)이 기기
사용량을 이 계정으로 합쳐준다.

#### 웹 UI

- 타이틀바: 미로그인 `로그인` / 로그인 시 `◆ <닉네임>` → 메뉴(내 프로필 · 로그아웃).
- 마이페이지는 **별도 화면이 아니라 자기 프로필의 인라인 편집**이다 — 내 `/u/<nick>` 에서만 `✎ 편집`
  버튼이 뜨고, 누르면 프로필/shipping 박스가 폼으로 바뀐다. 보이는 화면 = 남이 보는 화면이라 미리보기가 필요 없다.
- 편집 항목: 닉네임 · 직함 · 소속 · 도시 · 자기소개 · 링크 5종 · shipping 5개(메인 1개) · 이메일 공개 여부.
- 갓 가입한 사람은 `?setup=1` 로 돌아와 폼이 자동으로 펴지고 닉네임부터 묻는다. 저장 후 주소는
  `/u/<닉네임>` 으로 갈아끼우고 `?setup=` 은 떨군다.
- 닉네임만 별도 요청(`/api/nickname`)인 이유는 유일성 충돌(409)을 따로 처리해야 하기 때문.

#### 안 한 것

- 웹에서의 계정 삭제(`/delete` 웹판) — CLI `/ocw delete all` 만 있다.
- 연동 해제, 세션 목록/원격 로그아웃.

### 14.10 리더보드 모수를 users 로 바꾼 이유 (2026-07-26)

웹 가입자는 events 가 0건이라 `daily_stats` 에 행이 없다. 그런데 리더보드·순위 쿼리가 전부
`daily_stats` 를 드라이빙 테이블로 쓰고 있어서, **가입만 한 사람은 보드에서 통째로 사라졌다.**
가입 직후 자기 이름이 어디에도 없는 건 §14.9(진입장벽 낮추기)를 정면으로 깨뜨린다.

모수를 `users` 로 뒤집었다 — `FROM users u LEFT JOIN daily_stats s ON s.user_id = u.user_id AND <기간>`.

- **기간 조건은 WHERE 가 아니라 JOIN 의 ON 에 둔다.** WHERE 로 내리면 LEFT JOIN 이 INNER 로 무너져
  (그 기간에 행이 없는 유저가 탈락) daily 보드에서 다시 0인 사람이 사라진다. 이게 이 변경의 유일한 함정.
- 동점(특히 0점) 정렬은 `created_at ASC` — 먼저 온 사람이 위. user_id 순이면 사실상 무작위다.
- `LIMIT 100` 은 그대로라 규모가 커져도 스냅샷 크기는 안 변한다. 활동자가 100명을 넘으면 0점은
  자연히 밀려난다 — "보드가 한산할 때만 신입이 보인다"는 원하는 동작 그대로.

**같이 바꾼 것 — 모수가 어긋나면 안 되는 곳들.** 보드에는 14위로 서 있는데 자기 프로필엔 순위가
없으면 버그로 읽힌다.

| 위치 | 무엇 |
|---|---|
| `snapshot.ts` `computeRanking` / `computeZoneRanking` | 글로벌·구역 보드 |
| `handlers.ts` `handleUser` | 프로필의 전체·국가 순위 |
| `handlers.ts` `handleMe` | CLI `/ocw status` 순위·구역 |
| `og.ts` `handleProfilePage` | 공유 미리보기 설명의 "#N on the board" |
| `handlers.ts` `handleZones` | 구역 드롭다운 — `EXISTS(daily_stats)` 조건 제거(없으면 드롭다운에 없는 국가에 사람만 서 있게 된다) |

`briefing.ts` 는 스냅샷을 그대로 읽으므로 자동으로 따라온다. `SNAPSHOT_KEY` 는 v3 → **v4** 로 올려
배포 즉시 재빌드되게 했다(안 올리면 최대 5분간 옛 스냅샷이 나간다).

웹 가입 시 `users.country`·`users.timezone` 을 `request.cf` 에서 채운다 — `/track` 은 이벤트마다
채우지만 이 사람에겐 이벤트가 없다. 안 넣으면 보드에 국기 없이 서고 상세 페이지가 UTC 로 떨어진다.
국가는 `visitorCountry()` 를 거친다(`XX`·`T1` 같은 판별 실패값이 국기로 뜨면 안 된다).

`/track` 의 users 업서트도 `DO NOTHING` → **비어 있을 때만 채우는 조건부 DO UPDATE** 로 바꿨다.
안 그러면 country 가 NULL 인 채로 가입한 사람은 이후 아무리 쳐도 NULL 이라 국가·도시 구역 보드에서
영영 안 보인다. `WHERE users.country IS NULL OR users.timezone IS NULL` 덕에 값이 이미 있는
절대다수 요청에서는 쓰기가 발생하지 않아 쓰기 절감(§13)은 유지된다.

### 14.11 국가(cc)를 유저가 직접 고를 수 있게 (2026-07-26)

IP 판정은 VPN·이주·오탐으로 틀릴 수 있고, 웹 가입자는 아예 비어 있을 수도 있다. 프로필 편집에
국가 셀렉트를 넣고 `country` 를 `/profile`·`/api/profile` 이 받는 필드로 승격했다(빈 값 = 해제).

- 목록은 ISO 3166-1 alpha-2 코드 배열 하나만 두고, **표시 이름은 `Intl.DisplayNames`** 로 현재
  언어에 맞춰 뽑는다(국가명 사전을 들고 다니지 않는다). 국기는 코드에서 유도(`flagOf`).
  언어를 바꾸면 라벨만 다시 그리고 고른 값은 유지한다.
- **네이티브 `<select>` 가 아니라 검색되는 콤보박스다.** 249개를 첫 글자 점프로 찾는 건 고문이고,
  `<datalist>` 는 브라우저 기본 팝업이라 터미널 톤이 깨진다. 그래서 input + 필터 리스트를 직접 만들었다.
  - 검색어는 **현지어 이름·영어 이름·코드** 셋 다에 걸린다 — 한국어로 보면서 `korea`/`KR` 로 찾는
    사람이 반드시 있다.
  - 팝업 선택은 `click` 이 아니라 **`mousedown`** 으로 받는다. blur 가 먼저 돌면 팝업이 사라져 클릭이 죽는다.
  - blur 시 입력창 텍스트를 **확정된 코드의 라벨로 되돌린다** — 자유 입력을 남기지 않는다(정본은 `ccCode`).
- **목록에 코드 배열을 249개 전부 넣는다(속령 포함).** 주권국만 넣으면 Cloudflare 가 주는 `PR`·`RE`·
  `GP`·`GU` 같은 코드가 라벨을 못 찾아 입력창이 빈칸으로 보이고, **그 유저가 편집만 열었다 저장해도
  국가가 지워진다.** 그래도 목록이 뒤처질 수 있으니 `ccLabel` 은 미상 코드를 `국기 + 코드` 로 폴백한다.
- 리더보드의 국가 표시를 `COALESCE(MAX(s.country), u.country)` → **`COALESCE(u.country, MAX(s.country))`**
  로 뒤집었다. `users.country` 가 이제 유저가 고치는 정본이고 프로필 페이지도 그 값을 보여준다 —
  안 뒤집으면 "고쳤는데 보드에선 안 바뀐다"가 된다. daily_stats 는 users 가 빌 때의 폴백.
- 스냅샷은 5분 주기로 재빌드되므로 국가 변경은 최대 5분 뒤 보드에 반영된다(닉네임처럼 즉시
  무효화하지는 않는다 — 저빈도 변경이라 재빌드 비용을 아끼는 쪽).

닉네임(웹 라벨은 리더보드 열과 맞춰 **coder**)은 편집 폼에서 필수다 — `*` 표시 + `required`,
2~20자를 통과하지 못하면 저장이 막힌다. 가입 직후 `?setup=1` 폼도 같은 규칙을 쓴다.

### 14.12 이름 미정 상태를 어떻게 다루나 (2026-07-26)

가입 직후 `?setup=1` 폼을 저장하지 않고 나가면 닉네임 없는 계정이 남고, 보드엔 자동 이름
(`BigBee94`)으로 뜬다. **막지 않기로 했다** — 이탈을 강제로 차단하는 건 §14.1 "진입장벽 없음"과
어긋나고, 어차피 주소창으로 나가면 그만이라 강제력도 반쪽이다. 대신 계속 상기시킨다.

- 로그인 + 닉네임 미등록이면 화면 최상단(`.echo` 바로 아래)에 호박색 배너가 상시 뜬다.
  **리더보드·프로필 양쪽 공통 위치**라 어디로 도망가도 따라온다. 타이틀바 계정 버튼도 같이 물든다.
- 배너의 「이름 정하기」는 내 프로필로 이동한 뒤 편집 폼을 setup 모드로 편다. 다른 화면에 있었으면
  프로필 로딩이 끝난 뒤에 열려야 하므로 `pendingSetup` 플래그로 `renderUser` 시점까지 미룬다.
- 편집 중에는 배너를 감춘다(폼 자체가 안내라 중복).
- 저장되어 `registered=true` 가 되는 순간 배너와 호박색 표시가 함께 사라진다.

닉네임을 안 정했다고 리더보드에서 빼지는 **않는다** — §14.10 에서 "가입만 한 사람도 보이게" 한 것과
정면으로 충돌한다.

---

## 15. 언어 (i18n) — 기본 언어 자동 판정

웹은 영어/한국어 두 벌을 한 파일 안에 갖고 있다(`web/index.html` 의 `T` 사전, `privacy.html` 은
`#en`/`#ko` 블록). 바뀐 건 **어떤 언어로 시작할지**를 정하는 규칙이다.

### 15.1 판정 순서

| 순위 | 신호 | 결과 |
|------|------|------|
| 1 | `?lang=ko\|kr\|ko-KR\|en` | 그대로 적용 + "직접 선택"으로 저장 |
| 2 | 직접 고른 값 (`ocw_lang_manual='1'`) | 저장된 언어 |
| 3 | **접속 국가** (Cloudflare `cf.country`) | `KR` → 한국어, 그 외 → 영어 |
| 4 | 국가를 모를 때만 브라우저 언어 | `ko-*` → 한국어, 그 외 영어 |

3순위가 있으므로 **국가를 아는 한 브라우저 언어는 보지 않는다** — 미국 접속이면 브라우저가 한국어여도
영어. "한국이면 한국어, 그 외는 영어"를 그대로 지킨다. 4순위는 로컬 개발·Tor 등 국가 미상일 때만.

### 15.2 국가는 어떻게 웹까지 오나

`cf.country` 는 Worker 만 볼 수 있으므로, Worker 가 HTML 을 서빙할 때
`<meta name="ocw-country" content="">` 에 값을 심는다(`og.ts` 의 `visitorCountry` / `withVisitorCountry`).
`<head>` 의 판정 스크립트가 첫 페인트 전에 이 값을 읽어 언어를 정한다 → 추가 왕복도, 영어가 번쩍했다가
한국어로 바뀌는 깜빡임도 없다.

- 대상 경로: `/`, `/u/<nick>`, `/privacy` — 셋 다 `assets.run_worker_first` 또는 Worker 폴백으로 도달.
- 그 외 정적 파일(favicon·og.png)은 Worker 를 타지 않는다(캐시 그대로).
- 국가가 섞인 HTML 은 방문자마다 다르므로 `Cache-Control: private, max-age=0, must-revalidate` —
  공유 캐시(CDN)에 담겨 다른 나라 사람에게 나가는 사고를 막는다.

### 15.3 저장 규칙

- **자동 판정 결과는 저장하지 않는다.** 저장해 버리면 국가 판정이 영영 안 먹는다.
- 직접 토글하거나 `?lang=` 로 들어왔을 때만 `ocw_lang` + `ocw_lang_manual='1'` 저장.
- 구버전은 자동 판정값까지 `ocw_lang` 에 저장했으므로 `ocw_lang_manual` 이 있을 때만 신뢰한다
  (기존 방문자도 국가 기반 자동 판정을 새로 받게 된다).
- 토글하면 주소의 `?lang=` 도 현재 언어로 맞춘다 → 링크를 복사하면 언어까지 그대로 공유된다.

### 15.4 남은 것

- ⬜ `?lang=ko` 변형의 SEO(hreflang + 자기참조 canonical) — 지금은 canonical 이 항상 `/` 라
  검색엔진에는 영어판만 색인된다. 한국어 유입을 노릴 때 검토.

## 16. 계급 (Rank) — 픽셀 병정 진행 시스템

전쟁 컨셉의 리텐션 장치. **전 기간 누적 prompts** 기준으로 한국군식 12계급을 부여한다.
지표가 리더보드 기본 지표와 같아 설명이 필요 없고, `/track` 레이트리밋(분당 60건)이
어뷰즈 상한을 겸한다. 누적 기준이므로 강등은 없다.

### 16.1 계급표 (단일 원본 — 웹 `index.html`·OG `og-user.html` 의 RANKS 상수는 이 표를 따른다)

| 계급 (KO/EN) | 계급장 | 필요 누적 prompts |
|---|---|---|
| 이병 Private | 작대기 1 | 0 |
| 일병 PFC | 작대기 2 | 200 |
| 상병 Corporal | 작대기 3 | 1,000 |
| 병장 Sergeant | 작대기 4 | 3,000 |
| 하사 Staff Sgt | 갈매기 1 | 7,000 |
| 중사 Sgt 1st Class | 갈매기 2 | 15,000 |
| 상사 Master Sgt | 갈매기 3 | 30,000 |
| 소위 2nd Lt | 다이아 1 | 60,000 |
| 대위 Captain | 다이아 2 | 120,000 |
| 소령 Major | 다이아 3 | 250,000 |
| 대령 Colonel | 다이아 4 | 500,000 |
| 장군 General | 별 | 1,000,000 |

- 곡선 설계: 초반은 며칠 만에 승급(가입 직후 재미), 이후 구간마다 ~2배 — 헤비유저(일 100건)
  기준 병장까지 한 달, 장군은 전설의 영역.
- 데이터: `/user` 응답의 `allTime.prompts` (daily_stats 전체 SUM). 계급 계산은 클라이언트.
- 노출: 프로필(계급 칩 + 다음 계급 게이지), OG 카드(계급 칩). 리더보드 행에는 넣지 않는다
  (1위 깃발 퍼레이드와 역할 중복). 계급명은 KO/EN i18n.
- 픽셀 계급장: 병=작대기·부사관=갈매기·장교=다이아·장군=별, 색은 `--ok`(초록) 단색.

---

## 17. 스트릭 (연속 기록) — UTC 기준

리텐션 장치. **UTC 하루** 단위로 "친 날(qualifying day)"을 세어 연속 일수를 매긴다.
리더보드(§7)·계급(§16)과 같은 공용 UTC 시계를 써서 "하루" 정의가 전 기능에서 하나로 통일된다.
개인 상세의 로컬 TZ 재집계(`tz.ts`)와는 무관 — **스트릭은 로컬 보정하지 않는다**.

### 17.1 "친 날" 조건 (2026-07-24 확정)

한 UTC 날짜가 스트릭에 포함되려면 그 날 **두 조건을 모두(AND)** 만족해야 한다:

| 조건 | 값 | 집계 |
|---|---|---|
| 프롬프트 수 | **10개 이상** (`≥ 10`) | `SUM(prompts)` |
| 총 글자수 | **500자 초과** (`> 500`, 500은 미달) | `SUM(chars)` |

- AND 결합이 핵심: 프롬프트 10개만으로는 "응/ok/continue" 10번 farming 이 되지만,
  총 500자 초과 게이트가 그런 *전부-사소한-프롬프트* 세션을 걸러낸다.
- 집계 출처는 `daily_stats`. 단 이 테이블은 `(user_id, day, agent)` 단위라
  하루 판정은 **agent 합산**이 필요하다: `GROUP BY user_id, day` 후 SUM 비교.
- 긴 텍스트 붙여넣기로 글자수는 뚫릴 수 있으나, 재미 기능 범위에서 허용한다.

### 17.2 연속(current streak) 정의

- `Q` = 위 조건을 만족하는 UTC 날짜 집합.
- **현재 스트릭** = 오늘(UTC)로 끝나는 `Q`의 연속 길이. 단 오늘이 아직 조건 미달이면
  "진행 중"으로 보아 어제까지의 연속을 유지한다 → 마지막 친 날이 **오늘 또는 어제**면 살아있고,
  **이틀 전 이하**면 스트릭은 `0`으로 끊긴다.
- **최장 스트릭(longest)** = 역대 `Q`의 최대 연속 길이. (선택 노출)

### 17.3 계산 & 노출

- 계산(서버, `/user` 핸들러): 유저의 `(day, SUM(prompts), SUM(chars))` 목록을 뽑아 조건 통과
  날짜만 남긴 뒤, day-number(UTC) 연속성으로 런길이를 잰다. 결과를 `/user` 응답에 포함.
- 노출: 프로필 상세(🔥 N일), OG 카드. 리더보드 행에는 넣지 않는다(계급·1위 깃발과 역할 중복).
- 캐시: `/user` 응답 캐시에 함께 실린다. 스냅샷 주기 수준 정확도면 충분.

---

## 18. 유입 추적 (?ref / utm_*)

`ref` 값은 **"어느 사이트가 보냈나"** 를 가리키는 출처 이름이다 (`ref=trustmrr`, `ref=newsletter`).
동작 이름(`share` 같은)을 넣지 않는다 — 대시보드에서 읽히지 않는다.

### 18.1 어디에 붙이나

| 대상 | 파라미터 | 붙이는 주체 |
|------|----------|-------------|
| **우리 사이트 → 남의 사이트** (프로필 링크·프로젝트 visit·GitHub) | `?ref=opencodewar` | 코드 (`outboundUrl()`) |
| 손으로 뿌리는 우리 링크 — 뉴스레터·카톡·커뮤니티 게시 | `?ref=<출처>` | 사람이 그때그때 |
| 돈이 오가는 게재 — 광고·스폰서 카드·제휴 | `utm_source`+`utm_medium`+`utm_campaign` | 사람이 그때그때 |

```
https://opencodewar.dev/?ref=newsletter        ← 뉴스레터
https://opencodewar.dev/?ref=kakao             ← 카톡 공유
https://opencodewar.dev/?utm_source=trustmrr&utm_medium=referral&utm_campaign=sponsor_card
```

### 18.2 아웃바운드 — 왜 붙이나 (우리 집계와 무관)

`?ref=opencodewar` 는 **상대 애널리틱스에 찍히는 값**이다. 우리 k-datafast 에는 아무것도 안 남는다.
목적은 프로젝트/블로그 주인이 자기 대시보드에서 "opencodewar 가 방문자를 보냈다"를 보는 것 —
OCW 가 명함첩·SNS 로서 갖는 값이라 트래픽을 흘려보내는 쪽이 이득이다.
(ProductHunt·긱뉴스 등이 쓰는 관행과 같다.)

붙는 위치: 프로필 링크 칩(website·blog·GitHub·X·LinkedIn), 사이드프로젝트 `visit` 버튼,
**리더보드 `shipping` 열의 대표 프로젝트 링크**(§7.3), 푸터·개인정보처리방침의 GitHub 레포 링크(정적 하드코딩).

`outboundUrl()` (`web/index.html`) 규칙 — 남의 URL 을 만지므로 방어적으로:
- `new URL()` + `searchParams.set` — 기존 쿼리는 `&` 로 이어지고 `#fragment` 는 뒤에 남는다(해시 라우터 안 깨짐).
- 상대 URL 에 이미 `ref`/`utm_source` 가 있으면 **덮어쓰지 않는다**.
- 파싱 실패 시 원본 반환. 표식보다 링크가 살아있는 게 우선.
- 화면 라벨(`linkLabel()`)은 원본 URL 로 만들고 `href` 에만 붙인다.
- GitHub·X·LinkedIn 은 이 값을 무시하고 돌려주지도 않는다. 규칙을 단순하게 두려고 예외 없이 붙인다(해 없음).

### 18.3 우리 도메인 링크에는 코드로 박지 않는다

README 배지·npm README·`package.json` / `plugin.json` / `marketplace.json` 의 homepage,
CLI 가 출력하는 `/u/<nick>` 링크 — 전부 **표식 없이 맨 URL**로 둔다.
채널을 쪼개고 싶으면 그때그때 손으로 붙이는 게 낫다(고정 표식은 한 번 박으면 되돌리기 번거롭다).

**공유 버튼(`profileUrl()`)에도 붙이지 않는다.** k-datafast 채널 판정이
`광고 클릭ID → utm_source → ref/source/via → referrer → Direct` 순이라
(`k-datafast/server/src/common/utils/channel.util.ts`) **`ref` 가 referrer 를 덮어쓴다** —
카톡·X·슬랙이 referrer 로 남기는 진짜 출처를 잃는다.
나중에 플랫폼별 공유 버튼을 만들면 그때 `ref=kakao`·`ref=x` 를 붙인다(그건 출처 이름이다).

### 18.4 절대 붙이면 안 되는 곳

- **`<link rel="canonical">`·`og:url`·`sitemap.xml`** — 정규 주소는 파라미터 없이. 검색엔진이 중복 URL 로 본다.
- **API 엔드포인트**(`/leaderboard`, `/user` …) — 사람이 보는 페이지가 아니다.

### 18.5 SPA 라우팅과의 관계

라우팅은 `location.pathname` 만 본다(`urlFor()`/`nickFromPath()`). 들어온 `ref` 는 쿼리라
경로 판정에 영향이 없고, 내부 이동 시 `urlFor()` 가 기존 쿼리를 보존해 주소창에 남는다.
`k.js` 는 로드 시점에 `ref` 를 한 번만 읽으므로 중복 집계되지 않는다.

---

## 19. 세션 브리핑 — 터미널을 읽기 표면으로

### 19.1 문제

지금 터미널은 **write-only** 다. 훅은 숫자를 쏘기만 하고 유저는 아무것도 돌려받지 않는다.
계급(§16)·스트릭(§17)·순위 같은 리텐션 장치를 **전부 웹에 가둬놨기 때문에**, 웹 재방문이
끊기면 제품이 사라진다. 하루 8시간 터미널에 앉아 있는 사람에게 "웹 보러 오세요"는 구조적으로 진다.

지렛대는 이미 있다 — 훅 JSON 의 **`systemMessage` 필드는 터미널 UI 에 직접 표시된다.**
(`hookSpecificOutput.additionalContext` 는 모델 컨텍스트로만 간다. 둘은 다르다.)
추가 설치도, statusline 자리 경쟁도 필요 없다.

### 19.2 원칙 (§4.3 fail-open 을 깨지 않는다)

1. **프롬프트 제출은 절대 네트워크를 기다리지 않는다.** 표시용 훅은 로컬 파일만 읽는다.
2. **미리 받아두고 나중에 띄운다.** 네트워크는 `SessionStart` 에서 detached 로 끝내고,
   `UserPromptSubmit` 은 그 결과 파일을 읽기만 한다. §14.3 `pendingLinkCode` 와 같은
   "다음 실행 시 해소" 패턴.
3. **침묵이 기본.** 보여줄 변화가 없으면 아무것도 띄우지 않는다. 매 세션 배너는 3일이면 소음이 된다.
4. **세션당 최대 1회.** `session_id` 로 중복 표시를 막는다.

### 19.3 흐름

```
SessionStart 훅 (async, 출력 없음)
  → detached 자식: GET /briefing?userId=…
  → ~/.open-code-war/briefing.json 저장 { generatedAt, lines, shownFor: null }

UserPromptSubmit 훅 (동기, 네트워크 없음)
  → briefing.json 읽기
      · 없음 / 오래됨(> 6h) / shownFor == 현재 session_id  → 즉시 exit 0, 출력 없음
      · 그 외 → {"systemMessage": "<한 줄>"} 출력 + shownFor = session_id 기록
```

훅을 **두 개로 분리**하는 게 핵심이다. 기존 track 훅은 `async: true` 인데, **async 훅은 실행은 되지만
`systemMessage` 가 화면에 뜨지 않는다**(§19.8 실측). 그래서 전송(async, 출력 없음)과 표시(동기,
로컬 I/O only)를 섞지 않는다. 표시 훅의 비용은 node 기동 ~50ms + 파일 read 1회이고, 보여줄 게 없으면
파일 stat 수준에서 끝난다 — 기존 track 훅의 fire-and-forget 은 그대로 둔다.

### 19.4 엔드포인트

| 메서드 | 경로 | 호출 빈도 |
|---|---|---|
| GET | `/briefing?userId=…` | **세션당 1회** (프롬프트당이 아님 — 실호출량 1/50 수준) |

세션당 1회이므로 프롬프트당 예산과 달리 D1 을 쓸 여유가 있다. 응답:

```jsonc
{
  "rank":   { "global": 41, "country": 7, "delta": 2, "country_code": "KR" },
  "ahead":  { "nickname": "codemonkey", "gap": 12 },   // 바로 위 경쟁자 (top-100 내일 때만)
  "rank_title": { "key": "corporal", "remaining": 47 }, // 다음 계급까지 누적 prompts
  "streak": { "current": 12, "todayPrompts": 3, "todayChars": 210 },
  "isAnonymous": true,                                  // 닉네임 미등록
  "generatedAt": 1750000000000
}
```

문구 조립(i18n 포함)은 **클라이언트**가 한다. 서버는 숫자만 준다 — §16 RANKS 상수가 이미 웹·OG 두 곳에
복제돼 있어 서버 문자열까지 늘리면 원본이 셋이 된다.

### 19.5 표시 규칙 — 우선순위 1개만, 한 줄

⚠️ **문구 앞에 `UserPromptSubmit says: ` 가 자동으로 붙는다**(§19.8 실측). 우리가 없앨 수 없으므로
그 접두사 **뒤에서 자연스럽게 읽히는 문장**으로 쓴다 — 인사말·주어로 시작하지 말고 상태나 지시로 바로 들어간다.
실제 화면: `UserPromptSubmit says: 🎖 상병까지 47 프롬프트`

위에서부터 **처음 걸리는 것 하나만** 띄운다. 여러 줄로 늘리지 않는다.

| 순위 | 조건 | 예시 |
|---|---|---|
| 1 | 닉네임 미등록 | `익명으로 집계 중 — /ocw nickname <이름> 으로 리더보드에 이름을 올리세요` |
| 2 | 스트릭 ≥ 3 인데 오늘 조건 미달 | `🔥 12일 연속 · 오늘 3/10 — 7개 더 치면 유지` |
| 3 | 다음 계급까지 ≤ 10% | `🎖 상병까지 47 프롬프트` |
| 4 | 순위 변동 있음 | `KR 7위 (↑2)` |
| 5 | top-100 이고 바로 위와 격차 ≤ 20 | `KR 7위 · 6위 codemonkey 와 12 차이` |
| — | 그 외 | **침묵** |

- 1번(닉네임 유도)이 최우선인 이유: 익명 유저는 리더보드에 이름이 없어 공유·재방문 동기가 0 이다.
  브리핑의 첫 실용 효과는 랭킹 자랑이 아니라 **익명 → 등록 전환**이다.
- 2번(스트릭 위험)이 리텐션에 가장 강하다 — 손실 회피. 이미 쌓은 것을 잃는다는 신호.
- 5번(바로 위와의 격차)이 전체 리더보드보다 강력하다. 스냅샷 top-100 에 이미 있으므로 **D1 추가 비용 0**.

`/ocw brief off|on` 으로 끌 수 있어야 한다(config `brief: true`). 끄면 SessionStart prefetch 도 하지 않는다.

### 19.6 비용

`/briefing` 한 번당:
- KV get 1회 — 기존 `lb:snapshot:v2` 재사용. 순위·이웃·delta 를 여기서 뽑으므로 **랭킹 관련 D1 0회**.
- D1 왕복 1회 — `SELECT day, SUM(prompts), SUM(chars) FROM daily_stats WHERE user_id=? GROUP BY day`.
  이 한 쿼리로 allTime(계급)·오늘(스트릭 조건)·스트릭 전부 계산된다. PK 가 `(user_id, day, agent)` 라
  user_id prefix 스캔이고, 읽는 행은 그 유저 것뿐이다.

유저 100명 × 하루 5세션 = 500 호출/일 → D1 읽기 수만 행, KV 읽기 500회. 한도(D1 500만 행/일,
KV 10만 read/일) 대비 무시할 수준. `delta`(순위 변동) 는 이전 브리핑의 순위를 **클라이언트 파일에
남겨** 비교한다 — 서버에 히스토리 테이블을 만들지 않는다.

### 19.7 에이전트별 표시 수단 — 문구는 하나, 표시는 각자

4개 에이전트의 표시 경로가 전부 다르다. 조사 결과(2026-07-25):

| 에이전트 | 표시 수단 | 비고 |
|---|---|---|
| **Claude Code** | 훅 JSON `systemMessage` | 동기 훅만. 접두사 `UserPromptSubmit says: ` 강제 |
| **Codex** | 훅 JSON `systemMessage` | **스키마 동일**(`continue`/`stopReason`/`suppressOutput`/`systemMessage`) → 같은 코드 재사용 |
| **pi** | `ctx.ui.notify(msg, "info")` | 추가로 `setStatus()`(푸터)·`setWidget(…, {placement:"aboveEditor"})`(상시 위젯)까지 가능 — 4개 중 가장 풍부 |
| **OpenCode** | `/tui/show-toast` (서버 엔드포인트) | 플러그인 `client` 로 호출. 정확한 SDK 시그니처는 구현 시 확정 |

**제약**: pi·opencode 어댑터는 **자립형이어야 한다**. jiti(pi)·bun(opencode) 로더가 심볼릭 링크된
파일의 상대 import 를 각기 다르게 해석해서 공용 모듈을 import 하면 로드가 깨진다(어댑터 파일 주석 참조).
그래서 문구 조립을 공용 JS 모듈로 빼는 방법은 쓸 수 없다.

**해법 — `plugin/scripts/brief.mjs` 하나가 문구를 만들고, 표시만 각자 한다.**
집계(`track.mjs`)와 표시(`brief.mjs`)는 파일부터 분리한다 — 전자는 fire-and-forget async,
후자는 동기 표시라 성격이 정반대다.

```
brief.mjs --prefetch             SessionStart 용. detached 자식에 넘기고 즉시 종료(세션 시작 지연 0)
brief.mjs --hook                 Claude Code·Codex 용. stdin 의 session_id 를 읽어
                                 {"systemMessage": "<한 줄>"} 출력 (없으면 무출력)
brief.mjs --line [--session ID]   pi·opencode 어댑터 용. 문구 한 줄만 stdout
   ├─ pi       : 어댑터가 ctx.ui.notify(line, "info")
   └─ OpenCode : 어댑터가 client.tui.showToast({ body: { message: line, variant: "info" } })
```

우선순위 규칙(§19.5)·i18n·캐시 판정이 **`lib/briefing.mjs` 한 곳에만** 살고, 자립형 제약도
깨지지 않는다. 각 어댑터가 갖는 것은 "brief.mjs 를 spawn 해 한 줄을 받아 띄우는" 몇 줄뿐이다.

pi·opencode 에는 SessionStart 훅이 없으므로 **확장/플러그인 로드 시점에 prefetch** 한다.

### 19.7.1 표시 언어 — 국가 우선 (§15 와 같은 순서)

`config.lang` → **서버가 준 국가(`rank.countryCode`)** → 셸 로케일 순으로 정한다.
셸 로케일을 먼저 보면 안 된다 — **macOS 기본이 `en_US.UTF-8`** 이라 한국 유저도 영어로 나온다
(실측으로 확인). 서버가 IP 로 판정한 `users.country` 가 훨씬 정확하다.

### 19.8 실측 결과 (2026-07-25)

| 항목 | 결과 |
|---|---|
| 동기 훅 `systemMessage` 표시 | ✅ **표시됨**. 단 `UserPromptSubmit says: ` 접두사가 붙는다 |
| `async: true` 훅 | 실행은 되지만 **표시 안 됨** → §19.3 훅 분리 설계가 필요한 이유 |
| 훅 실행 자체 | sync·async 모두 실행 확인(파일 사이드이펙트로 검증) |
| 이모지(🎖) | ✅ 정상 렌더 |
| stdin `session_id` | ✅ 존재 → 세션당 1회 판정 가능 |
| 헤드리스(`claude -p`) | UserPromptSubmit 훅 이벤트가 stream-json 에 실리지 않는다. `systemMessage` 는 TUI 렌더라 **헤드리스로는 검증 불가** — 반드시 인터랙티브로 확인할 것 |

남은 리스크:
- ⬜ `systemMessage` **여러 줄 처리** 미확인 → 한 줄 + 이모지 1개로 보수적으로 간다.
- ⬜ OpenCode `client` 의 toast 호출 시그니처 미확정(엔드포인트 존재만 확인).
- ⬜ Codex 는 [`suppressOutput` 이 no-op](https://github.com/openai/codex/issues/15497) 이라 훅 출력이
  더 잘 노출된다 → 노이즈 체감이 Claude Code 와 다를 수 있으니 별도 확인.
- 세션이 매우 짧거나(1프롬프트) SessionStart 직후 바로 치면 prefetch 가 안 끝나 그 세션은 침묵한다.
  다음 세션에 뜨므로 정상 동작으로 본다(신선도 6h 컷).
- 브리핑은 **집계 스냅샷 기준**(최대 30분 지연, §13)이라 "방금 친 것"이 반영 안 될 수 있다.
  문구를 실시간처럼 쓰지 않는다.

### 19.9 구현 상태 — 1차 완료 (2026-07-25)

| # | 항목 | 산출물 |
|---|---|---|
| 1 | 훅 출력 실측 | §19.8 |
| 2 | `GET /briefing` | `backend/src/briefing.ts`(순수 함수) + `handleBriefing` + `test/briefing.test.ts` |
| 3 | 캐시 + prefetch | `plugin/scripts/lib/briefing.mjs`, `brief.mjs --prefetch`, `SessionStart` 훅 |
| 4 | 문구 조립 + 표시 훅 | `composeBriefing()` + `brief.mjs --hook` (동기) |
| 5 | Codex | `codex-hooks.json` — Claude Code 와 동일 코드 |
| 6 | pi·opencode | 두 어댑터에 `briefLine()`/`prefetchBrief()` + notify/showToast |
| 7 | CLI | `/ocw brief on\|off`, `/ocw status` 에 상태 줄 |

로컬 E2E 확인: `/track` → `/briefing` → `--prefetch` → `--hook` 표시 → 같은 세션 침묵 →
`--line` 경로까지 전부 통과. 언어는 `countryCode=KR` 로 한국어 선택됨.

**호스트별 실측 (2026-07-25)**

| 호스트 | 확장/훅 로드 | prefetch | 표시 경로 도달 | 화면 표시 |
|---|---|---|---|---|
| Claude Code | ✅ | ✅ | ✅ | ✅ 눈으로 확인(§19.8) |
| pi | ✅ `pi -p` | ✅ | ✅ `shownFor`=세션파일 경로 | ⬜ TUI 필요 |
| OpenCode | ✅ `opencode run` | ✅ | ✅ `shownFor`=`ses_…` | ⬜ TUI 필요 |
| Codex | ⬜ | ⬜ | ⬜ | ⬜ |

- pi·OpenCode 는 헤드리스로 **확장 로드 → prefetch → briefLine 호출**까지 전 경로가 실제로 도는 것을
  확인했다(캐시의 `shownFor`/`shownAt` 기록이 증거). 토스트·notify 가 실제로 그려지는지는 TUI 가
  필요해 미확인이나, 호출은 에러 없이 통과했다.
- **Codex 만 미실측** — `codex exec` 가 프롬프트 처리 단계까지 가지 못했다(승인/인증 추정, 5분 타임아웃).
  훅 스키마가 Claude Code 와 동일하고 같은 `brief.mjs --hook` 을 쓰므로 리스크는 낮지만 확인은 필요.
- ⚠️ **Claude Code·Codex 플러그인은 GitHub 레포에서 설치된다**(`~/.claude/plugins/marketplaces/opencodewar`,
  codex `[plugins."open-code-war@opencodewar"]`). 즉 **푸시하기 전에는 두 호스트에서 새 기능이 돌지 않는다.**
  pi·opencode 는 로컬 심볼릭 링크라 즉시 반영된다.

**배포 완료 (2026-07-25)** — Version `4f73ec7a`. 스키마 변경이 없어 마이그레이션은 불필요했다.
프로덕션 `/briefing` 실데이터 확인, `--prefetch` → 캐시 → 표시 판정까지 전 경로 정상.

### 19.10 발견된 공백 — 1위는 브리핑이 거의 안 뜬다

프로덕션 검증에서 드러났다. 1위 유저는 **5순위(격차)가 영영 안 걸린다** — `ahead` 가 null 이고,
순위 변동도 1위를 유지하는 한 없다. 남는 건 계급 임박·스트릭 위험뿐이라 대부분의 세션이 침묵이다.
상위권일수록 볼 게 없어지는 구조인데, 정작 이들이 가장 활발한 유저다.

**해법(미구현)**: 서버가 1위일 때 `ahead` 대신 **`behind`(추격자)** 를 내려주고, 문구를 방어 관점으로 쓴다.
`🏆 KR 1위 · 2위 <닉> 이 12 뒤` — 5순위의 대칭이고, 쫓기는 쪽 심리가 쫓는 쪽만큼 강하다.
`positionIn()` 에서 `idx+1` 이후를 같은 방식으로 찾으면 되므로 D1 추가 비용은 없다.

**남은 것**
- ⬜ §19.10 (1위 공백) 구현.
- ⬜ Codex 실측, TUI 에서 pi·opencode 표시 확인.
- ⚠️ Claude Code·Codex 는 플러그인 설치본(git clone)이 갱신돼야 새 기능이 돈다 — 푸시만으로는 부족하고
  각 호스트에서 플러그인 업데이트가 필요하다.
- ⬜ 배포 후 `/briefing` 실호출량·D1 읽기 모니터링(§19.6 추정치 대비).
- ⬜ 문구 A/B — 5순위(격차)가 가장 자주 걸릴 텐데 실제로 행동을 끌어내는지.

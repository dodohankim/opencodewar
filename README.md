<div align="center">

# ⚔️ Open Code War

**Claude Code 사용자들이 "누가 제일 많이 입력했나"를 겨루는 리더보드 게임.**

플러그인 훅으로 입력 활동을 익명 집계 → Cloudflare에 저장 → 웹에서 일간·주간·주말 랭킹과 국가별 지도로 표시.

[English](README.en.md) · **한국어**

[![website](https://img.shields.io/badge/opencodewar.dev-1a1a1a?style=for-the-badge)](https://opencodewar.dev)
[![status](https://img.shields.io/badge/status-early%20development-e08a2e?style=for-the-badge)](#-로드맵)
[![Claude Code](https://img.shields.io/badge/Claude%20Code-plugin-6c5ce7?style=for-the-badge)](#-플러그인-설치)

<sub>코드네임: <b>OCW</b> · 1차 타겟 🇰🇷 대한민국 → 최종: 전 세계 국가별 지구본 랭킹</sub>

</div>

---

## 🔒 프라이버시가 먼저

Open Code War는 **프롬프트 내용을 절대 수집하지 않습니다.** 제출 "횟수"와 "글자 수(숫자)"만 셉니다.

| ✅ 수집함 | ❌ 수집 안 함 |
|-----------|--------------|
| 익명 `userId` (기기에서 자동 발급, 되돌릴 수 없음) | 프롬프트 **내용** |
| 프롬프트 제출 **횟수** | 코드 · 파일 · 경로 |
| 프롬프트 **글자 수** (정수 하나) | 이메일 · 실명 등 개인정보 |
| (서버측) 접속 국가 `cf.country` | IP 원문 저장 |

> 훅은 프롬프트 원문을 받더라도 **글자 수만 계산해서 보내고 원문은 전송하지 않습니다.** 네트워크가 실패해도 Claude Code 사용을 방해하지 않도록 **fail-open**(짧은 타임아웃 + 백그라운드 fire-and-forget)으로 동작합니다.

---

## 🧩 어떻게 동작하나

```
┌──────────────────────────────┐   POST /track      ┌───────────────────────────┐
│  Claude Code 플러그인         │  ─ userId,chars ─▶ │  Cloudflare Worker         │
│  · UserPromptSubmit 훅        │                    │  · cf.country 자동 판별    │
│  · /ocw 닉네임 슬래시커맨드   │  ─ POST /register ▶│  · events 기록 + 집계      │
│  · ~/.open-code-war/config    │                    │  · Cron 스냅샷(KV)         │
└──────────────────────────────┘                    └───────────┬───────────────┘
                                                                 │ D1 (SQLite)
                                    GET /leaderboard             ▼
┌──────────────────────────────┐   GET /countries    ┌───────────────────────────┐
│  리더보드 웹 (정적)           │  ◀──── JSON ─────── │  일간/주간/주말/국가별     │
│  일간·주간·주말 · 한반도→지구본│                    │  랭킹 스냅샷 읽기          │
└──────────────────────────────┘                    └───────────────────────────┘
```

- **수집** — 플러그인의 `UserPromptSubmit` 훅이 제출마다 Worker로 이벤트 전송(내용 제외).
- **저장/집계** — Worker가 요청 국가(`cf.country`)를 붙여 D1에 기록하고, KST(UTC+9) 일자별로 집계. 리더보드는 실시간이 아니라 **Cron 배치 스냅샷**(KV)을 읽어 D1 쓰기를 절감.
- **표시** — 정적 웹이 Worker의 읽기 API를 호출해 랭킹/지도 렌더.

---

## 📂 저장소 구조 (모노레포)

```
open-code-war/
├── plugin/            # Claude Code 플러그인 (수집 훅 + /ocw 커맨드)
│   ├── .claude-plugin/plugin.json
│   ├── hooks/hooks.json          # UserPromptSubmit → track.mjs (async·비차단)
│   ├── commands/ocw.md           # /ocw 슬래시 커맨드
│   └── scripts/                  # track.mjs, ocw-cli.mjs, lib/
├── backend/           # Cloudflare Worker + D1 API
│   ├── src/                      # Worker 소스
│   ├── migrations/               # D1 스키마
│   ├── seed/                     # 테스트 시드
│   └── wrangler.jsonc
├── web/               # 리더보드 정적 웹 (일간·주간·주말 + 지도)
├── mockups/           # 웹 디자인 시안
└── DESIGN.md          # 상세 설계 문서 (v0.1)
```

---

## 🚀 플러그인 설치

### 마켓플레이스에서 설치 (권장)

```
/plugin marketplace add dodohankim/opencodewar
/plugin install open-code-war@opencodewar
```

`/plugin` 메뉴의 **Installed** 탭에서 활성화·관리, 업데이트는 `/plugin marketplace update opencodewar`.

> ℹ️ 백엔드는 **배포되어 라이브(베타)** 이고 플러그인에 URL이 내장돼 있어 설치하면 바로 집계됩니다. (`/plugin marketplace add`는 이 레포가 GitHub에 push되어 있어야 동작합니다.)

### 개발용 (로컬 로드)

```bash
export OCW_API_URL="http://localhost:8787"   # 로컬 백엔드 (cd backend && npm run dev)
claude --plugin-dir ./plugin
```

닉네임 등록 / 상태 확인 / 수집 on-off:

```
/ocw nickname <이름>     # 리더보드 표시 이름 등록·변경
/ocw status              # 내 userId·닉네임·수집 상태 확인
/ocw enable | disable    # 수집 켜기/끄기
```

- 설정 파일: `~/.open-code-war/config.json` (userId · 닉네임 · on/off)
- ⚠️ `userId`는 **신원이자 비밀키**입니다. 공유하지 마세요.

---

## 🛠️ 로컬 개발

### 백엔드 (Cloudflare Worker + D1)

```bash
cd backend
npm install
npm run db:migrate:local     # 로컬 D1 스키마 적용
npm run db:seed:local        # 테스트 데이터 시드
npm run dev                  # wrangler dev (http://localhost:8787)
```

기타 스크립트: `npm run typecheck` · `npm run test`(vitest) · `npm run deploy`(배포).

### 웹

`web/index.html`을 정적 서버로 열면 됩니다. (백엔드 읽기 API에 연결)

---

## 🔌 API (Worker 엔드포인트)

| 메서드 | 경로 | 설명 |
|--------|------|------|
| `POST` | `/track` | 입력 이벤트 수집 (rate-limit, `cf.country` 부착) |
| `POST` | `/register` | 닉네임 등록/변경 (유일성·비속어 검사) |
| `GET`  | `/leaderboard?type=daily\|weekly\|weekend&metric=prompts\|chars&limit=100` | 랭킹 조회 (스냅샷 캐시) |
| `GET`  | `/countries?type=…` | 국가별 합계 (지구본용) |

집계 구간은 모두 **KST(UTC+9)** 기준이며, 주말 = 금·토·일.

---

## 🗺️ 로드맵

| 단계 | 내용 | 상태 |
|------|------|------|
| **M1** | 백엔드 스켈레톤 — Worker + D1 스키마 + `/track` `/leaderboard` | ✅ |
| **M2** | 수집 플러그인 — `UserPromptSubmit` 훅, 익명 ID, `/register` 닉네임 | ✅ |
| **M3** | 리더보드 웹을 실제 API에 연결 + KV 스냅샷 캐싱 | ✅ |
| **다음** | 마켓플레이스 배포 · 지구본 국가 랭킹 · 어뷰징 방어(rate-limit) 강화 | ⬜ |

자세한 설계·결정 사항은 [`DESIGN.md`](./DESIGN.md) 참고.

### 비목표 (v1 범위 밖)
- 프롬프트 **내용** 수집·저장 (프라이버시상 절대 안 함)
- 상금·현금성 보상 (어뷰징 검증 부담 — 별도 논의)
- 실시간 대전/멀티플레이 (v1은 배치 집계 기반 랭킹)

---

## 📄 라이선스

**Business Source License 1.1 (BSL)** — 전체 조건은 [`LICENSE`](./LICENSE) 참고.

- 소스는 **공개**되어 누구나 열람·감사(audit)할 수 있습니다. (프라이버시 주장 검증을 위해 중요)
- **개인·교육·내부 용도의 플러그인 사용과 비상업적 self-host는 자유**입니다.
- 단, 광고·후원 기반의 **상업적/경쟁 서비스로 제공**하거나 **광고·후원·출처표시 기능을 제거·우회**하는 것은 허용되지 않습니다.
- **Change Date(2030-07-09)** 에 **Apache License 2.0** 으로 자동 전환됩니다.

> BSL은 OSI 공인 오픈소스 라이선스가 아니라 'source-available'입니다. 이름·로고(Open Code War, opencodewar)와 도메인 상표는 라이선스와 별개로 보호됩니다.

<div align="center">
<sub>Made for the Claude Code community · <a href="https://opencodewar.dev">opencodewar.dev</a></sub>
</div>

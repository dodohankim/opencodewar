# Adapters

Claude Code 외 다른 에이전트에서도 프롬프트를 집계하기 위한 어댑터.

> **Codex 는 여기 없다.** 코덱스는 Claude Code 와 같은 플러그인·마켓플레이스 체계를 갖고 있어서
> `plugin/` 을 그대로 설치한다 (`codex plugin marketplace add` → `codex plugin add`).
> 설치 방법은 루트 [README](../README.md#-플러그인-설치) 참고.
>
> OpenCode·pi 는 여기 있는 어댑터를 쓰지만, **npm 패키지 `open-code-war`** 로 발행돼 있어
> 설치는 각 에이전트의 네이티브 방식으로 한다. 레포 루트 `package.json` 이 그 패키지 매니페스트다
> (`main` → OpenCode 플러그인, `pi.extensions` → pi 확장). 설치 방법은 루트 README 참고.

각 어댑터는 해당 에이전트의 "사용자 입력" 훅에 붙어서, Claude Code 훅과 **동일한**
`plugin/scripts/track.mjs` 를 실행한다. 따라서 userId(`~/.open-code-war/config.json`),
엔드포인트, 글자 수 계산 규칙이 전부 공유되고, 한 PC 안에서 여러 에이전트를 써도
리더보드에는 **한 사람으로 합산**된다. (에이전트별 내역은 `daily_stats.agent` 로 따로 남는다.)

| 에이전트 | 훅 | 어댑터 | 설치 위치 |
|---|---|---|---|
| Claude Code | `UserPromptSubmit` | `plugin/hooks/hooks.json` | 플러그인 마켓플레이스 |
| OpenCode 2 | `session.hook("prompt")` | `adapters/opencode/ocw-track.js` (`default.setup`) | npm (`open-code-war`) |
| OpenCode 1.18.29+ | `chat.message` | 위 파일의 `default.server()` | npm (`open-code-war`) |
| OpenCode 1 (그 이전) | `chat.message` | 위 파일의 `OpenCodeWar` export | npm (`open-code-war`) |
| pi | `input` | `adapters/pi/ocw-track.ts` | `pi install npm:open-code-war` |

## 설치

둘 다 npm 패키지 `open-code-war` 하나로 설치한다.

```bash
# pi
pi install npm:open-code-war

# OpenCode — opencode.json(c) 의 plugins 배열에 추가(시작 시 자동 설치)
#   { "plugins": ["open-code-war"] }
```

설치 후 각 에이전트를 재시작하면 다음 프롬프트부터 집계된다.

> npm 패키지에는 어댑터와 함께 `plugin/scripts/track.mjs` 가 포함돼 있어 레포 없이도 자립 동작한다.
> 발행 절차: 루트에서 `npm pack` → tarball 의 `README.md` 를 `adapters/npm-README.md` 로 교체 →
> `npm publish <tarball>`. (루트 README 는 프로젝트 전체 설명이라 패키지 페이지엔 전용 README 를 쓴다.)
표시명은 Claude Code 와 동일하게 `/ocw nickname <이름>` 으로 등록한다.

## 동작 요건

- **Node.js 가 PATH 에 있어야 한다.** 어댑터는 `track.mjs` 를 node 로 실행한다.
  OpenCode 는 bun 으로 컴파일된 단일 실행 파일이라 `process.execPath` 가 node 가 아니므로,
  어댑터가 PATH 에서 node 를 직접 찾는다. 못 찾으면 조용히 집계를 건너뛴다
  (에이전트 동작은 방해하지 않는다). 필요하면 `OCW_NODE` 로 경로를 지정할 수 있다.
- `track.mjs` 경로는 `OCW_TRACK_SCRIPT` → 레포 상대 경로 → Claude Code 플러그인 설치 경로
  순으로 찾는다.
- `OCW_API_URL` 로 엔드포인트를 바꿀 수 있다(로컬 백엔드 테스트용).

## 집계 기준

Claude Code 의 `UserPromptSubmit` 과 최대한 같은 의미가 되도록 맞췄다.

- **OpenCode**: 서브에이전트 세션(`Session.parentID` 보유)에서 오는 메시지는 사용자가 친
  프롬프트가 아니므로 제외한다. 세션당 한 번만 조회하고 캐시한다.
  프로젝트 귀속(`projectDir`)에는 세션의 작업 디렉토리(`Session.location.directory`)를 쓴다.
- **pi**: `event.source` 가 `interactive`(직접 입력) 또는 `rpc`(API 호출)인 것만 센다.
  확장이 주입한 메시지(`extension`)는 제외한다.

## 알려진 사항

- **OpenCode 2 는 V1 플러그인 API 를 실행하지 않는다.** 어댑터는 세 로더 모양을 함께 내보낸다 —
  `default.setup`(2.x), `default.server()`(1.18.29+, V1 로더가 "default export an object with
  `server()`"를 요구한다), `OpenCodeWar`(그 이전 1.x의 명명 export 스캔). 실제 바이너리로 2.1.4·
  1.19.4 양쪽 로드/집계를 확인했다. 로드에 실패하면 TUI 에는 아무 표시가 없고 로그에만
  `failed to load plugin` 이 남으므로(집계가 조용히 멈춘다), 집계가 이상하면
  `~/.local/share/opencode/log/opencode.log` 를 먼저 확인한다.
- **세션 브리핑 토스트는 OpenCode 2 에서 표시되지 않는다.** V2 서버 플러그인에는 TUI 알림
  (구 `client.tui.showToast`) 경로가 없다. 브리핑 데이터 prefetch 는 계속 하므로 Claude Code·pi
  쪽 브리핑 캐시는 정상 갱신된다.

`opencode run "<프롬프트>"` 로 실행하면 OpenCode CLI 가 인자를 **따옴표째** 메시지 본문으로
넘긴다. 그래서 헤드리스 실행에서는 글자 수가 실제 입력보다 2 늘어난다. TUI 로 직접 입력할 때는
해당 없음. 어댑터가 받은 텍스트를 그대로 세기 때문에 생기는 현상이며 OpenCode 쪽 동작이다.

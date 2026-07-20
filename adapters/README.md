# Adapters

Claude Code 외 다른 에이전트에서도 프롬프트를 집계하기 위한 어댑터.

각 어댑터는 해당 에이전트의 "사용자 입력" 훅에 붙어서, Claude Code 훅과 **동일한**
`plugin/scripts/track.mjs` 를 실행한다. 따라서 userId(`~/.open-code-war/config.json`),
엔드포인트, 글자 수 계산 규칙이 전부 공유되고, 한 PC 안에서 여러 에이전트를 써도
리더보드에는 **한 사람으로 합산**된다. (에이전트별 내역은 `daily_stats.agent` 로 따로 남는다.)

| 에이전트 | 훅 | 어댑터 | 설치 위치 |
|---|---|---|---|
| Claude Code | `UserPromptSubmit` | `plugin/hooks/hooks.json` | 플러그인 마켓플레이스 |
| Codex | `UserPromptSubmit` | `adapters/codex/ocw-track.sh` | `~/.codex/hooks.json` (설치기가 병합) |
| OpenCode | `chat.message` | `adapters/opencode/ocw-track.js` | `~/.config/opencode/plugin/` |
| pi | `input` | `adapters/pi/ocw-track.ts` | `~/.pi/agent/extensions/` |

## 설치

레포를 클론한 뒤 심볼릭 링크를 건다. 링크를 쓰면 레포를 `git pull` 할 때 어댑터도 같이 갱신된다.

```bash
git clone https://github.com/dodohankim/opencodewar.git
cd opencodewar

# OpenCode
mkdir -p ~/.config/opencode/plugin
ln -sf "$PWD/adapters/opencode/ocw-track.js" ~/.config/opencode/plugin/ocw-track.js

# pi
mkdir -p ~/.pi/agent/extensions
ln -sf "$PWD/adapters/pi/ocw-track.ts" ~/.pi/agent/extensions/ocw-track.ts
```

Codex 만 방식이 다르다. 플러그인 디렉토리가 없고 훅을 `~/.codex/hooks.json`(또는 `config.toml`
의 `[hooks]`)에서만 읽기 때문에, 심볼릭 링크 대신 설치기가 기존 파일에 항목을 **병합**한다.
기존 훅은 그대로 두고, 덮어쓰기 전에 `hooks.json.bak` 을 남기며, 여러 번 실행해도 중복되지 않는다.

```bash
# Codex (설치 / 제거)
node adapters/codex/install.mjs
node adapters/codex/install.mjs --uninstall
```

설치 후 각 에이전트를 재시작하면 다음 프롬프트부터 집계된다.
표시명은 Claude Code 와 동일하게 `/ocw nickname <이름>` 으로 등록한다.

## 동작 요건

- **Node.js 가 PATH 에 있어야 한다.** 어댑터는 `track.mjs` 를 node 로 실행한다.
  OpenCode 는 bun 으로 컴파일된 단일 실행 파일이라 `process.execPath` 가 node 가 아니므로,
  어댑터가 PATH 에서 node 를 직접 찾는다. 못 찾으면 조용히 집계를 건너뛴다
  (에이전트 동작은 방해하지 않는다). 필요하면 `OCW_NODE` 로 경로를 지정할 수 있다.
- `track.mjs` 경로는 `OCW_TRACK_SCRIPT` → 레포 상대 경로 → Claude Code 플러그인 설치 경로
  순으로 찾는다.
- `OCW_API_URL` 로 엔드포인트를 바꿀 수 있다(로컬 백엔드 테스트용).
- **Codex 는 훅을 "신뢰(trust)" 해야 실행한다.** 설치만으로는 동작하지 않는다. 설치 후 `codex` 를
  실행하면 시작 화면에 `Hooks need review` 가 뜨고, 여기서 **Trust all and continue** 를 선택해야
  훅이 돈다. 선택 전에는 아무 경고 없이 조용히 건너뛴다(0.144.6 실측). 훅 항목이 바뀌면
  (`install.mjs` 재실행으로 경로가 바뀌는 등) 다시 신뢰를 받아야 한다.
  자동화용으로 `codex exec --dangerously-bypass-hook-trust` 가 있지만 이름 그대로 권장하지 않는다.
- Codex 어댑터는 sh 스크립트라 POSIX 셸이 필요하다(Windows 는 WSL). 설치기는 레포의
  **절대 경로**를 등록하므로 레포를 옮기면 다시 실행한다.

## 집계 기준

Claude Code 의 `UserPromptSubmit` 과 최대한 같은 의미가 되도록 맞췄다.

- **Codex**: 훅 이름·페이로드(`prompt` 필드)가 Claude Code 와 사실상 같아서 별도 필터가 없다.
  서브에이전트는 `SubagentStart`/`SubagentStop` 으로 따로 분리돼 있어 `UserPromptSubmit` 에는
  사용자 프롬프트만 들어온다. 훅 stdout 은 Codex 가 "추가 개발자 컨텍스트"로 프롬프트에 주입하므로
  어댑터는 stdout 에 아무것도 쓰지 않는다(종료 코드 2 는 프롬프트 차단이라 항상 0 으로 끝낸다).
- **OpenCode**: 서브에이전트 세션(`Session.parentID` 보유)에서 오는 메시지는 사용자가 친
  프롬프트가 아니므로 제외한다. 세션당 한 번만 조회하고 캐시한다.
- **pi**: `event.source` 가 `interactive`(직접 입력) 또는 `rpc`(API 호출)인 것만 센다.
  확장이 주입한 메시지(`extension`)는 제외한다.

## 알려진 사항

`opencode run "<프롬프트>"` 로 실행하면 OpenCode CLI 가 인자를 **따옴표째** 메시지 본문으로
넘긴다. 그래서 헤드리스 실행에서는 글자 수가 실제 입력보다 2 늘어난다. TUI 로 직접 입력할 때는
해당 없음. 어댑터가 받은 텍스트를 그대로 세기 때문에 생기는 현상이며 OpenCode 쪽 동작이다.

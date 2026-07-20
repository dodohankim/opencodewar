# Open Code War — Claude Code 플러그인 (M2)

클로드 코드에 프롬프트를 제출할 때마다 **입력 활동(횟수 + 글자 수)** 을 익명으로 집계해 리더보드로 보낸다.
리더보드 자체는 코딩 에이전트 전반을 대상으로 한다.

이 플러그인 디렉토리는 **Claude Code 와 Codex 양쪽의 플러그인**이다. 두 CLI 가 같은 마켓플레이스
포맷(`.claude-plugin/marketplace.json`)을 읽기 때문에 하나의 디렉토리로 겸한다.

| | 매니페스트 | 훅 파일 | 실행 |
|---|---|---|---|
| Claude Code | `.claude-plugin/plugin.json` | `hooks/hooks.json` | `track.mjs` (async·비차단) |
| Codex | `.codex-plugin/plugin.json` | `hooks/codex-hooks.json` | `track.mjs --agent codex` |

훅 파일을 나눈 이유: Codex 는 `async` 훅을 아직 지원하지 않아 그대로 두면 조용히 건너뛰고
(`skipping async hook … not supported yet`), `--agent codex` 가 없으면 코덱스 입력이
`claude-code` 로 잘못 집계된다. 경로 변수도 다르다(`${CLAUDE_PLUGIN_ROOT}` vs `${PLUGIN_ROOT}`).

오픈코드·파이는 플러그인 체계가 달라 `adapters/` 의 어댑터로 같은 계정에 합산된다.

## 무엇을 수집하나 / 안 하나

| 수집함 | 수집 안 함 |
|--------|-----------|
| 익명 userId (기기에서 자동 발급) | ❌ 프롬프트 **내용** |
| 프롬프트 제출 **횟수** | ❌ 코드/파일/경로 |
| 프롬프트 **글자 수**(숫자) | ❌ 이메일·실명 등 개인정보 |
| (서버측) 접속 국가 `cf.country` | |

- 설정 파일: `~/.open-code-war/config.json` (userId·닉네임·on/off)
- `userId`는 **신원이자 비밀키**다. 공유하지 말 것.

## 구성

```
plugin/
├── .claude-plugin/plugin.json   # 매니페스트
├── hooks/hooks.json             # UserPromptSubmit → track.mjs (async, 비차단)
├── commands/ocw.md              # /ocw 슬래시 커맨드
└── scripts/
    ├── track.mjs                # 훅: 글자 수만 계산해 detached 전송(fire-and-forget)
    ├── ocw-cli.mjs              # /ocw 백엔드 (nickname/status/enable/disable)
    └── lib/{config,chars}.mjs
```

## 설치 (개발/테스트)

```bash
# 백엔드 API URL 지정 (미지정 시 config 기본값 사용)
export OCW_API_URL="http://localhost:8787"        # 로컬 백엔드
# 또는 배포 후: export OCW_API_URL="https://<your-worker>.workers.dev"

# 로컬 플러그인 로드
claude --plugin-dir ./plugin

# 편집 후 재적용
/reload-plugins
```

- 최초 프롬프트 제출 시 `~/.open-code-war/config.json`이 자동 생성되고 익명 userId가 발급된다.
- 확인: `/hooks` (UserPromptSubmit 등록 확인), `/plugin` (설치 목록)

## 사용

```
/ocw nickname 도한      # 닉네임 등록 (리더보드 표시명)
/ocw status            # 내 정보 + 오늘 순위
/ocw disable           # 집계 일시중지
/ocw enable            # 재개
```

## 동작 원리 (비차단 보장)

`UserPromptSubmit` 훅은 `async: true`로 등록되고, `track.mjs`는 글자 수만 계산한 뒤
**detached 자식 프로세스**에 전송을 위임하고 즉시 종료한다. 네트워크가 느리거나 실패해도
프롬프트 처리가 지연되지 않으며, stdout에 아무것도 출력하지 않아 대화 컨텍스트를 오염시키지 않는다.

## 엔드포인트 설정 우선순위

`OCW_API_URL` 환경변수 > `config.json`의 `endpoint` > 기본값(`plugin.json` 배포 URL)

## TODO

- 배포 후 `scripts/lib/config.mjs`의 `DEFAULT_ENDPOINT`를 실제 Worker URL로 교체
- rate-limit·비속어 필터는 서버(M1)와 함께 강화 예정

# 막사 — Claude Code mod (`hooks/space.mjs`)

Open Code War 막사(`DESIGN.md §27`)의 터미널 클라이언트입니다. 이 플러그인에 함께 들어 있습니다. `/space` 를 열면 **광장**에 섭니다.
광장에는 지금 Claude Code 를 켜 두었거나 누가 들어가 있는 사람들의 **막사 문**이 줄지어 있고,
문 앞까지 걸어가서 `e` 를 누르면 그 막사로 들어갑니다. 같은 방에 있는 사람들은 터미널이든 웹(`/plaza`)이든
실시간으로 보이고, 채팅은 그 방 사람들끼리 합니다.

> 요구사항: Claude Code **v2.1.287 이상**(터미널 `claude` 또는 Claude Desktop 의 Code 탭), **Node 22 이상**.
> 더 낮은 버전의 Claude Code 는 이 mod 를 무시하고 기존 집계 훅만 돌립니다(2.1.100·2.1.200·2.1.286 에서 확인).

## 개발 중 실행

로컬 백엔드에 붙이려면(`backend/` 에서 `npm run dev:local`):

```bash
OCW_API_URL=http://127.0.0.1:8787 claude --plugin-dir ./plugin
```

| 명령 | 하는 일 |
|---|---|
| `/space` | 광장 열기 (Claude 가 일하는 중에도 열림) |
| `/space home` | 내 막사로 바로 |
| `/space kick <닉>` | 내 막사에서 내보내기 (10분간 재입장 금지) |
| `/space ban <닉>` · `unban <닉>` · `bans` | 차단 · 해제 · 목록 |
| `/space close` · `open` | 내 막사 잠그기 · 열기 |
| `/space guestbook clear` | 내 막사 방명록 비우기 |
| `/space presence off` · `on` | 작업 상태 알리기 끄기 · 켜기 |

패널 조작 (패널에 키보드 포커스가 있을 때):

| 키 | 동작 |
|---|---|
| `a` / `d` | 왼쪽 / 오른쪽 이동 (mod 는 방향키를 못 묶습니다) |
| `e` | 문 앞에서: 막사로 들어가기 · 막사 왼쪽 문에서: 광장으로 나가기 |
| `t` | 맨 아래 채팅 입력창으로. 보낸 뒤에도 입력창에 남아 계속 칠 수 있음 |
| `g` | 방명록 한 줄 남기기 (주인이 방에 없을 때, 막사별 하루 3건) |
| 빈 줄 Enter / `Tab` | 채팅에서 이동 모드로 |
| `Esc` | 패널 닫기 (방에서 나감) |

## 주인 작업 상태 (자동)

mod 가 로드된 Claude Code 세션은 켜질 때, 턴이 시작·끝날 때(3초 디바운스), 그리고 2분마다 `/space/status` 로
`working` / `idle` 값만 보냅니다. 세션이 여러 개면 하나라도 일하는 중일 때 "작업 중". `/space presence off` 로 끕니다. `/ocw disable`(수집 끔) 상태거나 `claude -p` 같은 비대화 실행이면 보내지 않습니다.

- 광장: 켜진 막사의 문 위 등불이 켜지고, 이름표에 `⌨`
- 내 막사: 내가 안 들어가 있어도 책상에 앉아 타이핑 중인 모습. Claude Code 를 다 끄면 "외출 중"

## 무엇을 읽고 보내나

- 읽기: `~/.open-code-war/config.json` 의 `userId`(서버에서 60초짜리 입장 티켓으로 바꾸는 데만 씀)·`endpoint`.
- 실행: 방에 들어가 있는 동안 `node link/link.mjs` 사이드카 하나 — 서버 WebSocket 을 잡고,
  127.0.0.1 임의 포트(임의 토큰)로 이 mod 의 송신을 받습니다. Claude Code 가 끝나면 같이 끝납니다.
- 보내기: 막사 안 이동·채팅·방명록, 그리고 작업 상태값. **프롬프트·도구 내용은 보지도 보내지도 않습니다.**

`claude plugin validate ./plugin` 로 훅·호출 목록을 직접 확인할 수 있습니다.

## 테스트

```bash
claude plugin test ./plugin
```

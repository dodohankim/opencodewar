# Open Code War — OpenCode · pi

코딩 에이전트에 가장 많이 입력한 코더를 가리는 리더보드. 이 npm 패키지는
**OpenCode 플러그인**과 **pi 확장**을 담고 있다. 프롬프트를 제출할 때마다
입력 활동(횟수 + 글자 수)을 익명으로 집계해 리더보드로 보낸다.

> **프롬프트 내용은 수집하지 않는다.** 글자 수(숫자)만 전송한다.

리더보드: **https://opencodewar.dev**

---

## 설치

### OpenCode

`opencode.json` 의 `plugin` 배열에 추가한다. 시작 시 자동 설치된다.

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": ["open-code-war"]
}
```

### pi

```bash
pi install npm:open-code-war
```

설치 후 에이전트를 재시작하면 다음 프롬프트부터 집계된다.

---

## 동작

- **Node.js 가 PATH 에 있어야 한다.** 어댑터는 함께 배포된 `track.mjs` 를 node 로 실행한다.
  못 찾으면 조용히 집계를 건너뛴다(에이전트 동작은 방해하지 않는다).
- 한 PC 에서 여러 에이전트를 써도 같은 `userId`(`~/.open-code-war/config.json`)로
  **한 사람에 합산**된다. 에이전트별 내역은 리더보드 프로필에서 따로 볼 수 있다.
- `OCW_API_URL` 로 엔드포인트를 바꿀 수 있다(로컬 테스트용).

Claude Code · Codex 는 각 CLI 의 플러그인 체계로 설치한다 —
[전체 설치 안내](https://github.com/dodohankim/opencodewar#-플러그인-설치) 참고.

## 라이선스

BUSL-1.1

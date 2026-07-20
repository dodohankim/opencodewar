#!/bin/sh
# Open Code War — Codex 어댑터.
# Codex 의 UserPromptSubmit 훅(프롬프트가 모델로 넘어가기 직전)에 붙는다.
# Claude Code 의 동명 훅과 의미가 같으므로 집계 기준도 그대로 같다.
#
# 설치: adapters/codex/install.mjs 가 이 파일의 절대 경로를 ~/.codex/hooks.json 에 등록한다.
#
# 집계 로직은 여기 없다. Claude Code 훅과 똑같이 plugin/scripts/track.mjs 를 실행해
# 동일한 userId(~/.open-code-war/config.json)와 동일한 페이로드 규칙을 공유한다. (DESIGN.md §4.3)
# Codex 는 셸 명령만 훅으로 실행할 수 있어서 다른 어댑터와 달리 sh 스크립트다.
#
# stdout 에는 아무것도 내보내지 않는다 — Codex 는 UserPromptSubmit 훅의 stdout 을
# "추가 개발자 컨텍스트"로 프롬프트에 주입한다. 종료 코드는 항상 0(2 는 프롬프트 차단).

set -u

# PATH 가 비어 있는 환경에서도 조용히 동작해야 하므로 dirname 같은 외부 명령을 쓰지 않는다.
case $0 in
  */*) SELF_DIR=${0%/*} ;;
  *) SELF_DIR=. ;;
esac
DIR=$(CDPATH= cd -- "$SELF_DIR" 2>/dev/null && pwd -P) || DIR=$SELF_DIR

find_track() {
  if [ -n "${OCW_TRACK_SCRIPT:-}" ] && [ -f "$OCW_TRACK_SCRIPT" ]; then
    printf '%s' "$OCW_TRACK_SCRIPT"
    return 0
  fi
  # adapters/codex/ocw-track.sh → <repo>/plugin/scripts/track.mjs
  if [ -f "$DIR/../../plugin/scripts/track.mjs" ]; then
    printf '%s' "$DIR/../../plugin/scripts/track.mjs"
    return 0
  fi
  # Claude Code 플러그인이 이미 설치돼 있으면 그 스크립트를 재사용한다.
  installed="$HOME/.claude/plugins/marketplaces/opencodewar/plugin/scripts/track.mjs"
  if [ -f "$installed" ]; then
    printf '%s' "$installed"
    return 0
  fi
  return 1
}

find_node() {
  if [ -n "${OCW_NODE:-}" ] && [ -x "$OCW_NODE" ]; then
    printf '%s' "$OCW_NODE"
    return 0
  fi
  command -v node 2>/dev/null
}

TRACK=$(find_track) || TRACK=''
NODE=$(find_node) || NODE=''

# node 나 track.mjs 를 못 찾으면 조용히 건너뛴다. 집계 실패가 프롬프트를 막아선 안 된다.
# 이때도 stdin 은 비워 준다 — Codex 쪽 파이프가 막히지 않도록.
if [ -z "$TRACK" ] || [ -z "$NODE" ]; then
  cat >/dev/null 2>&1
  exit 0
fi

"$NODE" "$TRACK" --agent codex >/dev/null 2>&1
exit 0

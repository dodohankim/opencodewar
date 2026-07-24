#!/bin/sh
# 리포트 즉시 발송 — 로컬에서 Worker 코드를 실행해 실DB 조회 + 실제 디스코드 발송.
#   npm run send          # 전체(사용량 + 유저)
#   npm run send:usage    # CF 사용량만
#   npm run send:user     # OCW 유저 리포트만
# secrets 는 .dev.vars 에서 읽음. 리포트 선택은 /__scheduled 의 cron 문자열로 전달된다.
set -e
cd "$(dirname "$0")"
KIND="${1:-all}"
case "$KIND" in
  all) CRON='50+23+*+*+*' ;;
  usage | user) CRON="$KIND" ;;
  *) echo "usage: send-now.sh [all|usage|user]" >&2; exit 1 ;;
esac
PORT="${PORT:-8797}"
LOG=/tmp/cf-usage-send.log

npx wrangler dev --test-scheduled --port "$PORT" > "$LOG" 2>&1 &
PID=$!
trap 'kill $PID 2>/dev/null' EXIT

for i in $(seq 1 30); do
  curl -s -o /dev/null "http://localhost:$PORT/" 2>/dev/null && break
  sleep 1
done
curl -s "http://localhost:$PORT/__scheduled?cron=$CRON"
echo
sleep 5 # waitUntil(웹훅 fetch) 완료 대기
echo "발송 완료($KIND) — #ocw-리포트 확인 (로그: $LOG)"

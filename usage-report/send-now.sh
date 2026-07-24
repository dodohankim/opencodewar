#!/bin/sh
# 일일 리포트 즉시 발송 — 로컬에서 Worker 코드를 실행해 실DB 조회 + 실제 디스코드 발송.
# 사용법: usage-report/ 에서  npm run send   (secrets 는 .dev.vars 에서 읽음)
set -e
cd "$(dirname "$0")"
PORT="${PORT:-8797}"
LOG=/tmp/cf-usage-send.log

npx wrangler dev --test-scheduled --port "$PORT" > "$LOG" 2>&1 &
PID=$!
trap 'kill $PID 2>/dev/null' EXIT

for i in $(seq 1 30); do
  curl -s -o /dev/null "http://localhost:$PORT/" 2>/dev/null && break
  sleep 1
done
curl -s "http://localhost:$PORT/__scheduled?cron=50+23+*+*+*"
echo
sleep 5 # waitUntil(웹훅 fetch) 완료 대기
echo "발송 완료 — #ocw-리포트 확인 (로그: $LOG)"

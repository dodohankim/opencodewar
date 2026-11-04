// 막사 P0 프로브: 1초마다 한 줄씩 5번 출력하고 끝난다.
// mod 가 $.process.spawn 으로 이걸 띄워서, 줄이 1초 간격으로 도착하면 "실시간 스트리밍 OK".
// (P1 에서는 이 자리에 WebSocket 사이드카가 들어간다 — DESIGN.md §27.5 B안)
let n = 0
const timer = setInterval(() => {
  n += 1
  process.stdout.write(`tick ${n} ${new Date().toISOString()}\n`)
  if (n >= 5) clearInterval(timer)
}, 1000)

// 막사 사이드카 (DESIGN.md §27.5 B안)
//
// mod 의 $.process.spawn 은 stdout 을 실시간으로 흘려주지만 stdin 은 시작할 때 한 번만 넣을 수 있다.
// 그래서 역할을 나눈다:
//   · 수신: 서버 WebSocket → 이 프로세스 → stdout 한 줄에 JSON 하나 → mod
//   · 송신: mod → 127.0.0.1 의 작은 HTTP 서버(임의 포트·임의 토큰) → 이 프로세스 → WebSocket
// 시작 입력(stdin): {"url":"wss://…/space/ws?room=…&t=…"}
// 첫 줄로 {"t":"_link","port":…,"token":"…"} 를 알려준다. 끝날 때 {"t":"_closed","code":…}.

import { createServer } from 'node:http';
import { randomBytes } from 'node:crypto';

const out = (o) => process.stdout.write(JSON.stringify(o) + '\n');

let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (c) => (input += c));
process.stdin.on('end', start);

function start() {
  let url;
  try {
    url = JSON.parse(input).url;
  } catch {
    out({ t: '_error', code: 'bad_input' });
    process.exit(2);
  }
  if (typeof WebSocket !== 'function') {
    out({ t: '_error', code: 'node_too_old', node: process.version });
    process.exit(3);
  }

  const token = randomBytes(16).toString('hex');
  const ws = new WebSocket(url);
  const pending = [];
  let closed = false;

  const finish = (code) => {
    if (closed) return;
    closed = true;
    out({ t: '_closed', code });
    server.close();
    setTimeout(() => process.exit(0), 50);
  };

  ws.addEventListener('open', () => {
    for (const m of pending.splice(0)) ws.send(m);
  });
  ws.addEventListener('message', (e) => {
    if (typeof e.data === 'string' && e.data !== 'pong') process.stdout.write(e.data.replace(/\n/g, ' ') + '\n');
  });
  ws.addEventListener('close', (e) => finish(e.code));
  ws.addEventListener('error', () => finish(1006));

  // 송신 창구: 127.0.0.1 에만 열고, 토큰이 맞을 때만 받는다
  const server = createServer((req, res) => {
    if (req.headers['x-link-token'] !== token) {
      res.writeHead(403).end();
      return;
    }
    let body = '';
    req.setEncoding('utf8');
    req.on('data', (c) => {
      body += c;
      if (body.length > 4096) req.destroy();
    });
    req.on('end', () => {
      if (req.url === '/close') {
        res.writeHead(200).end('ok');
        try {
          ws.close(1000, 'bye');
        } catch {}
        setTimeout(() => finish(1000), 300);
        return;
      }
      if (req.url === '/send') {
        if (ws.readyState === WebSocket.OPEN) ws.send(body);
        else if (ws.readyState === WebSocket.CONNECTING) pending.push(body);
        res.writeHead(200).end('ok');
        return;
      }
      res.writeHead(404).end();
    });
  });
  server.listen(0, '127.0.0.1', () => out({ t: '_link', port: server.address().port, token }));

  // 연결 유지: 서버는 'ping' 에 DO 를 깨우지 않고 'pong' 으로 답한다
  setInterval(() => {
    if (ws.readyState === WebSocket.OPEN) ws.send('ping');
  }, 25_000).unref();

  // Claude Code 가 사라지면(고아 프로세스) 같이 끝낸다
  const parent = process.ppid;
  setInterval(() => {
    if (process.ppid !== parent) {
      try {
        ws.close(1001, 'parent gone');
      } catch {}
      finish(1001);
    }
  }, 3000).unref();
}

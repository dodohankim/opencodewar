// Open Code War — 막사(Space) mod (DESIGN.md §27)
//
// /space 를 열면 광장에 선다. 광장에는 지금 켜져 있거나 누가 들어가 있는 막사 문이 줄지어 있고,
// 문 앞에서 e 를 누르면 그 막사로 들어간다. 막사 왼쪽 끝 문에서 e 를 누르면 광장으로 나온다.
// 같은 방에 있는 사람들(터미널·웹)이 실시간으로 보이고, 채팅은 그 방 사람들끼리.
//
// 통신 (§27.5): 서버 WebSocket 은 사이드카(link/link.mjs)가 잡는다.
//   수신 = 사이드카 stdout 한 줄에 JSON 하나 → 이 모듈
//   송신 = 이 모듈 → 127.0.0.1 사이드카 HTTP → WebSocket
// 주인 작업 상태 (§27.7): 이 세션의 턴 시작·끝 + 2분 하트비트를 /space/status 로 보낸다.
//   보내는 건 working/idle 값뿐 — 프롬프트·도구 내용은 보지 않는다.

const PANE = 'ocw-space'
const SW = 8 // 병정 폭(px)
const SH = 10 // 병정 높이(px) → 5줄
const TICK_MS = 150
const STEP = 2
const LOG_MAX = 60
const BUBBLE_MS = 5000
const MOVE_SEND_MS = 90 // 이동 전송 최소 간격
const STATUS_BEAT_MS = 120_000
const DOOR_REACH = 6 // 문 앞 판정 거리(px)
const EXIT_X = 2 // 막사 안 나가는 문 위치
const DEFAULT_ENDPOINT = 'https://opencodewar.dev'

// ── 스프라이트: 8×10 미니 병정 (web/index.html SPRITES 의 16×16 병정을 축소해 다시 찍음) ──
// H·U = 군복, S = 피부, E = 눈, R·B·M·K = 장비(검정 잉크), F = 깃발, W·I·O·L = 문(나무·안쪽·손잡이·등)
const SPRITES = {
  stand: [
    '..HHH..R', '.HHHHH.R', '..SSE..R', '..SSS..R', '.UUUUUUR',
    '.U.UUU.R', '...UUU..', '...U.U..', '...U.U..', '..BB.BB.',
  ],
  walk: [
    '..HHH..R', '.HHHHH.R', '..SSE..R', '..SSS..R', '.UUUUUUR',
    '.U.UUU.R', '...UUU..', '..U..U..', '.U....U.', 'BB....BB',
  ],
  type1: [
    '........', '..HHH...', '.HHHHH..', '..SSE...', '..SSS..M',
    '.UUUUSSM', '.UUUU..M', '.UUUUKKK', '..UUUU..', '.BBBBBB.',
  ],
  type2: [
    '........', '..HHH...', '.HHHHH..', '..SSE...', '..SSS..M',
    '.UUUU..M', '.UUUUSSM', '.UUUUKKK', '..UUUU..', '.BBBBBB.',
  ],
  door: [
    '..LLLL..', 'WWWWWWWW', 'WIIIIIIW', 'WIIIIIIW', 'WIIIIIIW',
    'WIIIIOIW', 'WIIIIIIW', 'WIIIIIIW', 'WIIIIIIW', 'WWWWWWWW',
  ],
}

// 'ink' = 터미널 기본 글자색(웹의 --fg). 라이트/다크 터미널 모두에서 보인다.
const INK = 'ink'
const SKIN = 0xe8c39e
const EYE = 0x232320
const OK = 0x4f8258
// 군복색 = 주 에이전트 (웹 .army-* 와 같은 매핑)
const ARMY = { 'claude-code': INK, codex: 0x3e6fb8, opencode: 0xb8742e, pi: 0x7c55b0 }
const armyOf = (agent) => ARMY[agent] ?? INK

function pixelColor(ch, army, flag, lit) {
  switch (ch) {
    case 'H': case 'U': return army
    case 'S': return SKIN
    case 'E': return EYE
    case 'F': return flag
    case 'R': case 'B': case 'M': case 'K': return INK
    case 'W': return 0x8a5a2b
    case 'I': return 0x3b2a1a
    case 'O': return 0xd9a441
    case 'L': return lit ? 0xffd166 : 0x5a4630
    default: return null
  }
}

// ── Raster 셀 패킹 ──
// 한 셀 = [코드포인트, 글자색, 배경색] (uint32 ×3). 0x01000000 = 터미널 기본색.
const DEFAULT = 0x01000000

/** 위·아래 두 픽셀을 반블록 한 칸으로. null = 투명, INK = 기본 글자색, 숫자 = RGB */
export function halfBlock(top, bottom) {
  const col = (p) => (p === null || p === INK ? DEFAULT : p)
  if (top === null && bottom === null) return [0x20, DEFAULT, DEFAULT]
  if (top === bottom) return [0x2588, col(top), DEFAULT] // █
  if (top === null) return [0x2584, col(bottom), DEFAULT] // ▄
  if (bottom === null) return [0x2580, col(top), DEFAULT] // ▀
  // 기본 글자색은 배경 칸에 못 넣는다 → 잉크 쪽을 글자로 그린다
  if (top === INK) return [0x2580, DEFAULT, bottom]
  if (bottom === INK) return [0x2584, DEFAULT, top]
  return [0x2580, top, bottom]
}

function toBase64(u8) {
  if (typeof u8.toBase64 === 'function') return u8.toBase64()
  let s = ''
  for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode(...u8.subarray(i, i + 0x8000))
  return btoa(s)
}

export function packCells(cells) {
  return toBase64(new Uint8Array(Uint32Array.from(cells.flat(2)).buffer))
}

function blank(w, h) {
  return Array.from({ length: h }, () => new Array(w).fill(null))
}

function stamp(buf, map, x0, y0, { army = INK, flag = OK, mirror = false, lit = false } = {}) {
  const h = buf.length
  const w = buf[0].length
  const mw = map[0].length
  for (let y = 0; y < map.length; y++) {
    for (let x = 0; x < mw; x++) {
      const p = pixelColor(map[y][mirror ? mw - 1 - x : x], army, flag, lit)
      if (p === null) continue
      const bx = x0 + x
      const by = y0 + y
      if (bx >= 0 && bx < w && by >= 0 && by < h) buf[by][bx] = p
    }
  }
}

/** 픽셀 버퍼(짝수 높이) → 반블록 셀 행렬 */
export function toCells(buf) {
  const rows = []
  for (let y = 0; y < buf.length; y += 2) {
    const row = []
    for (let x = 0; x < buf[0].length; x++) row.push(halfBlock(buf[y][x], buf[y + 1]?.[x] ?? null))
    rows.push(row)
  }
  return rows
}

// ── 글자 폭(한글·CJK·이모지 = 2칸) ──
export function charWidth(cp) {
  if (cp < 0x1100) return 1
  if (
    (cp >= 0x1100 && cp <= 0x115f) || (cp >= 0x2e80 && cp <= 0xa4cf) ||
    (cp >= 0xac00 && cp <= 0xd7a3) || (cp >= 0xf900 && cp <= 0xfaff) ||
    (cp >= 0xfe30 && cp <= 0xfe4f) || (cp >= 0xff00 && cp <= 0xff60) ||
    (cp >= 0xffe0 && cp <= 0xffe6) || (cp >= 0x1f300 && cp <= 0x1faff)
  ) return 2
  return 1
}

export function dispWidth(s) {
  let w = 0
  for (const ch of s) w += charWidth(ch.codePointAt(0))
  return w
}

export function clip(s, max) {
  if (dispWidth(s) <= max) return s
  let w = 0
  let out = ''
  for (const ch of s) {
    const cw = charWidth(ch.codePointAt(0))
    if (w + cw > max - 1) break
    out += ch
    w += cw
  }
  return out + '…'
}

/** 폭 width 의 한 줄에 라벨들을 x 위치(가운데 정렬)에 놓는다. 겹치면 나중 것이 이긴다. */
export function placeLabels(width, labels) {
  // cells[i] = 그 칸의 글자, '' = 왼쪽 넓은 글자의 뒷칸
  const cells = new Array(width).fill(' ')
  for (const { x, text } of labels) {
    const w = dispWidth(text)
    let i = Math.max(0, Math.min(width - w, Math.round(x - w / 2)))
    for (const ch of text) {
      const cw = charWidth(ch.codePointAt(0))
      if (i + cw > width) break
      for (let j = i; j < i + cw; j++) {
        if (cells[j] === '' && j - 1 < i) cells[j - 1] = ' '
        if (cells[j + 1] === '' && j + 1 >= i + cw) cells[j + 1] = ' '
      }
      cells[i] = ch
      if (cw === 2) cells[i + 1] = ''
      i += cw
    }
  }
  return cells.join('')
}

function hhmm(ms) {
  const d = new Date(ms)
  return String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0')
}

// ── 방 상태 ──
// conn.status: idle(안 열림) · connecting · open · closed(끊김, 재연결 대기) · error(안내 문구)
export function emptyRoom() {
  return {
    status: 'idle',
    note: '',
    you: null, // { id, role, pid, nick, agent }
    room: null, // { id, kind, width, cap, owner, doors }
    members: new Map(), // id → { id, pid, nick, agent, x, dir, state, walkUntil }
    bubbles: {}, // memberId|'me' → { text, until }
    log: [], // { at, nick, text, kind }
  }
}

export const me = { x: 12, dir: 1, walkUntil: 0 }
let view = emptyRoom()
let isOpen = false
let chatMode = false
let openedAt = 0
let tick = 0
let isWorking = false // 이 세션의 Claude 가 턴 진행 중
let cfg = null // { userId, nickname, endpoint }
let link = null // { gen, port, token }
let gen = 0 // 연결 세대 — 방을 옮기면 이전 사이드카 출력은 버린다
let wantRoom = 'plaza'
let lastMoveSent = 0
let moveTimer = null
let sid = ''
let pendingDoorReturn = null // 막사에서 광장으로 나올 때, 방금 나온 막사 문 앞에 세운다

function pushLog(entry) {
  view.log.push(entry)
  if (view.log.length > LOG_MAX) view.log.splice(0, view.log.length - LOG_MAX)
}

/** 서버 메시지 하나 → 화면 상태. 순수 함수에 가깝게(테스트에서 직접 부른다). */
export function applyServer(v, msg, now) {
  switch (msg.t) {
    case 'hello': {
      v.status = 'open'
      v.note = ''
      v.you = msg.you
      v.room = msg.room
      v.members = new Map()
      for (const m of msg.members ?? []) v.members.set(m.id, { ...m, walkUntil: 0 })
      v.log = []
      for (const l of msg.chat ?? []) v.log.push({ at: l.at, nick: l.nick, text: l.text, kind: 'chat' })
      const where = msg.room.kind === 'plaza' ? '광장' : (msg.room.owner?.nick ?? '?') + '의 막사'
      v.log.push({ at: now, nick: '', text: where + '에 들어왔습니다' + (msg.you.role === 'spectator' ? ' (관전)' : ''), kind: 'notice' })
      if (msg.room.kind === 'barracks') me.x = EXIT_X + 10
      else if (pendingDoorReturn) {
        const d = (msg.room.doors ?? []).find((x) => x.pid === pendingDoorReturn)
        if (d) me.x = d.x
      }
      pendingDoorReturn = null
      me.x = Math.max(0, Math.min(msg.room.width - SW, me.x))
      return
    }
    case 'join':
      v.members.set(msg.m.id, { ...msg.m, walkUntil: 0 })
      v.log.push({ at: now, nick: '', text: msg.m.nick + ' 님이 들어왔습니다', kind: 'notice' })
      return
    case 'leave': {
      const m = v.members.get(msg.id)
      v.members.delete(msg.id)
      delete v.bubbles[msg.id]
      if (m) v.log.push({ at: now, nick: '', text: m.nick + ' 님이 나갔습니다', kind: 'notice' })
      return
    }
    case 'move': {
      const m = v.members.get(msg.id)
      if (m) Object.assign(m, { x: msg.x, dir: msg.dir, walkUntil: now + 400 })
      return
    }
    case 'state': {
      const m = v.members.get(msg.id)
      if (m) m.state = msg.state
      return
    }
    case 'said': {
      const l = msg.line
      const who = l.pid && l.pid === v.you?.pid ? 'me' : [...v.members.values()].find((m) => m.pid === l.pid)?.id
      if (who) v.bubbles[who] = { text: l.text, until: now + BUBBLE_MS }
      v.log.push({ at: l.at, nick: l.nick, text: l.text, kind: 'chat' })
      return
    }
    case 'owner':
      if (v.room) v.room.owner = msg.owner
      return
    case 'doors':
      if (v.room?.kind === 'plaza') {
        v.room.doors = msg.doors
        v.room.width = msg.width
      }
      return
    case 'error': {
      const text = {
        full: '방이 꽉 찼어요 (최대 인원)',
        replaced: '다른 곳(웹·다른 터미널)에서 같은 계정으로 들어와서 여기 연결은 닫혔어요',
        slow_down: '조금 천천히 말해 주세요',
      }[msg.code]
      if (text) v.log.push({ at: now, nick: '', text, kind: 'notice' })
      if (msg.code === 'full' || msg.code === 'replaced') {
        v.status = 'error'
        v.note = text
      }
      return
    }
  }
}

/** 지금 서 있는 곳 앞의 문: 광장은 막사 문, 막사는 나가는 문 */
export function doorAt(v, x) {
  if (!v.room) return null
  if (v.room.kind === 'barracks') return Math.abs(x - EXIT_X) <= DOOR_REACH ? { kind: 'exit' } : null
  for (const d of v.room.doors ?? []) if (Math.abs(x - d.x) <= DOOR_REACH) return { kind: 'enter', door: d }
  return null
}

function frameOf(e, now, working) {
  if (e.walkUntil > now) return tick % 4 < 2 ? 'walk' : 'stand'
  if (working) return tick % 4 < 2 ? 'type1' : 'type2'
  return 'stand'
}

/** 화면 한 장: 카메라 위치, 픽셀 버퍼, 말풍선·이름·문 이름 줄 */
export function compose(v, viewCols, now, meWorking) {
  const width = v.room?.width ?? 96
  const cols = Math.max(SW + 4, Math.min(width, viewCols))
  const cam = Math.max(0, Math.min(width - cols, Math.round(me.x + SW / 2 - cols / 2)))
  const buf = blank(cols, SH + 2)
  for (let x = 0; x < cols; x++) buf[SH + 1][x] = (x + cam) % 2 === 0 ? 0x6c6c68 : 0x9c9c97

  const signs = []
  const names = []
  const bubbles = []
  const owner = v.room?.owner ?? null

  if (v.room?.kind === 'plaza') {
    for (const d of v.room.doors ?? []) {
      stamp(buf, SPRITES.door, d.x - cam, 0, { lit: d.ownerOnline })
      const label = clip(d.nick, 8) + ' ' + d.count + (d.ownerWorking ? '⌨' : '')
      signs.push({ x: d.x - cam + SW / 2, text: label })
    }
  } else if (v.room?.kind === 'barracks') {
    stamp(buf, SPRITES.door, EXIT_X - cam, 0, { lit: true })
    signs.push({ x: EXIT_X - cam + SW / 2, text: '광장' })
    // 주인이 이 방에 없지만 Claude Code 를 켜 두었으면 책상에 앉아 있다. 꺼져 있으면 "외출 중".
    const ownerHere = owner && (v.you?.pid === owner.pid || [...v.members.values()].some((m) => m.pid === owner.pid))
    const deskX = width - SW - 6
    if (owner && !ownerHere) {
      if (owner.online) {
        stamp(buf, SPRITES[owner.working ? (tick % 4 < 2 ? 'type1' : 'type2') : 'stand'], deskX - cam, 0, { army: armyOf(owner.agent) })
        names.push({ x: deskX - cam + SW / 2, text: '★' + clip(owner.nick, 8) + (owner.working ? '⌨' : '') })
      } else {
        signs.push({ x: deskX - cam + SW / 2, text: '외출 중' })
      }
    }
  }

  const ents = [...v.members.values()].map((m) => ({ ...m, isMe: false }))
  if (v.you?.role === 'member') ents.push({ id: 'me', pid: v.you.pid, nick: v.you.nick, agent: v.you.agent, x: me.x, dir: me.dir, walkUntil: me.walkUntil, state: meWorking ? 'working' : 'idle', isMe: true })
  for (const e of ents) {
    const isOwner = owner && e.pid === owner.pid
    const working = e.state === 'working' || (isOwner && owner.working)
    const sx = Math.round(e.x) - cam
    stamp(buf, SPRITES[frameOf(e, now, working)], sx, 0, { army: armyOf(e.agent), mirror: e.dir < 0 })
    const mid = sx + SW / 2
    if (mid < -SW || mid > cols + SW) continue
    names.push({ x: mid, text: (e.isMe ? '▸' : '') + (isOwner ? '★' : '') + clip(e.nick, 8) + (working ? '⌨' : '') })
    const b = v.bubbles[e.id]
    if (b && b.until > now) bubbles.push({ x: mid, text: '「' + clip(b.text, 12) + '」' })
  }
  return {
    cols,
    cam,
    buf,
    bubbleRow: placeLabels(cols, bubbles),
    nameRow: placeLabels(cols, names),
    signRow: placeLabels(cols, signs),
  }
}

function svgOf(sc) {
  const px = 4
  const w = sc.cols * px
  const h = sc.buf.length * px
  let rects = ''
  for (let y = 0; y < sc.buf.length; y++) {
    for (let x = 0; x < sc.cols; x++) {
      const p = sc.buf[y][x]
      if (p === null) continue
      const fill = p === INK ? '#1B1B1A' : '#' + p.toString(16).padStart(6, '0')
      rects += `<rect x="${x * px}" y="${y * px}" width="${px}" height="${px}" fill="${fill}"/>`
    }
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${h}" shape-rendering="crispEdges"><rect width="${w}" height="${h}" fill="#F6F6F4"/>${rects}</svg>`
}

// ── 설정 · 네트워크 ──

async function loadConfig($) {
  try {
    const home = await $.env.get('HOME')
    const raw = home ? await $.fs.read(home + '/.open-code-war/config.json') : null
    const c = raw ? JSON.parse(typeof raw === 'string' ? raw : raw?.text ?? '') : null
    const env = await $.env.get('OCW_API_URL')
    if (!c || typeof c.userId !== 'string') return null
    const endpoint = String(env || c.endpoint || DEFAULT_ENDPOINT).replace(/\/+$/, '')
    return { userId: c.userId, nickname: typeof c.nickname === 'string' ? c.nickname : null, endpoint }
  } catch {
    return null
  }
}

async function api($, path, body) {
  const r = await $.http.fetch(cfg.endpoint + path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  let data = null
  try {
    data = JSON.parse(r.text)
  } catch {}
  return { ok: r.ok, status: r.status, data }
}

async function reportStatus($, state) {
  if (!cfg) return
  try {
    await api($, '/space/status', { userId: cfg.userId, sid, state })
  } catch {}
}

function send($, msg) {
  const l = link
  if (!l || l.gen !== gen) return
  $.http
    .fetch(`http://127.0.0.1:${l.port}/send`, { method: 'POST', headers: { 'x-link-token': l.token }, body: JSON.stringify(msg) })
    .catch(() => {})
}

async function closeSidecar($, l) {
  try {
    await $.http.fetch(`http://127.0.0.1:${l.port}/close`, { method: 'POST', headers: { 'x-link-token': l.token }, body: '' })
  } catch {}
}

async function closeLink($) {
  const l = link
  link = null
  if (l) await closeSidecar($, l)
}

/** 입장 직후 서버에 알려 줄 내 상태. 서버의 시작 위치는 임의값이라 내 x 를 보내야 남들 화면과 맞는다. */
export function syncMessages(x, dir, working) {
  const out = [{ t: 'move', x, dir }]
  if (working) out.push({ t: 'state', state: 'working' })
  return out
}

function redraw($) {
  if (isOpen) $.ui.invalidate('ui.render')
}

/** 방에 들어간다: 티켓 → 사이드카 spawn → stdout 을 읽어 상태 반영. 끊기면 3초 뒤 다시. */
async function connect($, room) {
  wantRoom = room
  const my = ++gen
  await closeLink($)
  view = emptyRoom()
  view.status = 'connecting'
  view.note = room === 'plaza' ? '광장으로 가는 중…' : '막사로 가는 중…'
  redraw($)

  cfg = cfg ?? (await loadConfig($))
  if (!cfg) {
    view.status = 'error'
    view.note = 'Open Code War 플러그인 설정(~/.open-code-war/config.json)이 없어요. 먼저 플러그인을 설치하고 프롬프트를 한 번 보내 주세요.'
    redraw($)
    return
  }
  let t
  try {
    t = await api($, '/space/ticket', { userId: cfg.userId })
  } catch (err) {
    t = { ok: false, status: 0, data: { error: String(err?.message ?? err) } }
  }
  if (my !== gen) return
  if (!t.ok || !t.data?.ticket) {
    view.status = 'closed'
    view.note = '서버에 연결할 수 없어요 (' + (t.data?.error ?? t.status) + ') — 잠시 뒤 다시 시도합니다'
    redraw($)
    $.clock.after(5000, () => my === gen && isOpen && connect($, room))
    return
  }
  const url = cfg.endpoint.replace(/^http/, 'ws') + '/space/ws?room=' + encodeURIComponent(room) + '&t=' + encodeURIComponent(t.data.ticket)

  let buffer = ''
  let reason = null
  try {
    const it = $.process.spawn({ argv: ['node', $.plugin.root + '/link/link.mjs'], input: JSON.stringify({ url }) })
    while (true) {
      const r = await it.next()
      if (r.done) break
      if (r.value.stream !== 'stdout') continue
      buffer += r.value.text
      let nl
      while ((nl = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, nl)
        buffer = buffer.slice(nl + 1)
        if (!line.trim()) continue
        let msg
        try {
          msg = JSON.parse(line)
        } catch {
          continue
        }
        // 이미 다른 방으로 옮겼거나 닫았다. 출력은 버리되, 포트를 알기 전에 떠났으면 여기서 닫아 줘야
        // 사이드카가 그 방에 유령으로 남지 않는다.
        if (my !== gen) {
          if (msg.t === '_link') closeSidecar($, { port: msg.port, token: msg.token })
          continue
        }
        if (msg.t === '_link') {
          link = { gen: my, port: msg.port, token: msg.token }
          if (view.status === 'open') for (const m of syncMessages(me.x, me.dir, isWorking)) send($, m)
          continue
        }
        if (msg.t === '_error') {
          reason = msg.code === 'node_too_old' ? `Node 22 이상이 필요해요 (지금 ${msg.node})` : msg.code
          continue
        }
        if (msg.t === '_closed') continue
        applyServer(view, msg, await $.clock.now())
        if (msg.t === 'hello' && link?.gen === my) for (const m of syncMessages(me.x, me.dir, isWorking)) send($, m)
        redraw($)
      }
    }
  } catch (err) {
    reason = String(err?.message ?? err)
  }
  if (my !== gen) return
  link = null
  if (view.status === 'error') {
    redraw($)
    return
  }
  view.status = 'closed'
  view.note = reason ? '연결 실패: ' + reason : '연결이 끊겼어요 — 다시 연결하는 중…'
  redraw($)
  if (!reason || !reason.startsWith('Node')) $.clock.after(3000, () => my === gen && isOpen && connect($, wantRoom))
}

export function register(on) {
  on('session.start', async ($, e, next) => {
    sid = crypto.randomUUID().replace(/-/g, '')
    cfg = await loadConfig($)
    me.x = 12
    $.clock.every(TICK_MS, () => {
      if (!isOpen) return
      tick += 1
      redraw($)
    })
    // 주인 상태: 켜짐 알림 + 2분 하트비트 (광장 문 불빛·막사 책상의 주인)
    await reportStatus($, 'idle')
    $.clock.every(STATUS_BEAT_MS, () => reportStatus($, isWorking ? 'working' : 'idle'))
    try {
      await $.command.register({ name: 'space', description: '광장 열기 — 막사 문으로 걸어가 e 로 들어가기 (/space home = 내 막사)', argumentHint: '[home]', immediate: true })
    } catch (err) {
      $.ui.log('명령 등록 실패: ' + String(err?.message ?? err))
    }
    return next(e)
  })

  // 이 세션의 Claude 가 일하는 동안 내 병정은 타이핑 — 광장·남의 막사에서도 보인다
  on('turn.start', async ($, e, next) => {
    isWorking = true
    send($, { t: 'state', state: 'working' })
    reportStatus($, 'working')
    redraw($)
    return next(e)
  })
  on('turn.complete', async ($, e, next) => {
    isWorking = false
    send($, { t: 'state', state: 'idle' })
    reportStatus($, 'idle')
    redraw($)
    return next(e)
  })
  on('session.end', async ($, e, next) => {
    gen += 1
    await Promise.allSettled([closeLink($), reportStatus($, 'offline')])
    return next(e)
  })

  on('command.run', { command: 'space' }, async ($, e) => {
    isOpen = true
    chatMode = false
    openedAt = await $.clock.now()
    const r = await $.ui.open({ id: PANE, title: 'OCW 광장', focus: true, closeOnEscape: true, rows: 22 })
    if (r && r.isPlaced === false) $.ui.toast('패널 대기 중: ' + (r.reason ?? '터미널이 좁아요'))
    cfg = cfg ?? (await loadConfig($))
    let room = String(e.args ?? '').trim() === 'home' ? null : 'plaza'
    if (room === null) {
      // 내 막사 = 내 public_id. 티켓을 한 번 받아 알아낸다.
      try {
        const t = cfg ? await api($, '/space/ticket', { userId: cfg.userId }) : null
        room = t?.data?.pid ?? 'plaza'
      } catch {
        room = 'plaza'
      }
    }
    if (view.status === 'open' && view.room?.id === room) return {}
    $.clock.after(0, () => connect($, room))
    return {}
  })

  on('ui.close', async ($, e, next) => {
    if (e.id === PANE) {
      isOpen = false
      chatMode = false
      gen += 1 // 닫으면 방에서 나간다 (광장·막사 인원에서 빠짐)
      closeLink($)
      view = emptyRoom()
    }
    return next(e)
  }).catch(($, e, next) => next(e))

  on('ui.render', { component: 'Pane' }, async ($, e, next) => {
    if (e.requestId !== PANE) return next(e)
    const { Box, Text, Button, Input, Raster, Svg } = $.ui.resolve(e)
    const now = await $.clock.now()
    const bodyCols = e.props?.bodyColumns ?? 60
    const sc = compose(view, bodyCols, now, isWorking)
    const room = view.room
    const isMember = view.you?.role === 'member'
    const count = (room ? view.members.size : 0) + (isMember ? 1 : 0)
    const near = doorAt(view, me.x)

    const focusOn = (key) =>
      $.clock.after(60, async () => {
        try {
          await $.ui.focus({ requestId: PANE, key })
        } catch {}
      })

    const sendMove = () => {
      lastMoveSent = Date.now()
      moveTimer = null
      send($, { t: 'move', x: me.x, dir: me.dir })
    }
    const move = (dx) => {
      if (!room) return
      me.dir = dx > 0 ? 1 : -1
      me.x = Math.max(0, Math.min(room.width - SW, me.x + dx))
      me.walkUntil = now + TICK_MS * 3
      if (Date.now() - lastMoveSent >= MOVE_SEND_MS) sendMove()
      else if (!moveTimer) moveTimer = $.clock.after(MOVE_SEND_MS, sendMove)
      redraw($)
    }
    const enter = () => {
      const d = doorAt(view, me.x)
      if (!d) return
      if (d.kind === 'enter') {
        me.x = EXIT_X + 10
        $.clock.after(0, () => connect($, d.door.pid))
      } else {
        // 광장으로 나오면 방금 나온 막사 문 앞에 선다
        pendingDoorReturn = room?.id ?? null
        me.x = 12
        $.clock.after(0, () => connect($, 'plaza'))
      }
    }

    // 머리줄
    let title = '연결 안 됨'
    if (room?.kind === 'plaza') title = `광장 · ${count}/${room.cap}`
    else if (room?.kind === 'barracks') {
      const o = room.owner
      title = `${o?.nick ?? '?'}의 막사 · ${count}/${room.cap}` + (o ? (o.working ? ' · 주인 작업 중 ⌨' : o.online ? ' · 주인 접속 중' : ' · 주인 외출 중') : '')
    }
    const header = Text({ bold: true, wrap: 'truncate-end', children: [clip(title, bodyCols - 2)] })
    const hint = Text({
      dimColor: true,
      wrap: 'truncate-end',
      children: [
        clip(
          view.status !== 'open'
            ? view.note
            : near
              ? near.kind === 'enter'
                ? `e: ${near.door.nick}의 막사로 들어가기`
                : 'e: 광장으로 나가기'
              : room?.kind === 'plaza'
                ? (room.doors?.length ? 'a/d 로 문 앞까지 걸어가서 e' : '아직 켜진 막사가 없어요 · /space home 으로 내 막사') + ' · t 채팅 · Esc 닫기'
                : 'a/d 이동 · 왼쪽 문에서 e 로 광장 · t 채팅 · Esc 닫기',
          bodyCols,
        ),
      ],
    })

    const scene =
      e.surface === 'terminal'
        ? Raster({ key: 'scene', columns: sc.cols, rows: sc.buf.length / 2, cells: packCells(toCells(sc.buf)) })
        : Svg({ source: svgOf(sc), alt: (room?.kind === 'plaza' ? '광장' : '막사') + ' 장면: ' + count + '명' })

    const buttons = Box({
      flexDirection: 'row',
      columnGap: 2,
      children: [
        Button({ key: 'left', label: '←', hotkey: 'a', plain: true, onPress: () => move(-STEP) }),
        Button({ key: 'right', label: '→', hotkey: 'd', plain: true, onPress: () => move(STEP) }),
        Button({ key: 'enter', label: '들어가기', hotkey: 'e', plain: true, dimColor: !near, onPress: enter }),
        Button({
          key: 'talk',
          label: '채팅',
          hotkey: 't',
          plain: true,
          dimColor: !isMember,
          onPress: async () => {
            if ((await $.clock.now()) - openedAt < 500) return // /space 를 친 Enter 가 눌러버리는 것 방지
            if (!isMember) return
            chatMode = true
            redraw($)
            focusOn('chat')
          },
        }),
      ],
    })

    const chatInput = Input({
      key: 'chat',
      label: chatMode ? '채팅' : '채팅(t)',
      placeholder: !isMember ? '관전 중에는 말할 수 없어요' : chatMode ? '입력 후 Enter · 빈 Enter/Tab = 이동 모드' : 't 를 누르면 여기로',
      value: '',
      submitLabel: '보내기',
      onSubmit: async (value) => {
        const text = String(value ?? '').trim().slice(0, 200)
        if (!text || !isMember) {
          chatMode = false
          redraw($)
          focusOn('right')
          return
        }
        chatMode = true
        send($, { t: 'say', text })
        redraw($)
        focusOn('chat')
      },
    })

    // 채팅 로그는 입력창 바로 위에 아래부터 쌓인다
    // 고정 줄: 머리 2 + 말풍선 1 + 장면 6 + 이름 1 + 문 이름 1 + 버튼 1 + 입력 1
    const bodyRows = e.props?.scroll?.bodyRows ?? 22
    const logRows = Math.max(3, bodyRows - 13)
    const recent = view.log.slice(-logRows)
    const logLines = [
      ...Array.from({ length: logRows - recent.length }, () => Text({ children: [' '] })),
      ...recent.map((l) =>
        Text({
          dimColor: l.kind === 'notice',
          wrap: 'truncate-end',
          children: [l.kind === 'notice' ? `· ${l.text}` : `${hhmm(l.at)} ${l.nick}: ${l.text}`],
        }),
      ),
    ]

    return Box({
      flexDirection: 'column',
      children: [
        header,
        hint,
        Text({ wrap: 'truncate-end', children: [sc.bubbleRow] }),
        scene,
        Text({ wrap: 'truncate-end', children: [sc.nameRow] }),
        Text({ dimColor: true, wrap: 'truncate-end', children: [sc.signRow] }),
        buttons,
        ...logLines,
        chatInput,
      ],
    })
  })
}

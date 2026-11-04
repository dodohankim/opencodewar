// Open Code War — 막사(Space) P0 로컬 프로토타입 (DESIGN.md §27)
//
// 서버 없이 로컬에서만 돈다. 확인하려는 것(§27.12):
//   1) 패널 포커스 상태의 키 입력 — 방향키는 mod 에 못 묶으므로 a/d 로 이동
//   2) Raster 위 16×16 병정 스프라이트가 터미널에서 어떻게 보이나 (반블록 ▀▄ → 16칸 × 8줄)
//   3) $.process.spawn 의 stdout 이 실시간으로 흘러오나 (/space-probe) — P1 사이드카 WebSocket 의 성패
//   4) ui.invalidate 스로틀 안에서 걷기 애니메이션이 자연스러운가 (틱 150ms)
//
// 가짜 방문자(NPC) 3명이 막사를 돌아다니고 가끔 말한다. 내 병정은 이 세션의 Claude 가
// 턴을 도는 동안 자동으로 타이핑 모션이 된다(작업 상태 공유 — §27.7).

const PANE = 'ocw-space'
const WORLD = 96 // 막사 폭(px = 터미널 칸). 패널보다 넓으면 카메라가 나를 따라간다.
const SW = 8 // 병정 폭(px)
const SH = 10 // 병정 높이(px) → 5줄
const TICK_MS = 150
const STEP = 2 // a/d 한 번에 움직이는 px
const LOG_MAX = 40
const BUBBLE_MS = 5000

// ── 스프라이트: 8×10 미니 병정 (web/index.html SPRITES 의 16×16 병정을 축소해 다시 찍음) ──
// 터미널에선 반블록 한 칸 = 위아래 2px → 8칸 × 5줄.
// H·U = 군복, S = 피부, E = 눈, R·B·M·K = 장비(검정 잉크), F = 깃발
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
  flag: [
    '.R......', '.RFFFFF.', '.RFFFFF.', '.RFFF...', '.R......',
    '.R......', '.R......', '.R......', '.R......', '.R......',
  ],
}

// 'ink' = 터미널 기본 글자색(웹의 --fg). 라이트/다크 터미널 모두에서 보인다.
const INK = 'ink'
const SKIN = 0xe8c39e
const EYE = 0x232320
const OK = 0x4f8258
// 군복색 = 주 에이전트 (웹 .army-* 와 같은 매핑)
const ARMY = { claude: INK, codex: 0x3e6fb8, opencode: 0xb8742e, pi: 0x7c55b0, rookie: 0xb7862e }

function pixelColor(ch, army, flag) {
  switch (ch) {
    case 'H': case 'U': return army
    case 'S': return SKIN
    case 'E': return EYE
    case 'F': return flag
    case 'R': case 'B': case 'M': case 'K': return INK
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
  if (top === INK) return [0x2580, DEFAULT, bottom] // ▀ 위=잉크, 배경=아래색
  if (bottom === INK) return [0x2584, DEFAULT, top] // ▄ 아래=잉크, 배경=위색
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

// ── 픽셀 버퍼 ──
function blank(w, h) {
  return Array.from({ length: h }, () => new Array(w).fill(null))
}

function stamp(buf, map, x0, y0, { army = INK, flag = OK, mirror = false } = {}) {
  const h = buf.length
  const w = buf[0].length
  const mw = map[0].length
  for (let y = 0; y < map.length; y++) {
    for (let x = 0; x < mw; x++) {
      const ch = map[y][mirror ? mw - 1 - x : x]
      const p = pixelColor(ch, army, flag)
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
        if (cells[j] === '' && j - 1 < i) cells[j - 1] = ' ' // 앞 넓은 글자의 뒷칸을 덮음
        if (cells[j + 1] === '' && j + 1 >= i + cw) cells[j + 1] = ' ' // 넓은 글자의 앞칸을 덮음
      }
      cells[i] = ch
      if (cw === 2) cells[i + 1] = ''
      i += cw
    }
  }
  return cells.join('')
}

// ── 막사 상태 (P0: 로컬 가짜 데이터) ──
const NPC_LINES = [
  '빌드 또 깨짐ㅋㅋ', '오늘 몇 프롬프트 쳤어요?', '교전 들어오실?', '커피 수혈 중',
  '테스트 초록불 🎉', '리팩터링 끝이 안 남', 'Opus 돌려놓고 구경 옴', '막사 좋네요',
  '병장 달았다', '이거 터미널 맞음?', 'ㄱㄴ?', '배포 전 마지막 확인',
]
const NPC_REPLIES = ['ㅋㅋㅋ 인정', '오 ㄹㅇ?', '굿굿', '저도요', '👍', '화이팅입니다', '그쵸']

function makeWorld(nick) {
  return {
    t: 0,
    me: { id: 'me', nick, army: ARMY.claude, x: 24, dir: 1, walkUntil: 0, isMe: true, isOwner: true },
    npcs: [
      { id: 'n1', nick: 'kim', army: ARMY.codex, x: 52, dir: -1, target: null, working: false, walkUntil: 0 },
      { id: 'n2', nick: 'lee', army: ARMY.pi, x: 74, dir: 1, target: null, working: true, walkUntil: 0 },
      { id: 'n3', nick: 'SlyFox42', army: ARMY.rookie, x: 92, dir: -1, target: null, working: false, walkUntil: 0 },
    ],
    bubbles: {}, // id → { text, until }
    log: [], // { at, nick, text, kind }
  }
}

function hhmm(ms) {
  const d = new Date(ms)
  return String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0')
}

// ── 모듈 상태 ──
let world = makeWorld('나')
let isOpen = false
let isWorking = false // 이 세션의 Claude 가 턴 진행 중
let ownerWorking = false // 이 컴퓨터의 Claude 세션 중 하나라도 일하는 중 (주인 상태 — 자동)
let heartbeat = null
let chatMode = false
let openedAt = 0 // 패널을 연 시각 — /space 를 친 Enter 가 패널 버튼까지 누르는 걸 막는다
let probe = { state: 'idle', lines: [] }
let ticker = null

function say(id, nick, text, now) {
  world.bubbles[id] = { text, until: now + BUBBLE_MS }
  world.log.push({ at: now, nick, text, kind: 'chat' })
  if (world.log.length > LOG_MAX) world.log.splice(0, world.log.length - LOG_MAX)
}

function notice(text, now) {
  world.log.push({ at: now, nick: '', text, kind: 'notice' })
  if (world.log.length > LOG_MAX) world.log.splice(0, world.log.length - LOG_MAX)
}

/** 한 틱: NPC 걷기·말하기·작업 토글, 지난 말풍선 정리 */
export function step(w, now, rand = Math.random) {
  w.t += 1
  for (const n of w.npcs) {
    if (n.target === null && rand() < 0.025) {
      n.target = Math.round(10 + rand() * (WORLD - SW - 12))
      n.working = false
    }
    if (n.target !== null) {
      const d = n.target - n.x
      if (Math.abs(d) <= 1) {
        n.x = n.target
        n.target = null
        if (rand() < 0.35) n.working = true
      } else {
        n.dir = d > 0 ? 1 : -1
        n.x += n.dir
        n.walkUntil = now + TICK_MS * 2
      }
    }
    if (rand() < 0.0035) say(n.id, n.nick, NPC_LINES[Math.floor(rand() * NPC_LINES.length)], now)
  }
  for (const [id, b] of Object.entries(w.bubbles)) if (b.until <= now) delete w.bubbles[id]
}

function frameOf(e, now, t, working) {
  if (e.walkUntil > now) return t % 4 < 2 ? 'walk' : 'stand'
  if (working) return t % 4 < 2 ? 'type1' : 'type2'
  return 'stand'
}

/** 화면 한 장: 카메라 위치, 픽셀 버퍼, 이름·말풍선 줄 */
export function compose(w, viewCols, now, meWorking) {
  const cols = Math.max(SW + 4, Math.min(WORLD, viewCols))
  const cam = Math.max(0, Math.min(WORLD - cols, Math.round(w.me.x + SW / 2 - cols / 2)))
  const buf = blank(cols, SH + 2) // 10px 병정 + 2px 바닥 = 6줄

  // 막사 소품: 입구 깃발(주인 = 초록 깃발)
  stamp(buf, SPRITES.flag, 2 - cam, 0, { flag: OK })
  // 바닥
  for (let x = 0; x < cols; x++) buf[SH + 1][x] = (x + cam) % 2 === 0 ? 0x6c6c68 : 0x9c9c97

  const ents = [...w.npcs.map((n) => ({ ...n, isWorking: n.working })), { ...w.me, isWorking: meWorking }]
  const names = []
  const bubbles = []
  for (const e of ents) {
    const sx = Math.round(e.x) - cam
    stamp(buf, SPRITES[frameOf(e, now, w.t, e.isWorking)], sx, 0, { army: e.army, mirror: e.dir < 0 })
    const mid = sx + SW / 2
    if (mid < -SW || mid > cols + SW) continue
    names.push({ x: mid, text: (e.isMe ? '▸' : '') + clip(e.nick, 8) + (e.isWorking ? '⌨' : '') })
    const b = w.bubbles[e.id]
    if (b) bubbles.push({ x: mid, text: '「' + clip(b.text, 12) + '」' })
  }
  return { cols, cam, buf, nameRow: placeLabels(cols, names), bubbleRow: placeLabels(cols, bubbles) }
}

function svgOf(view) {
  const px = 4
  const w = view.cols * px
  const h = view.buf.length * px
  let rects = ''
  for (let y = 0; y < view.buf.length; y++) {
    for (let x = 0; x < view.cols; x++) {
      const p = view.buf[y][x]
      if (p === null) continue
      const fill = p === INK ? '#1B1B1A' : '#' + p.toString(16).padStart(6, '0')
      rects += `<rect x="${x * px}" y="${y * px}" width="${px}" height="${px}" fill="${fill}"/>`
    }
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${h}" shape-rendering="crispEdges"><rect width="${w}" height="${h}" fill="#F6F6F4"/>${rects}</svg>`
}

// ── 사이드카 스트리밍 프로브 (§27.12-3) ──
async function runProbe($) {
  if (probe.state === 'running') return
  probe = { state: 'running', lines: [] }
  const started = await $.clock.now()
  const gaps = []
  let last = started
  try {
    const it = $.process.spawn({ argv: ['node', $.plugin.root + '/probe/tick.mjs'] })
    while (true) {
      const r = await it.next()
      if (r.done) {
        probe.lines.push('종료 코드 ' + (r.value?.code ?? r.value?.signal ?? '?'))
        break
      }
      const now = await $.clock.now()
      for (const line of String(r.value.text).split('\n').filter(Boolean)) {
        probe.lines.push(`+${now - started}ms  ${r.value.stream}: ${line}`)
      }
      gaps.push(now - last)
      last = now
      if (isOpen) $.ui.invalidate('ui.render')
    }
    // 청크가 1초 간격으로 왔으면 스트리밍, 끝에 몰려 왔으면 버퍼링
    const spread = gaps.slice(1)
    const isStreaming = spread.length >= 3 && spread.filter((g) => g > 600).length >= 3
    probe.state = isStreaming ? 'streaming' : 'buffered'
    $.ui.toast(isStreaming ? '프로브: 실시간 스트리밍 OK → P1 사이드카 WS 가능' : '프로브: 출력이 몰려서 옴 → P1 은 폴링(C안)')
  } catch (err) {
    probe.state = 'failed'
    probe.lines.push('실패: ' + String(err?.message ?? err))
    $.ui.toast('프로브 실패: ' + String(err?.message ?? err))
  }
  if (isOpen) $.ui.invalidate('ui.render')
}

async function loadNickname($) {
  try {
    const home = await $.env.get('HOME')
    if (!home) return null
    const raw = await $.fs.read(home + '/.open-code-war/config.json')
    const cfg = JSON.parse(typeof raw === 'string' ? raw : raw?.text ?? '')
    return typeof cfg?.nickname === 'string' && cfg.nickname ? cfg.nickname : null
  } catch {
    return null
  }
}

// ── 주인 작업 상태 (자동, §27.7) ──
// 주인이 Claude 세션을 여러 개 띄워도 하나라도 턴을 돌고 있으면 "작업 중".
// 세션마다 $.store(이 컴퓨터의 모든 세션이 공유)에 자기 키 하나를 쓰고, 막사는 전부 모아서 판정한다.
// 보내는 건 상태값(working/idle)과 시각뿐 — 프롬프트·도구 내용은 보지 않는다.
const WORK_PREFIX = 'work.'
const WORK_KEY = WORK_PREFIX + crypto.randomUUID()
const WORK_FRESH_MS = 20_000 // 하트비트가 이보다 오래 끊기면(세션 강제 종료 등) 작업 중으로 치지 않는다
const WORK_GC_MS = 10 * 60_000

async function setWorking($, working) {
  isWorking = working
  try {
    await $.store.set(WORK_KEY, { working, at: await $.clock.now() })
  } catch {}
  await refreshOwnerWorking($)
}

export function isFreshWorking(v, now) {
  return !!v && v.working === true && typeof v.at === 'number' && now - v.at < WORK_FRESH_MS
}

async function refreshOwnerWorking($) {
  let any = isWorking
  try {
    const now = await $.clock.now()
    const keys = (await $.store.keys()) ?? []
    for (const k of keys) {
      if (typeof k !== 'string' || !k.startsWith(WORK_PREFIX) || k === WORK_KEY) continue
      const v = await $.store.get(k)
      if (isFreshWorking(v, now)) any = true
      else if (!v || typeof v.at !== 'number' || now - v.at > WORK_GC_MS) await $.store.delete(k)
    }
  } catch {}
  if (any !== ownerWorking) {
    ownerWorking = any
    if (isOpen) $.ui.invalidate('ui.render')
  }
}

export function register(on) {
  on('session.start', async ($, e, next) => {
    const nick = await loadNickname($)
    world = makeWorld(nick ?? '나')
    notice((nick ?? '나') + '의 막사가 열렸습니다 (P0 · 로컬 가짜 방문자 3명)', await $.clock.now())

    ticker?.cancel?.()
    ticker = $.clock.every(TICK_MS, async () => {
      if (!isOpen) return
      step(world, await $.clock.now())
      $.ui.invalidate('ui.render')
    })

    // 5초마다: 내가 일하는 중이면 하트비트, 그리고 다른 세션들 상태를 모아 주인 상태 갱신
    heartbeat?.cancel?.()
    heartbeat = $.clock.every(5000, async () => {
      if (isWorking) {
        try {
          await $.store.set(WORK_KEY, { working: true, at: await $.clock.now() })
        } catch {}
      }
      await refreshOwnerWorking($)
    })
    await setWorking($, false)

    try {
      await $.command.register({ name: 'space', description: '내 막사 열기 (OCW 막사 P0 프로토타입)', immediate: true })
      await $.command.register({ name: 'space-probe', description: '막사 P0: 사이드카 스트리밍 검사 (node 프로세스 출력이 실시간으로 오는지)', immediate: true })
    } catch (err) {
      $.ui.log('명령 등록 실패: ' + String(err?.message ?? err))
    }
    return next(e)
  })

  // 이 세션의 Claude 가 일하는 동안 내 병정은 타이핑 (§27.7 — 상태값만, 내용은 안 봄)
  on('turn.start', async ($, e, next) => {
    await setWorking($, true)
    return next(e)
  })
  on('turn.complete', async ($, e, next) => {
    await setWorking($, false)
    return next(e)
  })
  on('session.end', async ($, e, next) => {
    isWorking = false
    try {
      await $.store.delete(WORK_KEY)
    } catch {}
    return next(e)
  })

  on('command.run', { command: 'space' }, async ($) => {
    isOpen = true
    chatMode = false
    openedAt = await $.clock.now()
    const r = await $.ui.open({ id: PANE, title: '막사', focus: true, closeOnEscape: true, rows: 20 })
    if (r && r.isPlaced === false) $.ui.toast('막사 패널 대기 중: ' + (r.reason ?? '터미널이 좁아요'))
    return {}
  })

  on('command.run', { command: 'space-probe' }, async ($) => {
    isOpen = true
    chatMode = false
    openedAt = await $.clock.now()
    await $.ui.open({ id: PANE, title: '막사', focus: true, closeOnEscape: true, rows: 20 })
    $.clock.after(0, () => runProbe($))
    return { text: '막사 프로브 시작: node 프로세스가 1초마다 한 줄씩 5번 출력합니다. 결과는 막사 패널과 토스트로 표시돼요.' }
  })

  on('ui.close', async ($, e, next) => {
    if (e.id === PANE) {
      isOpen = false
      chatMode = false
    }
    return next(e)
  }).catch(($, e, next) => next(e))

  on('ui.render', { component: 'Pane' }, async ($, e, next) => {
    if (e.requestId !== PANE) return next(e)
    const { Box, Text, Button, Input, Raster, Svg } = $.ui.resolve(e)
    const now = await $.clock.now()
    const redraw = () => $.ui.invalidate('ui.render')
    const bodyCols = e.props?.bodyColumns ?? 60
    const view = compose(world, bodyCols, now, ownerWorking)
    const count = 1 + world.npcs.length

    const move = (dx) => {
      const me = world.me
      me.dir = dx > 0 ? 1 : -1
      me.x = Math.max(0, Math.min(WORLD - SW, me.x + dx))
      me.walkUntil = now + TICK_MS * 3
      redraw()
    }

    const header = Text({
      bold: true,
      wrap: 'truncate-end',
      children: [clip(`${world.me.nick}의 막사 · ${count}/10${ownerWorking ? ' · 주인 작업 중 ⌨' : ''}`, bodyCols - 2)],
    })

    // 포커스 옮기기: 그린 직후에 요청해야 그 요소가 화면에 있다
    const focusOn = (key) =>
      $.clock.after(60, async () => {
        try {
          await $.ui.focus({ requestId: PANE, key })
        } catch (err) {
          $.ui.log('포커스 이동 실패(' + key + '): ' + String(err?.message ?? err))
        }
      })

    // 버튼 줄과 입력창은 항상 그린다 — 포커스를 가진 요소가 사라지면 키보드가 Claude 프롬프트로 돌아가 버린다
    const buttons = Box({
      flexDirection: 'row',
      columnGap: 2,
      children: [
        Button({ key: 'left', label: '←', hotkey: 'a', plain: true, onPress: () => move(-STEP) }),
        Button({ key: 'right', label: '→', hotkey: 'd', plain: true, onPress: () => move(STEP) }),
        Button({
          key: 'talk',
          label: '채팅',
          hotkey: 't',
          plain: true,
          onPress: async () => {
            if ((await $.clock.now()) - openedAt < 500) return // /space 를 친 Enter 가 눌러버리는 것 방지
            chatMode = true
            redraw()
            focusOn('chat')
          },
        }),
      ],
    })

    // 맨 아래 입력창: 보내도 포커스가 그대로 남아 계속 칠 수 있다. 빈 줄 Enter = 이동 모드로
    const chatInput = Input({
      key: 'chat',
      label: chatMode ? '채팅' : '채팅(t)',
      placeholder: chatMode ? '입력 후 Enter · 빈 Enter/Tab = 이동 모드' : 't 를 누르면 여기로',
      value: '',
      submitLabel: '보내기',
      onSubmit: async (value) => {
        const text = String(value ?? '').trim().slice(0, 200)
        if (!text) {
          chatMode = false
          redraw()
          focusOn('right')
          return
        }
        chatMode = true
        const at = await $.clock.now()
        say('me', world.me.nick, text, at)
        // 가짜 방문자 하나가 가끔 대답
        if (Math.random() < 0.6) {
          const n = world.npcs[Math.floor(Math.random() * world.npcs.length)]
          $.clock.after(1200 + Math.random() * 1800, async () => {
            say(n.id, n.nick, NPC_REPLIES[Math.floor(Math.random() * NPC_REPLIES.length)], await $.clock.now())
            if (isOpen) redraw()
          })
        }
        redraw()
        focusOn('chat') // 다시 그려도 입력창에 그대로
      },
    })

    const scene =
      e.surface === 'terminal'
        ? Raster({ key: 'scene', columns: view.cols, rows: view.buf.length / 2, cells: packCells(toCells(view.buf)) })
        : Svg({ source: svgOf(view), alt: '막사 장면: 병정 ' + count + '명' })

    // 채팅 로그는 입력창 바로 위에 아래부터 쌓인다: 남는 줄 수만큼 위를 빈 줄로 채워 바닥에 붙인다
    // 고정 줄: 머리 2 + 말풍선 1 + 장면 6 + 이름 1 + 버튼 1 + 입력 1 (+ 프로브)
    const probeLines =
      probe.state === 'idle'
        ? []
        : [
            Text({ bold: true, children: [`프로브: ${probe.state}`] }),
            ...probe.lines.slice(-5).map((l) => Text({ dimColor: true, wrap: 'truncate-end', children: [l] })),
          ]
    const bodyRows = e.props?.scroll?.bodyRows ?? 20
    const logRows = Math.max(3, bodyRows - 12 - probeLines.length)
    const recent = world.log.slice(-logRows)
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
        Text({ dimColor: true, wrap: 'truncate-end', children: [clip('a/d 이동 · t 채팅 · Esc 닫기 · Claude 가 일하면 자동 ⌨', bodyCols)] }),
        Text({ wrap: 'truncate-end', children: [view.bubbleRow] }),
        scene,
        Text({ wrap: 'truncate-end', children: [view.nameRow] }),
        buttons,
        ...probeLines,
        ...logLines,
        chatInput,
      ],
    })
  })
}

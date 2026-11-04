import { expect, test } from 'claude-code/testing'
import { adminReply, applyServer, canGuest, compose, doorAt, emptyRoom, me, nameTag, parseSpaceArgs, syncMessages } from './space.mjs'

const PANE = {
  plugin: 'open-code-war',
  component: 'Pane',
  requestId: 'ocw-space',
  props: { title: 'OCW 광장', isFocused: true, bodyColumns: 80, placement: 'dock', scroll: { offset: 0, bodyRows: 24 }, view: {} },
} as const

const NOW = 1_760_000_000_000
const YOU = { id: 'c-me', role: 'member', pid: 'u-mememememe', nick: '나', agent: 'claude-code' }
const KIM = { id: 'c-kim', pid: 'u-kimkimkimk', nick: 'kim', agent: 'codex', x: 40, dir: -1, state: 'idle' }
const PLAZA_HELLO = {
  t: 'hello',
  you: YOU,
  room: {
    id: 'plaza', kind: 'plaza', width: 140, cap: 30, owner: null,
    doors: [{ pid: 'u-kimkimkimk', nick: 'kim', agent: 'codex', count: 1, ownerOnline: true, ownerWorking: true, x: 30 }],
  },
  members: [KIM],
  chat: [{ pid: 'u-kimkimkimk', nick: 'kim', text: '어서와요', at: NOW - 1000 }],
}

test('서버 메시지 → 화면 상태 (입장·이동·말하기·퇴장)', () => {
  const v = emptyRoom()
  applyServer(v, PLAZA_HELLO, NOW)
  expect(v.status).toBe('open')
  expect(v.members.size).toBe(1)
  expect(v.log.map((l: any) => l.text)).toContain('어서와요')
  applyServer(v, { t: 'move', id: 'c-kim', x: 50, dir: 1 }, NOW)
  expect(v.members.get('c-kim').x).toBe(50)
  applyServer(v, { t: 'said', line: { pid: 'u-kimkimkimk', nick: 'kim', text: '안녕', at: NOW } }, NOW)
  expect(v.bubbles['c-kim'].text).toBe('안녕')
  applyServer(v, { t: 'said', line: { pid: 'u-mememememe', nick: '나', text: '반가워', at: NOW } }, NOW)
  expect(v.bubbles.me.text).toBe('반가워')
  applyServer(v, { t: 'leave', id: 'c-kim' }, NOW)
  expect(v.members.size).toBe(0)
  expect(v.log.at(-1).text).toBe('kim 님이 나갔습니다')
})

test('문 앞 판정: 광장 = 막사 문, 막사 = 나가는 문', () => {
  const v = emptyRoom()
  applyServer(v, PLAZA_HELLO, NOW)
  expect(doorAt(v, 30)?.kind).toBe('enter')
  expect(doorAt(v, 33)?.door.nick).toBe('kim')
  expect(doorAt(v, 60)).toBeNull()
  const b = emptyRoom()
  applyServer(b, { ...PLAZA_HELLO, room: { id: 'u-kimkimkimk', kind: 'barracks', width: 96, cap: 10, owner: { pid: 'u-kimkimkimk', nick: 'kim', agent: 'codex', online: false, working: false } }, members: [] }, NOW)
  expect(doorAt(b, 4)?.kind).toBe('exit')
  expect(doorAt(b, 40)).toBeNull()
})

test('광장 그림: 문 이름표에 인원·작업 중, 주인 없는 막사는 외출 중', () => {
  const v = emptyRoom()
  applyServer(v, PLAZA_HELLO, NOW)
  me.x = 20
  const sc = compose(v, 80, NOW, false)
  expect(sc.signRow).toContain('kim 1⌨')
  expect(sc.nameRow).toContain('▸나')
  const b = emptyRoom()
  applyServer(b, { ...PLAZA_HELLO, room: { id: 'u-kimkimkimk', kind: 'barracks', width: 96, cap: 10, owner: { pid: 'u-kimkimkimk', nick: 'kim', agent: 'codex', online: false, working: false } }, members: [] }, NOW)
  const sb = compose(b, 96, NOW, false)
  expect(sb.signRow).toContain('광장')
  expect(sb.signRow).toContain('외출 중')
  applyServer(b, { t: 'owner', owner: { pid: 'u-kimkimkimk', nick: 'kim', agent: 'codex', online: true, working: true } }, NOW)
  expect(compose(b, 96, NOW, false).nameRow).toContain('★kim⌨')
})

test('입장 직후 내 위치를 보낸다 — 서버의 시작 위치는 임의값', () => {
  expect(syncMessages(30, -1, false)).toEqual([{ t: 'move', x: 30, dir: -1 }])
  expect(syncMessages(30, 1, true)).toEqual([{ t: 'move', x: 30, dir: 1 }, { t: 'state', state: 'working' }])
})

const BARRACKS_HELLO = {
  ...PLAZA_HELLO,
  room: { id: 'u-kimkimkimk', kind: 'barracks', width: 96, cap: 10, locked: false, owner: { pid: 'u-kimkimkimk', nick: 'kim', agent: 'codex', rank: 3, online: false, working: false } },
  members: [] as any[],
  guest: [{ pid: 'u-leeleeleel', nick: 'lee', text: '다녀가요', at: NOW - 5000 }],
}

test('이름표에 계급', () => {
  expect(nameTag({ nick: 'kim', rank: 3 })).toBe('kim·병장')
  expect(nameTag({ nick: 'kim' })).toBe('kim')
  const b = emptyRoom()
  applyServer(b, { ...BARRACKS_HELLO, you: { ...YOU, rank: 0 } }, NOW)
  applyServer(b, { t: 'owner', owner: { ...BARRACKS_HELLO.room.owner, online: true, working: true } }, NOW)
  const row = compose(b, 96, NOW, false).nameRow
  expect(row).toContain('★kim·병장⌨')
  expect(row).toContain('▸나·이병')
})

test('방명록: 주인이 없을 때 방문자만, 입장 때 지난 글이 보인다', () => {
  const v = emptyRoom()
  applyServer(v, BARRACKS_HELLO, NOW)
  expect(v.log.some((l: any) => l.kind === 'guest' && l.text === '다녀가요')).toBe(true)
  expect(canGuest(v)).toBe(true)
  applyServer(v, { t: 'join', m: { id: 'c-kim', pid: 'u-kimkimkimk', nick: 'kim', agent: 'codex', x: 40, dir: 1, state: 'idle' } }, NOW)
  expect(canGuest(v)).toBe(false) // 주인이 들어왔다
  applyServer(v, { t: 'guest_clear' }, NOW)
  expect(v.log.some((l: any) => l.kind === 'guest')).toBe(false)
  const mine = emptyRoom()
  applyServer(mine, { ...BARRACKS_HELLO, you: { ...YOU, pid: 'u-kimkimkimk' } }, NOW)
  expect(canGuest(mine)).toBe(false) // 내 막사
  const plaza = emptyRoom()
  applyServer(plaza, PLAZA_HELLO, NOW)
  expect(canGuest(plaza)).toBe(false)
})

test('연결이 끝나는 이유: 쫓겨나면 안내가 남는다', () => {
  for (const code of ['kicked', 'banned', 'closed', 'full', 'replaced']) {
    const v = emptyRoom()
    applyServer(v, BARRACKS_HELLO, NOW)
    applyServer(v, { t: 'error', code }, NOW)
    expect(v.status).toBe('error')
    expect(v.note).toBeTruthy()
  }
  const v = emptyRoom()
  applyServer(v, BARRACKS_HELLO, NOW)
  applyServer(v, { t: 'error', code: 'guest_limit' }, NOW)
  expect(v.status).toBe('open') // 방명록 한도는 연결을 끊지 않는다
})

test('/space 인자 해석과 응답 문구', () => {
  expect(parseSpaceArgs('')).toEqual({ kind: 'plaza' })
  expect(parseSpaceArgs(' home ')).toEqual({ kind: 'home' })
  expect(parseSpaceArgs('kick 김 철수')).toEqual({ kind: 'admin', action: 'kick', target: '김 철수' })
  expect(parseSpaceArgs('kick')).toEqual({ kind: 'usage' })
  expect(parseSpaceArgs('close')).toEqual({ kind: 'admin', action: 'close', target: '' })
  expect(parseSpaceArgs('guestbook clear')).toEqual({ kind: 'admin', action: 'guest_clear', target: '' })
  expect(parseSpaceArgs('presence off')).toEqual({ kind: 'presence', on: false })
  expect(parseSpaceArgs('nope')).toEqual({ kind: 'usage' })
  expect(adminReply('kick', 'x', { ok: false, error: 'not_found' })).toContain('찾지 못했어요')
  expect(adminReply('ban', 'x', { ok: true, target: 'kim' })).toContain('kim')
  expect(adminReply('bans', '', { ok: true, bans: [] })).toContain('없어요')
})

function stubEngine(on: any, sent: any[]) {
  on('command.register', () => ({ value: { command: 'x' } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('session.start', (_: any, e: any) => ({ cwd: e.cwd }))
  on('clock.now', () => ({ value: NOW }))
  on('clock.every', () => ({ value: {} }))
  on('ui.invalidate', () => ({ value: undefined }))
  on('ui.log', () => ({ value: undefined }))
  on('ui.toast', () => ({ value: undefined }))
  on('ui.focus', () => ({ value: undefined }))
  on('store.get', () => ({ value: undefined }))
  on('env.get', (_: any, e: any) => ({ value: e.name === 'HOME' ? '/home/t' : undefined }))
  on('fs.read', () => ({ value: JSON.stringify({ userId: 'ocw_test0000', endpoint: 'http://127.0.0.1:8787' }) }))
  on('http.fetch', (_: any, e: any) => {
    sent.push({ url: e.url, body: e.init?.body })
    if (String(e.url).endsWith('/space/ticket')) return { value: { status: 200, ok: true, headers: {}, text: JSON.stringify({ ticket: 'tk', pid: YOU.pid }) } }
    return { value: { status: 200, ok: true, headers: {}, text: '{"ok":true}' } }
  })
}

test('세션 시작 시 상태 하트비트를 보내고, 연결 전 패널을 그린다', async ($: any, on: any) => {
  const sent: any[] = []
  stubEngine(on, sent)
  // 세션 시작을 늦추지 않도록 첫 보고는 타이머로 나간다 — 여기서 바로 돌린다
  on('clock.after', async (_: any, e: any) => {
    await e.fn?.()
    return { value: {} }
  })
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await Promise.resolve()
  expect(sent.some((s) => String(s.url).endsWith('/space/status') && JSON.parse(s.body).full === true)).toBe(true)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect((await ui.find({ type: 'Text', text: /연결 안 됨/ }))?.text).toBeTruthy()
  await ui.unmount()
})

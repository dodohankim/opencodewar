import { expect, test } from 'claude-code/testing'

const PANE = {
  plugin: 'ocw-space',
  component: 'Pane',
  requestId: 'ocw-space',
  props: {
    title: '막사',
    isFocused: true,
    bodyColumns: 60,
    placement: 'dock',
    scroll: { offset: 0, bodyRows: 24 },
    view: {},
  },
} as const

function stubEngine(on: any, store: Map<string, any> = new Map()) {
  on('store.get', (_: any, e: any) => ({ value: store.get(e.key) }))
  on('store.set', (_: any, e: any) => { store.set(e.key, e.value); return { value: undefined } })
  on('store.delete', (_: any, e: any) => { store.delete(e.key); return { value: undefined } })
  on('store.keys', () => ({ value: [...store.keys()] }))
  on('command.register', () => ({ value: { command: 'x' } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('session.start', (_: any, e: any) => ({ cwd: e.cwd }))
  on('env.get', () => ({ value: undefined }))
  on('clock.now', () => ({ value: 1_760_000_000_000 }))
  on('clock.every', () => ({ value: {} }))
  on('clock.after', () => ({ value: {} }))
  on('ui.invalidate', () => ({ value: undefined }))
  on('ui.log', () => ({ value: undefined }))
  on('ui.toast', () => ({ value: undefined }))
}

test('막사 패널이 터미널에서 그려진다 (Raster)', async ($: any, on: any) => {
  stubEngine(on)
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  const header = await ui.find({ type: 'Text', text: /의 막사 · 4\/10/ })
  expect(header?.text).not.toContain('작업 중')
  expect(header?.text).toContain('막사')
  const raster = await ui.find({ type: 'Raster' })
  expect(raster).toBeTruthy()
  await ui.unmount()
})

test('데스크톱에서는 Svg 로 그린다', async ($: any, on: any) => {
  stubEngine(on)
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  const svg = await ui.find({ type: 'Svg' })
  expect(svg).toBeTruthy()
  await ui.unmount()
})

test('d 로 오른쪽 이동, t 로 채팅 → 연달아 보내도 로그에 남는다', async ($: any, on: any) => {
  stubEngine(on)
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  // 패널이 막사 전체 폭(96)이면 카메라가 고정이라 이름표 위치로 이동을 확인할 수 있다
  const ui = await $.ui.mount({ ...PANE, props: { ...PANE.props, bodyColumns: 96 }, surface: 'terminal' })
  const before = (await ui.find({ type: 'Text', text: /▸/ }))?.text ?? ''
  await ui.press({ key: 'right' })
  await ui.press({ key: 'right' })
  await ui.redraw()
  const after = (await ui.find({ type: 'Text', text: /▸/ }))?.text ?? ''
  expect(after.indexOf('▸')).toBeGreaterThan(before.indexOf('▸'))

  await ui.press({ key: 'talk' })
  await ui.redraw()
  await ui.input({ key: 'chat', text: '안녕하세요 막사' })
  await ui.redraw()
  // 한 번 보낸 뒤에도 t 없이 바로 이어서 보낼 수 있다
  await ui.input({ key: 'chat', text: '두번째 줄' })
  await ui.redraw()
  const line = await ui.find({ type: 'Text', text: /안녕하세요 막사/ })
  expect(line?.text).toContain('나: 안녕하세요 막사')
  const rows = await ui.findAll({ type: 'Text', text: /두번째 줄/ })
  expect(rows.some((r: any) => r.text.includes('나: 두번째 줄'))).toBe(true)
  await ui.unmount()
})

test('다른 Claude 세션이 일하는 중이면 주인 작업 중으로 자동 표시', async ($: any, on: any) => {
  const store = new Map<string, any>([['work.other-session', { working: true, at: 1_760_000_000_000 - 1000 }]])
  stubEngine(on, store)
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  const header = await ui.find({ type: 'Text', text: /의 막사/ })
  expect(header?.text).toContain('주인 작업 중')
  await ui.unmount()
})

test('오래 끊긴 세션 기록은 작업 중으로 치지 않는다', async ($: any, on: any) => {
  const store = new Map<string, any>([['work.dead', { working: true, at: 1_760_000_000_000 - 60_000 }]])
  stubEngine(on, store)
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  const header = await ui.find({ type: 'Text', text: /의 막사/ })
  expect(header?.text).not.toContain('작업 중')
  await ui.unmount()
})

test('이 세션의 Claude 턴이 시작되면 자동으로 작업 중, 끝나면 해제', async ($: any, on: any) => {
  stubEngine(on)
  on('turn.start', (_: any, e: any) => e)
  on('turn.complete', () => ({ text: '' }))
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await $.turn.start({ turnId: 't1' })
  await ui.redraw()
  expect((await ui.find({ type: 'Text', text: /의 막사/ }))?.text).toContain('주인 작업 중')
  await $.turn.complete({ turnId: 't1', answer: 'ok' })
  await ui.redraw()
  expect((await ui.find({ type: 'Text', text: /의 막사/ }))?.text).not.toContain('작업 중')
  await ui.unmount()
})

test('입력창이 맨 아래, 채팅 로그는 바로 위에 붙는다', async ($: any, on: any) => {
  stubEngine(on)
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await ui.input({ key: 'chat', text: '바닥 확인' })
  await ui.redraw()
  const tree = await ui.drawn()
  const kids = tree.props?.children ?? tree.children
  const last = kids[kids.length - 1]
  expect(last.type).toBe('Input')
  // 입력창 바로 위 몇 줄 안에 방금 보낸 말 (가짜 방문자 답이 그 뒤에 붙을 수 있다)
  expect(JSON.stringify(kids.slice(-4, -1))).toContain('바닥 확인')
  await ui.unmount()
})

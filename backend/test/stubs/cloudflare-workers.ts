// vitest(Node)에는 Workers 런타임 모듈이 없다 — index.ts 를 import 하는 테스트용 최소 대역.
// 막사 DO(SpaceRoom)의 실제 동작은 wrangler dev 로 확인한다(DESIGN.md §27).
export class DurableObject<Env = unknown> {
  constructor(
    protected ctx: unknown,
    protected env: Env,
  ) {}
}

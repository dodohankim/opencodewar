import { describe, expect, it } from 'vitest';
import { iconHostFromPath } from '../src/icon';

describe('iconHostFromPath (§26)', () => {
  it('소문자 도메인만 통과시킨다', () => {
    expect(iconHostFromPath('/icon/opencodewar.dev.png')).toBe('opencodewar.dev');
    expect(iconHostFromPath('/icon/gaemilab.com.png')).toBe('gaemilab.com');
    expect(iconHostFromPath('/icon/sub.example.co.kr.png')).toBe('sub.example.co.kr');
  });

  it('경로·포트·자격증명·대문자가 섞이면 거절한다', () => {
    expect(iconHostFromPath('/icon/example.com:8080.png')).toBeNull();
    expect(iconHostFromPath('/icon/user@example.com.png')).toBeNull();
    expect(iconHostFromPath('/icon/Example.com.png')).toBeNull();
    expect(iconHostFromPath('/icon/example.com/evil.png')).toBeNull();
    expect(iconHostFromPath('/icon/example.com.jpg')).toBeNull();
  });

  it('단일 라벨·기형 도메인은 거절한다(localhost 로 내부를 찌르지 못하게)', () => {
    expect(iconHostFromPath('/icon/localhost.png')).toBeNull();
    expect(iconHostFromPath('/icon/example..com.png')).toBeNull();
    expect(iconHostFromPath('/icon/-example.com.png')).toBeNull();
    expect(iconHostFromPath('/icon/example.com-.png')).toBeNull();
    expect(iconHostFromPath('/icon/.example.com.png')).toBeNull();
  });
});

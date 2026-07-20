import { describe, expect, it } from 'vitest';
import { buildOgDescription, MAX_OG_DESC, nicknameFromPath, profileUrl, type ProfileMetaRow } from '../src/og';

describe('nicknameFromPath', () => {
  it('/u/<nickname> 에서 닉네임을 꺼낸다', () => {
    expect(nicknameFromPath('/u/dododo')).toBe('dododo');
  });

  it('퍼센트 인코딩(한글·공백)을 디코딩한다', () => {
    expect(nicknameFromPath('/u/%ED%94%84%EB%A1%AC%ED%94%84%ED%8A%B8%EC%9E%A5%EC%9D%B8')).toBe('프롬프트장인');
    expect(nicknameFromPath('/u/code%20master')).toBe('code master');
  });

  it('프로필 경로가 아니거나 형식이 어긋나면 null', () => {
    expect(nicknameFromPath('/')).toBeNull();
    expect(nicknameFromPath('/leaderboard')).toBeNull();
    expect(nicknameFromPath('/u/')).toBeNull();
    expect(nicknameFromPath('/u/a/b')).toBeNull(); // 하위 경로 없음
    expect(nicknameFromPath('/u/%ZZ')).toBeNull(); // 깨진 인코딩
  });
});

describe('profileUrl', () => {
  it('정식 절대 URL 을 만든다', () => {
    expect(profileUrl('dododo')).toBe('https://opencodewar.dev/u/dododo');
  });

  it('한글·공백을 인코딩한다', () => {
    expect(profileUrl('코드 장인')).toBe('https://opencodewar.dev/u/%EC%BD%94%EB%93%9C%20%EC%9E%A5%EC%9D%B8');
  });
});

const row = (overrides: Partial<ProfileMetaRow> = {}): ProfileMetaRow => ({
  nickname: 'dododo',
  bio: null,
  role: null,
  company: null,
  ...overrides,
});

describe('buildOgDescription', () => {
  it('role·company·bio 를 모두 조합한다', () => {
    const desc = buildOgDescription(row({ role: 'Backend Engineer', company: 'Acme', bio: '타이핑이 곧 실력' }));
    expect(desc).toBe('Backend Engineer @ Acme · 타이핑이 곧 실력 — Claude Code activity on Open Code War.');
  });

  it('role 만 있으면 company 구분자(@) 없이 만든다', () => {
    const desc = buildOgDescription(row({ role: 'Backend Engineer' }));
    expect(desc).toBe('Backend Engineer — Claude Code activity on Open Code War.');
  });

  it('bio 만 있으면 bio 로 시작한다', () => {
    const desc = buildOgDescription(row({ bio: '주말에도 코딩' }));
    expect(desc).toBe('주말에도 코딩 — Claude Code activity on Open Code War.');
  });

  it('프로필 정보가 없으면 기본 문구를 쓴다', () => {
    const desc = buildOgDescription(row());
    expect(desc).toBe('Claude Code activity — prompts & chars over the last 30 days on Open Code War.');
  });

  it('공백뿐인 bio 는 무시한다', () => {
    const desc = buildOgDescription(row({ bio: '   ' }));
    expect(desc).toBe('Claude Code activity — prompts & chars over the last 30 days on Open Code War.');
  });

  it('길면 MAX_OG_DESC 이내로 말줄임한다', () => {
    const desc = buildOgDescription(row({ bio: 'x'.repeat(200) }));
    expect(desc.length).toBeLessThanOrEqual(MAX_OG_DESC);
    expect(desc.endsWith('…')).toBe(true);
  });
});

import { describe, expect, it } from 'vitest';
import { buildOgDescription, MAX_OG_DESC, type ProfileMetaRow } from '../src/og';

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

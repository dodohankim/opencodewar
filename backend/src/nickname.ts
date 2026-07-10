// 닉네임 미등록 유저를 위한 결정론적 자동 닉네임 생성.
// - userId(유니크·비밀)로부터 안정적으로 파생 → 같은 유저는 항상 같은 닉네임.
// - 표시 전용이다: DB(users.nickname)에는 저장하지 않으므로, 나중에 유저가
//   /ocw nickname 으로 직접 등록하면 자연스럽게 그 값으로 대체된다.
// - 닉네임 유일성은 userId가 보장하므로 중복을 허용한다(충돌 회피 로직 없음).
// - 항상 10자 이내를 보장한다.

// 각 ≤3자
const ADJECTIVES = [
  'Red', 'Sly', 'Icy', 'Hot', 'Dim', 'Shy', 'Zen', 'Odd', 'Big', 'Wry',
  'Fae', 'Mad', 'Coy', 'Ace', 'Fox', 'Old', 'New', 'Raw', 'Fit', 'Sun',
] as const;

// 각 ≤3자
const NOUNS = [
  'Fox', 'Owl', 'Cat', 'Elk', 'Ray', 'Yak', 'Bee', 'Ram', 'Jay', 'Koi',
  'Ant', 'Eel', 'Cub', 'Doe', 'Hen', 'Pug', 'Bat', 'Cod', 'Fly', 'Sow',
] as const;

const MAX_LEN = 10;

/** djb2 해시 (결정론적·언어 중립, 32-bit unsigned). */
function hash(s: string): number {
  let h = 5381;
  for (let i = 0; i < s.length; i++) {
    h = ((h << 5) + h + s.charCodeAt(i)) >>> 0;
  }
  return h >>> 0;
}

/** userId → 10자 이내 자동 닉네임. 예: "SlyFox42" (형용사+명사+2자리 숫자, 최대 8자). */
export function autoNickname(userId: string): string {
  const h = hash(userId);
  const adj = ADJECTIVES[h % ADJECTIVES.length];
  const noun = NOUNS[Math.floor(h / ADJECTIVES.length) % NOUNS.length];
  const num = Math.floor(h / (ADJECTIVES.length * NOUNS.length)) % 100;
  const suffix = String(num).padStart(2, '0');
  return (adj + noun + suffix).slice(0, MAX_LEN);
}

/** 등록 닉네임이 있으면 그대로, 없으면 자동 닉네임으로 채운다. */
export function displayNickname(nickname: string | null | undefined, userId: string): string {
  return nickname ?? autoNickname(userId);
}

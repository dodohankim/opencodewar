// 프롬프트 "글자 수" 계산. 자소 클러스터(grapheme) 기준 — 이모지/조합 문자를 1글자로.
// (DESIGN.md §11: 코드포인트 vs 자소 클러스터 → 자소 클러스터 채택)

export function countChars(text) {
  if (typeof text !== 'string' || text.length === 0) return 0;
  try {
    const seg = new Intl.Segmenter('ko', { granularity: 'grapheme' });
    let n = 0;
    for (const _ of seg.segment(text)) n++;
    return n;
  } catch {
    // Intl.Segmenter 미지원 환경 폴백: 코드포인트 수
    return [...text].length;
  }
}

import { checkLength, countWords, estimatePages, targetWords } from './document-length.util';

const sectionOf = (words: number) => [{ heading: 'Heading', content: Array(words - 1).fill('word').join(' ') }];

describe('document-length.util', () => {
  it('counts heading and body words', () => {
    expect(countWords([{ heading: 'A B', content: 'one two\nthree' }])).toBe(5);
  });

  it('targets fewer words for pdf than docx at the same page count', () => {
    expect(targetWords(3, 'pdf')).toBeLessThan(targetWords(3, 'docx'));
    expect(targetWords(1, 'pdf')).toBe(350);
  });

  it('estimates pages as the inverse of the target, minimum one', () => {
    expect(estimatePages(targetWords(3, 'docx'), 'docx')).toBe(3);
    expect(estimatePages(targetWords(5, 'pdf'), 'pdf')).toBe(5);
    expect(estimatePages(10, 'docx')).toBe(1);
  });

  it('rejects a draft far shorter than requested (3 pages asked, ~2 written)', () => {
    const check = checkLength(sectionOf(Math.round(targetWords(2, 'docx'))), 3, 'docx');
    expect(check.ok).toBe(false);
    if (!check.ok) expect(check.message).toContain(`${targetWords(3, 'docx')} words`);
  });

  it('rejects a draft far longer than requested', () => {
    expect(checkLength(sectionOf(targetWords(5, 'docx')), 3, 'docx').ok).toBe(false);
  });

  it('accepts a draft within tolerance of the requested length', () => {
    expect(checkLength(sectionOf(targetWords(3, 'docx')), 3, 'docx').ok).toBe(true);
    expect(checkLength(sectionOf(Math.round(targetWords(5, 'pdf') * 0.95)), 5, 'pdf').ok).toBe(true);
  });
});

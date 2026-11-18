import { cleanMarkdown } from './plain-text';

describe('cleanMarkdown', () => {
  it.each([
    ['Did you mean: "Business ideas I can venture into in **Nigeria**"?', 'Did you mean: "Business ideas I can venture into in Nigeria"?'],
    ['Or try: "ideas in **[your city/country]**"?', 'Or try: "ideas in [your city/country]"?'],
    ['**DC (Washington D.C.)** that need **little to no startup activity**', 'DC (Washington D.C.) that need little to no startup activity'],
    ['an *italic* word and _another_ one', 'an italic word and another one'],
    ['## Heading\nbody `code` here', 'Heading\nbody code here'],
    ['see [the docs](https://example.com/x) now', 'see the docs now'],
    ['~~old~~ new', 'old new'],
    ['a dangling ** marker', 'a dangling  marker'],
  ])('%s', (input, expected) => expect(cleanMarkdown(input)).toBe(expected));

  it('leaves ordinary text, snake_case, maths and bullets alone', () => {
    for (const t of ['plain text', 'file_name_here', '2 * 3 = 6 and 4 * 5 = 20', 'cost*tax', 'Q3 – “quoted” 100%']) {
      expect(cleanMarkdown(t)).toBe(t);
    }
  });
});

import { ToolCallStreamFilter } from './tool-call-stream-filter.util';

function feed(filter: ToolCallStreamFilter, tokens: string[]): string {
  return tokens.map((t) => filter.push(t)).join('');
}

describe('ToolCallStreamFilter', () => {
  it('passes normal text through untouched', () => {
    const filter = new ToolCallStreamFilter();
    const out = feed(filter, ['- Here', ' is', ' your', ' answer.']);
    expect(out).toBe('- Here is your answer.');
  });

  it('drops a tool_call block that arrives in one token', () => {
    const filter = new ToolCallStreamFilter();
    const out = feed(filter, [
      'Before. ',
      '<tool_call>{"name":"generate_document"}</tool_call>',
      ' After.',
    ]);
    expect(out).toBe('Before.  After.');
  });

  it('drops a tool_call block split across many small tokens', () => {
    const filter = new ToolCallStreamFilter();
    const tag = '<tool_call>{"name":"generate_document","arguments":{}}</tool_call>';
    const tokens = ['Before. ', ...tag.split(''), ' After.'];
    const out = feed(filter, tokens);
    expect(out).toBe('Before.  After.');
  });

  it('drops a tool_response block', () => {
    const filter = new ToolCallStreamFilter();
    const out = feed(filter, ['Ok. ', '<tool_response>', 'raw result', '</tool_response>', ' Done.']);
    expect(out).toBe('Ok.  Done.');
  });

  it('never leaks a partial opening tag split across token boundaries', () => {
    const filter = new ToolCallStreamFilter();
    // Split right in the middle of the opening tag.
    const out = feed(filter, ['Text ', '<tool_c', 'all>hidden</tool_call>', ' more']);
    expect(out).toBe('Text  more');
    expect(out).not.toContain('<tool_c');
  });

  it('does not mistake ordinary angle-bracket text for a tag', () => {
    const filter = new ToolCallStreamFilter();
    const out = feed(filter, ['Compare a < b and c > d in this formula.']);
    expect(out).toBe('Compare a < b and c > d in this formula.');
  });

  it('handles an unterminated tag by suppressing output until the stream ends', () => {
    const filter = new ToolCallStreamFilter();
    const out = feed(filter, ['Before. ', '<tool_call>{"name":"x"']);
    expect(out).toBe('Before. ');
  });
});

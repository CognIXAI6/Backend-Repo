import { countWords, describeError, redactText, safeHost, safePath } from './log-safe.util';

describe('redactText', () => {
  it('removes emails, URLs (including signed ones), bearer/JWT tokens and long opaque secrets', () => {
    const jwt = ['eyJhbGciOiJIUzI1NiJ9', 'eyJzdWIiOiIxMjM0NTYifQ', 'abcdefghijklmnopqrstuv'].join('.');
    const out = redactText(
      `to owner@example.com via https://res.cloudinary.com/x/raw/upload/s--sig--/doc.docx?token=abc ` +
      `Authorization: Bearer ${jwt} key=${['sk', 'live', 'ABCDEFGHIJKLMNOPQRSTUVWXYZ012345'].join('_')}`,
    );
    expect(out).not.toMatch(/owner@example\.com|cloudinary|eyJ|sk_live|ABCDEFGHIJ/);
    expect(out).toContain('[email]');
    expect(out).toContain('[url]');
  });

  it('leaves ordinary diagnostic text alone', () => {
    expect(redactText('socket closed code=1006 readyState=3')).toBe('socket closed code=1006 readyState=3');
  });
});

describe('describeError', () => {
  it('keeps class, code and status, and redacts the message', () => {
    class ProviderError extends Error { code = 'E_RECIPIENT'; statusCode = 422; }
    const err = new ProviderError('invalid recipient jane.doe@example.org at https://api.vendor.com/v1/send');
    const line = describeError(err);
    expect(line).toContain('Error');
    expect(line).toContain('code=E_RECIPIENT');
    expect(line).toContain('status=422');
    expect(line).not.toMatch(/jane\.doe|example\.org|api\.vendor/);
  });

  it('is length-capped and tolerates non-errors', () => {
    expect(describeError('x'.repeat(5_000)).length).toBeLessThanOrEqual(201);
    expect(describeError(undefined)).toBe('unknown error');
    expect(describeError({ weird: true })).toContain('object');
  });
});

describe('countWords', () => {
  it('counts without keeping the words', () => {
    expect(countWords('  the quick  brown fox ')).toBe(4);
    expect(countWords('')).toBe(0);
    expect(countWords(null)).toBe(0);
  });
});

describe('safePath / safeHost', () => {
  it('drops query strings and fragments from request paths', () => {
    expect(safePath('/conversations/abc?token=secret&x=1#frag')).toBe('/conversations/abc');
    expect(safePath(undefined)).toBe('');
  });
  it('keeps only the host of a user-supplied URL', () => {
    expect(safeHost('https://private.example.com/path/signed?sig=abc')).toBe('private.example.com');
    expect(safeHost('not a url')).toBe('invalid-url');
  });
});

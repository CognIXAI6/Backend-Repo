import { SUPPORTED_CONVERSATION_LANGUAGES } from '@/common/constants/conversation-languages.constant';
import {
  buildUnclearFallback,
  buildDocumentReadyFallback,
  buildEmptyResponseFallback,
} from './fallback-messages.constant';

describe('fallback message templates', () => {
  it('have a non-empty, language-specific template for every supported language', () => {
    for (const code of SUPPORTED_CONVERSATION_LANGUAGES) {
      expect(buildUnclearFallback(code, 'engineering').length).toBeGreaterThan(0);
      expect(buildEmptyResponseFallback(code).length).toBeGreaterThan(0);
      expect(buildDocumentReadyFallback(code, 'My Report', 'https://example.com/doc').length).toBeGreaterThan(0);
    }
  });

  it('interpolates the field name and document title/url into every language template', () => {
    for (const code of SUPPORTED_CONVERSATION_LANGUAGES) {
      expect(buildUnclearFallback(code, 'law')).toContain('law');
      expect(buildDocumentReadyFallback(code, 'Q3 Report', 'https://example.com/q3')).toContain(
        'https://example.com/q3',
      );
    }
  });

  it('falls back to the English template for an unsupported/invalid language code', () => {
    expect(buildEmptyResponseFallback('not-a-real-code')).toBe(buildEmptyResponseFallback('en'));
    expect(buildUnclearFallback('not-a-real-code', 'tech')).toBe(buildUnclearFallback('en', 'tech'));
  });
});

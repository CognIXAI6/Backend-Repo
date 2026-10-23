import {
  ConversationLanguage,
  SUPPORTED_CONVERSATION_LANGUAGES,
  normalizeLanguageCode,
  buildLanguageDirective,
} from './conversation-languages.constant';

describe('normalizeLanguageCode', () => {
  it('passes through every canonical code unchanged', () => {
    for (const code of SUPPORTED_CONVERSATION_LANGUAGES) {
      expect(normalizeLanguageCode(code)).toBe(code);
    }
  });

  it('maps common legacy/free-text values to their canonical code', () => {
    expect(normalizeLanguageCode('English')).toBe(ConversationLanguage.ENGLISH);
    expect(normalizeLanguageCode('en-US')).toBe(ConversationLanguage.ENGLISH);
    expect(normalizeLanguageCode('spanish')).toBe(ConversationLanguage.SPANISH);
    expect(normalizeLanguageCode('chinese')).toBe(ConversationLanguage.CHINESE_SIMPLIFIED);
    expect(normalizeLanguageCode('zh-TW')).toBe(ConversationLanguage.CHINESE_TRADITIONAL);
    expect(normalizeLanguageCode('yoruba')).toBe(ConversationLanguage.YORUBA);
  });

  it('defaults to English for missing, empty, or unrecognized values', () => {
    expect(normalizeLanguageCode(null)).toBe(ConversationLanguage.ENGLISH);
    expect(normalizeLanguageCode(undefined)).toBe(ConversationLanguage.ENGLISH);
    expect(normalizeLanguageCode('')).toBe(ConversationLanguage.ENGLISH);
    expect(normalizeLanguageCode('klingon')).toBe(ConversationLanguage.ENGLISH);
    expect(normalizeLanguageCode('en-US; DROP TABLE users')).toBe(ConversationLanguage.ENGLISH);
  });
});

describe('buildLanguageDirective', () => {
  it('returns a short English directive for "en"', () => {
    const directive = buildLanguageDirective('en');
    expect(directive).toContain('English');
    expect(directive).not.toContain('MANDATORY');
  });

  it('returns a mandatory, server-owned directive naming the language for every non-English code', () => {
    const nonEnglish = SUPPORTED_CONVERSATION_LANGUAGES.filter((c) => c !== ConversationLanguage.ENGLISH);
    for (const code of nonEnglish) {
      const directive = buildLanguageDirective(code);
      expect(directive).toContain('MANDATORY');
      expect(directive).toContain(code);
    }
  });

  it('falls back to the English directive for an invalid/unsupported code rather than echoing it', () => {
    const directive = buildLanguageDirective('not-a-real-code');
    expect(directive).toContain('Respond in English.');
    expect(directive).not.toContain('not-a-real-code');
  });
});

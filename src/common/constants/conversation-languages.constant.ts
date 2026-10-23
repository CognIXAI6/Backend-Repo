/**
 * Server-owned registry of supported conversation output languages.
 *
 * This is the single source of truth for: which codes are valid on writes to
 * `user_preferences.language`, how legacy/free-text values already sitting in
 * that column get normalized on read, and the exact instruction text Claude
 * is given to control output language. Never interpolate a raw user-supplied
 * string into a prompt for this purpose — always go through
 * `buildLanguageDirective`, which only ever emits text from this file.
 */

export enum ConversationLanguage {
  ENGLISH = 'en',
  SPANISH = 'es',
  FRENCH = 'fr',
  GERMAN = 'de',
  CHINESE_SIMPLIFIED = 'zh-Hans',
  CHINESE_TRADITIONAL = 'zh-Hant',
  YORUBA = 'yo',
  HAUSA = 'ha',
  IGBO = 'ig',
}

export const SUPPORTED_CONVERSATION_LANGUAGES: readonly ConversationLanguage[] =
  Object.values(ConversationLanguage);

export const LANGUAGE_DISPLAY_NAMES: Record<ConversationLanguage, string> = {
  [ConversationLanguage.ENGLISH]: 'English',
  [ConversationLanguage.SPANISH]: 'Spanish',
  [ConversationLanguage.FRENCH]: 'French',
  [ConversationLanguage.GERMAN]: 'German',
  [ConversationLanguage.CHINESE_SIMPLIFIED]: 'Simplified Chinese',
  [ConversationLanguage.CHINESE_TRADITIONAL]: 'Traditional Chinese',
  [ConversationLanguage.YORUBA]: 'Yoruba',
  [ConversationLanguage.HAUSA]: 'Hausa',
  [ConversationLanguage.IGBO]: 'Igbo',
};

// Best-effort mapping from free-text/regional values that may already exist
// in `user_preferences.language` from before this validation existed. Not
// exhaustive by design — anything not listed here falls back to English.
const LEGACY_LANGUAGE_ALIASES: Record<string, ConversationLanguage> = {
  english: ConversationLanguage.ENGLISH,
  'en-us': ConversationLanguage.ENGLISH,
  'en-gb': ConversationLanguage.ENGLISH,
  'en-au': ConversationLanguage.ENGLISH,
  'en-ca': ConversationLanguage.ENGLISH,
  spanish: ConversationLanguage.SPANISH,
  espanol: ConversationLanguage.SPANISH,
  'español': ConversationLanguage.SPANISH,
  'es-419': ConversationLanguage.SPANISH,
  'es-mx': ConversationLanguage.SPANISH,
  'es-es': ConversationLanguage.SPANISH,
  french: ConversationLanguage.FRENCH,
  francais: ConversationLanguage.FRENCH,
  'français': ConversationLanguage.FRENCH,
  'fr-ca': ConversationLanguage.FRENCH,
  'fr-fr': ConversationLanguage.FRENCH,
  german: ConversationLanguage.GERMAN,
  deutsch: ConversationLanguage.GERMAN,
  'de-de': ConversationLanguage.GERMAN,
  'de-ch': ConversationLanguage.GERMAN,
  chinese: ConversationLanguage.CHINESE_SIMPLIFIED,
  mandarin: ConversationLanguage.CHINESE_SIMPLIFIED,
  zh: ConversationLanguage.CHINESE_SIMPLIFIED,
  'zh-cn': ConversationLanguage.CHINESE_SIMPLIFIED,
  'zh_hans': ConversationLanguage.CHINESE_SIMPLIFIED,
  'simplified chinese': ConversationLanguage.CHINESE_SIMPLIFIED,
  'zh-tw': ConversationLanguage.CHINESE_TRADITIONAL,
  'zh-hk': ConversationLanguage.CHINESE_TRADITIONAL,
  'zh_hant': ConversationLanguage.CHINESE_TRADITIONAL,
  'traditional chinese': ConversationLanguage.CHINESE_TRADITIONAL,
  yoruba: ConversationLanguage.YORUBA,
  hausa: ConversationLanguage.HAUSA,
  igbo: ConversationLanguage.IGBO,
};

const SUPPORTED_SET: ReadonlySet<string> = new Set(SUPPORTED_CONVERSATION_LANGUAGES);

/**
 * Normalizes a raw `user_preferences.language` value into a canonical,
 * supported code. Read-time only — never writes back to storage. Missing,
 * empty, unsupported, or unrecognized legacy values all resolve to English.
 */
export function normalizeLanguageCode(raw: string | null | undefined): ConversationLanguage {
  if (!raw) return ConversationLanguage.ENGLISH;
  if (SUPPORTED_SET.has(raw)) return raw as ConversationLanguage;

  const alias = LEGACY_LANGUAGE_ALIASES[raw.trim().toLowerCase()];
  return alias ?? ConversationLanguage.ENGLISH;
}

/**
 * The one server-owned prompt block that tells Claude what language to
 * answer in. Built entirely from this file's own data — never from a raw
 * client-supplied string — per the "trusted instructions" requirement.
 */
export function buildLanguageDirective(code: string): string {
  const language = SUPPORTED_SET.has(code) ? (code as ConversationLanguage) : ConversationLanguage.ENGLISH;

  if (language === ConversationLanguage.ENGLISH) {
    return '\n\n## OUTPUT LANGUAGE\nRespond in English.';
  }

  const name = LANGUAGE_DISPLAY_NAMES[language];
  return `\n\n## OUTPUT LANGUAGE — MANDATORY\nRespond ENTIRELY in ${name} (${language}), regardless of what language the user's message or transcript is in. This includes every fixed example phrase shown elsewhere in this prompt (e.g. a clarification request, or a "nothing to flag" notice) and any generated title — write those in ${name} too, never copy them verbatim in English. Do not respond in English or any other language. Exception: keep proper names, URLs, code snippets, and verse/citation references in their original form.`;
}

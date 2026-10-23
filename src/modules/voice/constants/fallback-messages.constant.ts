import { ConversationLanguage } from '@/common/constants/conversation-languages.constant';

/**
 * Localized copies of the server-synthesized fallback strings that bypass
 * Claude entirely (sent directly to the client when a generation came back
 * empty, or to confirm a generated document). These are machine-drafted for
 * the first pass — Spanish/French/German/Chinese are reasonably solid, but
 * Yoruba/Hausa/Igbo in particular need the native-language review called for
 * in the frontend doc's acceptance checklist before shipping.
 */

type UnclearFallbackTemplate = (fieldName: string) => string;
type DocumentReadyFallbackTemplate = (docTitle: string, docUrl: string) => string;

const UNCLEAR_FALLBACK_TEMPLATES: Record<ConversationLanguage, UnclearFallbackTemplate> = {
  [ConversationLanguage.ENGLISH]: (field) =>
    `- I didn't quite catch that — could you rephrase?\n` +
    `- Try asking something specific, like: "Explain [topic] step by step"\n` +
    `- Or: "What are the key trends in ${field}?"`,
  [ConversationLanguage.SPANISH]: (field) =>
    `- No entendí bien eso — ¿podrías reformularlo?\n` +
    `- Intenta preguntar algo específico, como: "Explica [tema] paso a paso"\n` +
    `- O: "¿Cuáles son las tendencias clave en ${field}?"`,
  [ConversationLanguage.FRENCH]: (field) =>
    `- Je n'ai pas bien compris — pourriez-vous reformuler ?\n` +
    `- Essayez de poser une question précise, comme : « Explique [sujet] étape par étape »\n` +
    `- Ou : « Quelles sont les tendances clés en ${field} ? »`,
  [ConversationLanguage.GERMAN]: (field) =>
    `- Das habe ich nicht ganz verstanden — könntest du das anders formulieren?\n` +
    `- Versuche, etwas Konkretes zu fragen, z. B.: "Erkläre [Thema] Schritt für Schritt"\n` +
    `- Oder: "Was sind die wichtigsten Trends in ${field}?"`,
  [ConversationLanguage.CHINESE_SIMPLIFIED]: (field) =>
    `- 我没有完全听清楚——你能换个说法吗？\n` +
    `- 试着问一些具体的问题，比如:"逐步解释[主题]"\n` +
    `- 或者:"${field}领域有哪些主要趋势？"`,
  [ConversationLanguage.CHINESE_TRADITIONAL]: (field) =>
    `- 我沒有完全聽清楚——你能換個說法嗎？\n` +
    `- 試著問一些具體的問題，例如:「逐步解釋[主題]」\n` +
    `- 或者:「${field}領域有哪些主要趨勢？」`,
  [ConversationLanguage.YORUBA]: (field) =>
    `- Mi ò gbọ́ ẹ yẹn kedere — ṣé o lè sọ ọ́ lọ́nà míì?\n` +
    `- Gbìyànjú láti béèrè ohun kan pàtó, bí: "Ṣàlàyé [àkọlé] ní ìgbésẹ̀ kọ̀ọ̀kan"\n` +
    `- Tàbí: "Kí ni àwọn ìtẹ̀sí pàtàkì nínú ${field}?"`,
  [ConversationLanguage.HAUSA]: (field) =>
    `- Ban gane da kyau ba — za ka iya sake faɗi?\n` +
    `- Gwada yin tambaya takamaimai, kamar: "Bayyana [batun] mataki-mataki"\n` +
    `- Ko kuma: "Mene ne manyan abubuwan da ake lura da su a ${field}?"`,
  [ConversationLanguage.IGBO]: (field) =>
    `- Anaghị m aghọta nke ọma — ị nwere ike ikwu ya ọzọ?\n` +
    `- Gbalịa ịjụ ihe kpọmkwem, dịka: "Kọwaa [isiokwu] n'usoro"\n` +
    `- Ma ọ bụ: "Gịnị bụ isi mmụba n'ime ${field}?"`,
};

const DOCUMENT_READY_FALLBACK_TEMPLATES: Record<ConversationLanguage, DocumentReadyFallbackTemplate> = {
  [ConversationLanguage.ENGLISH]: (title, url) => `- Your document "${title}" is ready.\n- [Download it here](${url})`,
  [ConversationLanguage.SPANISH]: (title, url) => `- Tu documento "${title}" está listo.\n- [Descárgalo aquí](${url})`,
  [ConversationLanguage.FRENCH]: (title, url) => `- Votre document « ${title} » est prêt.\n- [Téléchargez-le ici](${url})`,
  [ConversationLanguage.GERMAN]: (title, url) => `- Dein Dokument "${title}" ist fertig.\n- [Hier herunterladen](${url})`,
  [ConversationLanguage.CHINESE_SIMPLIFIED]: (title, url) => `- 你的文档"${title}"已准备好。\n- [点击此处下载](${url})`,
  [ConversationLanguage.CHINESE_TRADITIONAL]: (title, url) => `- 你的文件「${title}」已準備好。\n- [點擊此處下載](${url})`,
  [ConversationLanguage.YORUBA]: (title, url) => `- Fáìlì rẹ "${title}" ti ṣetán.\n- [Gbà á sílẹ̀ níbí](${url})`,
  [ConversationLanguage.HAUSA]: (title, url) => `- Takardar ka "${title}" ta shirya.\n- [Sauke ta a nan](${url})`,
  [ConversationLanguage.IGBO]: (title, url) => `- Akwụkwọ gị "${title}" adịla njikere.\n- [Budata ya ebe a](${url})`,
};

const EMPTY_RESPONSE_FALLBACK_TEMPLATES: Record<ConversationLanguage, string> = {
  [ConversationLanguage.ENGLISH]:
    `- I didn't quite catch that — could you rephrase?\n- Try asking something specific about your question.`,
  [ConversationLanguage.SPANISH]:
    `- No entendí bien eso — ¿podrías reformularlo?\n- Intenta preguntar algo más específico sobre tu pregunta.`,
  [ConversationLanguage.FRENCH]:
    `- Je n'ai pas bien compris — pourriez-vous reformuler ?\n- Essayez de poser une question plus précise.`,
  [ConversationLanguage.GERMAN]:
    `- Das habe ich nicht ganz verstanden — könntest du das anders formulieren?\n- Versuche, etwas Konkreteres zu fragen.`,
  [ConversationLanguage.CHINESE_SIMPLIFIED]:
    `- 我没有完全听清楚——你能换个说法吗？\n- 试着把你的问题说得更具体一些。`,
  [ConversationLanguage.CHINESE_TRADITIONAL]:
    `- 我沒有完全聽清楚——你能換個說法嗎？\n- 試著把你的問題說得更具體一些。`,
  [ConversationLanguage.YORUBA]:
    `- Mi ò gbọ́ ẹ yẹn kedere — ṣé o lè sọ ọ́ lọ́nà míì?\n- Gbìyànjú láti béèrè ìbéèrè rẹ lọ́nà tó pọ́n dandan.`,
  [ConversationLanguage.HAUSA]:
    `- Ban gane da kyau ba — za ka iya sake faɗi?\n- Gwada yin bayani dalla-dalla game da tambayarka.`,
  [ConversationLanguage.IGBO]:
    `- Anaghị m aghọta nke ọma — ị nwere ike ikwu ya ọzọ?\n- Gbalịa kọwaa ajụjụ gị nke ọma.`,
};

function resolveLanguage(code: string): ConversationLanguage {
  return (Object.values(ConversationLanguage) as string[]).includes(code)
    ? (code as ConversationLanguage)
    : ConversationLanguage.ENGLISH;
}

export function buildUnclearFallback(outputLanguage: string, fieldName: string): string {
  const template = UNCLEAR_FALLBACK_TEMPLATES[resolveLanguage(outputLanguage)];
  return (template ?? UNCLEAR_FALLBACK_TEMPLATES[ConversationLanguage.ENGLISH])(fieldName);
}

export function buildDocumentReadyFallback(outputLanguage: string, docTitle: string, docUrl: string): string {
  const template = DOCUMENT_READY_FALLBACK_TEMPLATES[resolveLanguage(outputLanguage)];
  return (template ?? DOCUMENT_READY_FALLBACK_TEMPLATES[ConversationLanguage.ENGLISH])(docTitle, docUrl);
}

export function buildEmptyResponseFallback(outputLanguage: string): string {
  return (
    EMPTY_RESPONSE_FALLBACK_TEMPLATES[resolveLanguage(outputLanguage)] ??
    EMPTY_RESPONSE_FALLBACK_TEMPLATES[ConversationLanguage.ENGLISH]
  );
}

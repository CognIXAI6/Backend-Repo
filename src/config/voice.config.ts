import { registerAs } from '@nestjs/config';

export const voiceConfig = registerAs('voice', () => ({
  deepgramApiKey: process.env.DEEPGRAM_API_KEY,
  anthropicApiKey: process.env.ANTHROPIC_API_KEY,
  claudeModel: process.env.CLAUDE_MODEL || 'claude-sonnet-4-20250514',
}));


// export const deepgramConfig = registerAs('deepgram', () => ({
//   apiKey: process.env.DEEPGRAM_API_KEY,
//   liveModel: process.env.DEEPGRAM_LIVE_MODEL || 'nova-3',
// }));

// export const anthropicConfig = registerAs('anthropic', () => ({
//   apiKey: process.env.ANTHROPIC_API_KEY,
//   model: process.env.ANTHROPIC_MODEL || 'claude-sonnet-4-5',
// }));
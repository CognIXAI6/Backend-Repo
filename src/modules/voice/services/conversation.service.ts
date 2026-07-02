import { Injectable, Logger, NotFoundException, Inject } from '@nestjs/common';
import { Knex } from 'knex';

// ─── Types ────────────────────────────────────────────────────────────────────

export type ConversationMode = 'single' | 'double' | 'multi' | 'dual_speaker' | 'multiple_speaker';
export type MessageRole = 'user' | 'assistant';

export interface SaveTranscriptSegmentDto {
  conversationId: string;
  messageId?: string | null;
  speakerId?: string | null;
  deepgramSpeakerId?: number | null;
  speakerLabel: string;
  transcript: string;
  startMs?: number | null;
  endMs?: number | null;
  confidence?: number | null;
  identificationMethod: string;
  recordingSessionId?: string | null;
}

export interface TranscriptSegment {
  id: string;
  conversation_id: string;
  message_id: string | null;
  speaker_id: string | null;
  deepgram_speaker_id: number | null;
  speaker_label: string;
  transcript: string;
  start_ms: number | null;
  end_ms: number | null;
  confidence: number | null;
  identification_method: string;
  is_corrected: boolean;
  recording_session_id: string | null;
  created_at: Date;
}

export interface Conversation {
  id: string;
  user_id: string;
  title: string | null;
  mode: ConversationMode;
  field_id: string | null;
  total_messages: number;
  last_activity_at: Date | null;
  created_at: Date;
  updated_at: Date;
  deleted_at: Date | null;
}

export interface ConversationMessage {
  id: string;
  conversation_id: string;
  role: MessageRole;
  content: string;
  transcript: string | null;
  audio_url: string | null;
  audio_duration_ms: number | null;
  speaker_label: string | null;
  tokens_used: number | null;
  latency_ms: number | null;
  created_at: Date;
}

export interface SaveMessageDto {
  conversationId: string;
  role: MessageRole;
  content: string;
  transcript?: string;
  audioUrl?: string;
  audioDurationMs?: number;
  speakerLabel?: string;
  tokensUsed?: number;
  latencyMs?: number;
}

// ─── Service ──────────────────────────────────────────────────────────────────

@Injectable()
export class ConversationService {
  private readonly logger = new Logger(ConversationService.name);

  // Inject Knex using the token your DatabaseModule provides.
  // Common tokens: 'KNEX_CONNECTION', 'KnexConnection', or Symbol('KNEX')
  // Match whatever your database.module.ts uses.
  constructor(@Inject('KNEX_CONNECTION') private readonly knex: Knex) {}

  // ── Create ──────────────────────────────────────────────────────────────────

  async createConversation(
    userId: string,
    mode: ConversationMode = 'single',
    fieldId?: string,
    title?: string,
  ): Promise<Conversation> {
    const [conversation] = await this.knex('conversations')
      .insert({
        user_id: userId,
        mode,
        field_id: fieldId ?? null,
        title: title ?? null,
        last_activity_at: new Date(),
      })
      .returning('*');

    return conversation;
  }

  // ── Save a message ──────────────────────────────────────────────────────────

  async saveMessage(dto: SaveMessageDto): Promise<ConversationMessage> {
    const [message] = await this.knex('conversation_messages')
      .insert({
        conversation_id: dto.conversationId,
        role: dto.role,
        content: dto.content,
        transcript: dto.transcript ?? null,
        audio_url: dto.audioUrl ?? null,
        audio_duration_ms: dto.audioDurationMs ?? null,
        speaker_label: dto.speakerLabel ?? null,
        tokens_used: dto.tokensUsed ?? null,
        latency_ms: dto.latencyMs ?? null,
      })
      .returning('*');

    // Single atomic update: increment message count + timestamps in one query
    await this.knex('conversations')
      .where('id', dto.conversationId)
      .update({
        total_messages: this.knex.raw('total_messages + 1'),
        last_activity_at: new Date(),
        updated_at: new Date(),
      });

    return message;
  }

  /**
   * Flips all speaker_label values in a conversation between 'owner' and 'other'.
   * Called when biometric verification overrules the initial word-count calibration.
   * A single atomic UPDATE keeps the correction consistent with in-memory state.
   */
  async relabelSpeakers(conversationId: string): Promise<void> {
    await this.knex.raw(
      `UPDATE conversation_messages
          SET speaker_label = CASE
            WHEN speaker_label = 'owner' THEN 'other'
            WHEN speaker_label = 'other' THEN 'owner'
            ELSE speaker_label
          END
        WHERE conversation_id = ?
          AND speaker_label IN ('owner', 'other')`,
      [conversationId],
    );
  }

  /**
   * Sets an AI-generated title on the conversation.
   * Called once after the first AI response — fire-and-forget from the gateway.
   */
  async setTitle(conversationId: string, title: string): Promise<void> {
    await this.knex('conversations')
      .where('id', conversationId)
      .whereNull('title')
      .update({ title, updated_at: new Date() });
  }

  // ── Get paginated history list ──────────────────────────────────────────────

  async getHistory(
    userId: string,
    page = 1,
    limit = 20,
  ): Promise<{ data: Conversation[]; total: number; page: number; lastPage: number }> {
    const offset = (page - 1) * limit;

    const [{ count }] = await this.knex('conversations')
      .where('user_id', userId)
      .whereNull('deleted_at')
      .count('id as count');

    const data = await this.knex('conversations')
      .where('user_id', userId)
      .whereNull('deleted_at')
      .orderBy('last_activity_at', 'desc')
      .limit(limit)
      .offset(offset)
      .select('*');

    const total = Number(count);

    return { data, total, page, lastPage: Math.ceil(total / limit) };
  }

  // ── Get single conversation ─────────────────────────────────────────────────

  async getConversation(
    conversationId: string,
    userId: string,
  ): Promise<Conversation & { messages: ConversationMessage[]; transcriptSegments: TranscriptSegment[] }> {
    const conversation = await this.knex('conversations')
      .where({ id: conversationId, user_id: userId })
      .whereNull('deleted_at')
      .first();

    if (!conversation) throw new NotFoundException('Conversation not found');

    const [messages, transcriptSegments] = await Promise.all([
      this.knex('conversation_messages')
        .where('conversation_id', conversationId)
        .orderBy('created_at', 'asc')
        .select('*'),
      this.knex('conversation_transcript_segments')
        .where('conversation_id', conversationId)
        .orderByRaw('created_at ASC, COALESCE(start_ms, 999999999) ASC')
        .select('*'),
    ]);

    return { ...conversation, messages, transcriptSegments };
  }

  // ── Get messages only ───────────────────────────────────────────────────────

  async getConversationMessages(conversationId: string, userId: string): Promise<ConversationMessage[]> {
    await this.assertOwnership(conversationId, userId);

    return this.knex('conversation_messages')
      .where('conversation_id', conversationId)
      .orderBy('created_at', 'asc')
      .select('*');
  }

  // ── Get history array for Claude context ────────────────────────────────────

  async getConversationHistory(
    conversationId: string,
    userId: string,
  ): Promise<Array<{ role: 'user' | 'assistant'; content: string }>> {
    const messages = await this.getConversationMessages(conversationId, userId);
    return messages.map((m) => ({ role: m.role, content: m.content }));
  }

  /**
   * Lightweight alternative for internal gateway use.
   * Skips the ownership re-check (trust established at session:start) and
   * caps to the most recent `limit` messages so Claude context doesn't grow
   * unbounded in long conversations.
   */
  async getRecentHistoryForAI(
    conversationId: string,
    limit = 40,
  ): Promise<Array<{ role: 'user' | 'assistant'; content: string }>> {
    const messages = await this.knex('conversation_messages')
      .where('conversation_id', conversationId)
      .orderBy('created_at', 'desc')
      .limit(limit)
      .select('role', 'content');

    // Reverse so oldest-first order is preserved for Claude
    return messages.reverse().map((m) => ({ role: m.role as 'user' | 'assistant', content: m.content }));
  }

  // ── Rename ──────────────────────────────────────────────────────────────────

  async renameConversation(conversationId: string, userId: string, title: string): Promise<Conversation> {
    await this.assertOwnership(conversationId, userId);

    const [updated] = await this.knex('conversations')
      .where('id', conversationId)
      .update({ title, updated_at: new Date() })
      .returning('*');

    return updated;
  }

  // ── Soft delete ─────────────────────────────────────────────────────────────

  async deleteConversation(conversationId: string, userId: string): Promise<void> {
    await this.assertOwnership(conversationId, userId);

    await this.knex('conversations')
      .where('id', conversationId)
      .update({ deleted_at: new Date(), updated_at: new Date() });
  }

  // ── Private helpers ─────────────────────────────────────────────────────────

  async assertOwnership(conversationId: string, userId: string): Promise<void> {
    const conv = await this.knex('conversations')
      .where({ id: conversationId, user_id: userId })
      .whereNull('deleted_at')
      .first();

    if (!conv) throw new NotFoundException('Conversation not found');
  }

  // ── Multi-speaker transcript segments ───────────────────────────────────────

  async saveTranscriptSegments(segments: SaveTranscriptSegmentDto[]): Promise<void> {
    if (!segments.length) return;
    await this.knex('conversation_transcript_segments').insert(
      segments.map((s) => ({
        conversation_id: s.conversationId,
        message_id: s.messageId ?? null,
        speaker_id: s.speakerId ?? null,
        deepgram_speaker_id: s.deepgramSpeakerId ?? null,
        speaker_label: s.speakerLabel,
        transcript: s.transcript,
        start_ms: s.startMs ?? null,
        end_ms: s.endMs ?? null,
        confidence: s.confidence ?? null,
        identification_method: s.identificationMethod,
        recording_session_id: s.recordingSessionId ?? null,
      })),
    );
  }

  async correctTranscriptSpeaker(input: {
    conversationId: string;
    deepgramSpeakerId?: number;
    segmentId?: string;
    speakerId: string;
    speakerLabel: string;
    applyTo: 'segment' | 'session_speaker' | 'conversation_speaker';
    recordingSessionId?: string | null;
  }): Promise<void> {
    const query = this.knex('conversation_transcript_segments').where(
      'conversation_id',
      input.conversationId,
    );

    if (input.applyTo === 'segment' && input.segmentId) {
      query.andWhere('id', input.segmentId);
    } else if (input.applyTo === 'session_speaker' && input.deepgramSpeakerId != null && input.recordingSessionId) {
      // Scope to the current recording so speaker 0 in one recording doesn't
      // accidentally relabel speaker 0 from a different recording in the same conversation.
      query
        .andWhere('deepgram_speaker_id', input.deepgramSpeakerId)
        .andWhere('recording_session_id', input.recordingSessionId);
    } else if (input.deepgramSpeakerId != null) {
      // conversation_speaker or no recordingSessionId — update all matching rows
      query.andWhere('deepgram_speaker_id', input.deepgramSpeakerId);
    } else {
      throw new Error('Correction requires segmentId or deepgramSpeakerId');
    }

    await query.update({
      speaker_id: input.speakerId,
      speaker_label: input.speakerLabel,
      identification_method: 'manual',
      is_corrected: true,
    });
  }

  async renameAnonymousSpeaker(input: {
    conversationId: string;
    deepgramSpeakerId: number;
    speakerLabel: string;
    recordingSessionId?: string | null;
  }): Promise<void> {
    const query = this.knex('conversation_transcript_segments')
      .where('conversation_id', input.conversationId)
      .andWhere('deepgram_speaker_id', input.deepgramSpeakerId);

    if (input.recordingSessionId) {
      query.andWhere('recording_session_id', input.recordingSessionId);
    }

    await query.update({
      speaker_label: input.speakerLabel,
      identification_method: 'manual',
      is_corrected: true,
    });
  }

  // ── Gap 6: retroactive segment update after voice ID resolves a speaker ────

  async updateTranscriptSpeakerByDeepgramId(input: {
    conversationId: string;
    deepgramSpeakerId: number;
    speakerId: string | null;
    speakerLabel: string;
    identificationMethod: 'voice_id' | 'manual' | 'diarization' | 'unknown';
    recordingSessionId?: string | null;
  }): Promise<void> {
    const query = this.knex('conversation_transcript_segments')
      .where('conversation_id', input.conversationId)
      .andWhere('deepgram_speaker_id', input.deepgramSpeakerId)
      .andWhere('is_corrected', false);

    if (input.recordingSessionId) {
      query.andWhere('recording_session_id', input.recordingSessionId);
    }

    await query.update({
      speaker_id: input.speakerId,
      speaker_label: input.speakerLabel,
      identification_method: input.identificationMethod,
    });
  }

  // ── Gap 3: dedicated segment read ─────────────────────────────────────────

  async getTranscriptSegments(
    conversationId: string,
    userId: string,
  ): Promise<TranscriptSegment[]> {
    await this.assertOwnership(conversationId, userId);

    return this.knex('conversation_transcript_segments')
      .where('conversation_id', conversationId)
      .orderByRaw('created_at ASC, COALESCE(start_ms, 999999999) ASC')
      .select('*');
  }
}
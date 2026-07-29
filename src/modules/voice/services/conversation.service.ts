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

export interface DocumentMeta {
  id: string;
  title: string;
  topic: string | null;
  download_url: string;
  section_count: number;
  created_at: Date;
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
  document_id: string | null;
  document: DocumentMeta | null;
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
  documentId?: string;
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
        document_id: dto.documentId ?? null,
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

  async saveMessageWithTranscriptSegments(
    dto: SaveMessageDto,
    segments: SaveTranscriptSegmentDto[],
  ): Promise<ConversationMessage> {
    return this.knex.transaction(async (trx) => {
      const [message] = await trx('conversation_messages')
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

      if (segments.length > 0) {
        await trx('conversation_transcript_segments').insert(
          segments.map((s) => ({
            conversation_id: s.conversationId,
            message_id: message.id,
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

      await trx('conversations')
        .where('id', dto.conversationId)
        .update({
          total_messages: trx.raw('total_messages + 1'),
          last_activity_at: new Date(),
          updated_at: new Date(),
        });

      return message;
    });
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
   * Only updates when the title is still NULL — never overwrites a user-set or
   * previously generated title. Returns whether the update actually happened
   * so the caller can emit a real-time event to the client.
   */
  async setTitle(conversationId: string, title: string): Promise<boolean> {
    const updated = await this.knex('conversations')
      .where('id', conversationId)
      .whereNull('title')
      .update({ title, updated_at: new Date() });
    // Knex update() returns the number of rows affected.
    return updated > 0;
  }

  /**
   * Returns the most recent conversation for this user+mode that has zero messages.
   * Used by session:start to reuse an existing empty conversation instead of
   * creating a duplicate "Untitled conversation" every time the user presses Record.
   */
  async findRecentEmptyConversation(
    userId: string,
    mode: ConversationMode,
  ): Promise<Conversation | null> {
    return (
      (await this.knex('conversations')
        .where({ user_id: userId, mode, total_messages: 0 })
        .whereNull('deleted_at')
        .orderBy('created_at', 'desc')
        .first()) ?? null
    );
  }

  // ── Get paginated history list ──────────────────────────────────────────────

  async getHistory(
    userId: string,
    page = 1,
    limit = 20,
  ): Promise<{ data: Conversation[]; total: number; page: number; lastPage: number }> {
    const offset = (page - 1) * limit;

    // Exclude empty conversations (total_messages = 0) — they are either brand-new
    // sessions that haven't been used yet, or leftover duplicates. They have nothing
    // meaningful to show in the history sidebar.
    const baseQuery = () =>
      this.knex('conversations')
        .where('user_id', userId)
        .whereNull('deleted_at')
        .where('total_messages', '>', 0);

    const [{ count }] = await baseQuery().count('id as count');

    const data = await baseQuery()
      .orderBy('last_activity_at', 'desc')
      .limit(limit)
      .offset(offset)
      .select('*');

    const total = Number(count);

    return { data, total, page, lastPage: Math.ceil(total / limit) };
  }

  /**
   * Hard-deletes all empty (no messages) conversations for a user.
   * Useful as a one-time cleanup for users who accumulated duplicates.
   */
  async purgeEmptyConversations(userId: string): Promise<number> {
    return this.knex('conversations')
      .where({ user_id: userId, total_messages: 0 })
      .whereNull('deleted_at')
      .delete();
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
      this.fetchMessagesWithDocuments(conversationId),
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
    return this.fetchMessagesWithDocuments(conversationId);
  }

  // ── Shared messages query with document join ─────────────────────────────────

  private async fetchMessagesWithDocuments(conversationId: string): Promise<ConversationMessage[]> {
    const rows = await this.knex('conversation_messages as m')
      .leftJoin('generated_documents as d', 'm.document_id', 'd.id')
      .where('m.conversation_id', conversationId)
      .orderBy('m.created_at', 'asc')
      .select(
        'm.id',
        'm.conversation_id',
        'm.role',
        'm.content',
        'm.transcript',
        'm.audio_url',
        'm.audio_duration_ms',
        'm.speaker_label',
        'm.tokens_used',
        'm.latency_ms',
        'm.document_id',
        'm.created_at',
        'd.id as doc_id',
        'd.title as doc_title',
        'd.topic as doc_topic',
        'd.download_url as doc_download_url',
        'd.section_count as doc_section_count',
        'd.created_at as doc_created_at',
      );

    return rows.map((row) => {
      const { doc_id, doc_title, doc_topic, doc_download_url, doc_section_count, doc_created_at, ...msg } = row as Record<string, unknown>;

      const document: DocumentMeta | null = doc_id
        ? {
            id: doc_id as string,
            title: doc_title as string,
            topic: doc_topic as string | null,
            download_url: doc_download_url as string,
            section_count: doc_section_count as number,
            created_at: doc_created_at as Date,
          }
        : null;

      return { ...(msg as Omit<ConversationMessage, 'document'>), document };
    });
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
    applyTo: 'session_speaker' | 'conversation_speaker';
    recordingSessionId?: string | null;
  }): Promise<void> {
    const query = this.knex('conversation_transcript_segments')
      .where('conversation_id', input.conversationId)
      .andWhere('deepgram_speaker_id', input.deepgramSpeakerId);

    if (input.applyTo === 'session_speaker' && input.recordingSessionId) {
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

  // ── Conversation documents (in-context file attachments) ───────────────────

  async saveConversationDocument(data: {
    conversationId: string;
    userId: string;
    filename: string;
    mimeType: string;
    fileUrl: string | null;
    contentMarkdown: string;
  }): Promise<{ id: string; filename: string; charCount: number }> {
    const charCount = data.contentMarkdown.length;
    const [doc] = await this.knex('conversation_documents')
      .insert({
        conversation_id: data.conversationId,
        user_id: data.userId,
        filename: data.filename,
        mime_type: data.mimeType,
        file_url: data.fileUrl ?? null,
        content_markdown: data.contentMarkdown,
        char_count: charCount,
      })
      .returning(['id', 'filename', 'char_count']);

    return { id: doc.id, filename: doc.filename, charCount: doc.char_count };
  }

  /**
   * Returns all documents attached to a conversation, formatted as a single
   * Markdown block ready to inject into the AI system prompt.
   * Returns null when no documents are attached.
   */
  async getConversationDocumentContext(conversationId: string): Promise<string | null> {
    const docs = await this.knex('conversation_documents')
      .where('conversation_id', conversationId)
      .orderBy('created_at', 'asc')
      .select('filename', 'content_markdown');

    if (!docs.length) return null;

    return docs
      .map((d: { filename: string; content_markdown: string }) =>
        `=== ATTACHED DOCUMENT: ${d.filename} ===\n\n${d.content_markdown}\n\n=== END OF DOCUMENT ===`,
      )
      .join('\n\n');
  }

  async listConversationDocuments(conversationId: string): Promise<{ id: string; filename: string; mimeType: string; charCount: number; createdAt: Date }[]> {
    return this.knex('conversation_documents')
      .where('conversation_id', conversationId)
      .orderBy('created_at', 'asc')
      .select('id', 'filename', 'mime_type as mimeType', 'char_count as charCount', 'created_at as createdAt');
  }
}

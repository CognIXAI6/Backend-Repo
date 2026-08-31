import { Injectable, Logger, NotFoundException, Inject } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Knex } from 'knex';

// ─── Types ────────────────────────────────────────────────────────────────────

export type ConversationMode = 'single' | 'double' | 'multi' | 'dual_speaker' | 'multiple_speaker';
export type MessageRole = 'user' | 'assistant';

export interface ConversationImage {
  id: string;
  conversation_id: string;
  user_id: string;
  filename: string;
  mime_type: string;
  file_url: string;
  image_base64: string;
  sent_to_ai: boolean;
  created_at: Date;
  updated_at: Date;
}

export interface SaveConversationImageDto {
  conversationId: string;
  userId: string;
  filename: string;
  mimeType: string;
  fileUrl: string;
  imageBase64: string;
}

export interface ConversationParticipant {
  id: string;
  conversation_id: string;
  user_id: string;
  speaker_id: string | null;
  display_name: string;
  role: 'owner' | 'participant';
  voice_speaker_id: string | null;
  voice_confirmed: boolean;
  created_at: Date;
  updated_at: Date;
}

export interface UpsertParticipantDto {
  conversationId: string;
  userId: string;
  displayName: string;
  role?: 'owner' | 'participant';
  speakerId?: string | null;
  voiceSpeakerId?: string | null;
  voiceConfirmed?: boolean;
}

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
  client_message_id: string | null;
  conversation_sequence: number | null;
  delivery_source: MessageDeliverySource;
  created_at: Date;
}

export type MessageDeliverySource = 'text' | 'voice' | 'attachment' | 'regenerate';

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
  /** Set only by the durable chat command path — undefined for voice-originated messages. */
  clientMessageId?: string;
  /** Defaults to 'voice' to match every existing caller's behavior unchanged. */
  deliverySource?: MessageDeliverySource;
}

// ─── Service ──────────────────────────────────────────────────────────────────

@Injectable()
export class ConversationService {
  private readonly logger = new Logger(ConversationService.name);

  // Every table with a conversation_id FK that must be empty before a
  // conversation is eligible for cleanup — see buildCleanupCandidatesQuery.
  // generated_documents.conversation_id is SET NULL (not CASCADE) on delete,
  // so it wouldn't destroy the document, but it WOULD silently orphan the
  // conversation association — excluded for the same reason as the rest.
  private static readonly CLEANUP_PROTECTED_TABLES = [
    'conversation_messages',
    'conversation_transcript_segments',
    'conversation_participants',
    'conversation_images',
    'conversation_documents',
    'resource_conversations',
    'generated_documents',
  ] as const;

  // Inject Knex using the token your DatabaseModule provides.
  // Common tokens: 'KNEX_CONNECTION', 'KnexConnection', or Symbol('KNEX')
  // Match whatever your database.module.ts uses.
  constructor(
    @Inject('KNEX_CONNECTION') private readonly knex: Knex,
    private readonly configService: ConfigService,
  ) {}

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

  /**
   * @param trx Run inside an already-open transaction (e.g. so a caller can
   * atomically save the message and insert a related row, like
   * ChatMessageService does with ai_response_jobs). Omit to have this method
   * open and commit its own transaction, as every existing caller does.
   */
  async saveMessage(dto: SaveMessageDto, trx?: Knex.Transaction): Promise<ConversationMessage> {
    if (trx) return this.saveMessageInTransaction(dto, trx);
    // Transactional: the message insert and the conversation counter bumps
    // must commit together. Split into separate round-trips, a failure
    // between them leaves a real message behind a stale total_messages = 0
    // — which cleanup (purgeEmptyConversations) uses as its "safe to
    // delete" signal.
    return this.knex.transaction((innerTrx) => this.saveMessageInTransaction(dto, innerTrx));
  }

  private async saveMessageInTransaction(dto: SaveMessageDto, trx: Knex.Transaction): Promise<ConversationMessage> {
    // Claim the next sequence atomically — the UPDATE's row lock means a
    // concurrent saveMessage() for the same conversation blocks until this
    // commits, so two messages can never be assigned the same sequence.
    const [{ next_message_sequence: conversationSequence }] = await trx('conversations')
      .where('id', dto.conversationId)
      .update({
        total_messages: trx.raw('total_messages + 1'),
        next_message_sequence: trx.raw('next_message_sequence + 1'),
        last_activity_at: new Date(),
        updated_at: new Date(),
      })
      .returning('next_message_sequence');

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
        document_id: dto.documentId ?? null,
        client_message_id: dto.clientMessageId ?? null,
        conversation_sequence: conversationSequence,
        delivery_source: dto.deliverySource ?? 'voice',
      })
      .returning('*');

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
  /**
   * The shared "is this conversation actually safe to delete as empty"
   * predicate, used by both the on-demand DELETE /conversations/empty
   * endpoint and the scheduled cleanup job. `total_messages = 0` is only a
   * cheap pre-filter (it's a cached counter, and saveMessage() writing it
   * non-transactionally used to be able to drift — now fixed, but still not
   * treated as authoritative here); real eligibility is re-derived from a
   * NOT EXISTS check against every table that can hold a conversation_id
   * FK, so a conversation with zero messages but a tagged resource,
   * participant, image, upload, or generated-document link is never swept.
   */
  buildCleanupCandidatesQuery(
    trx: Knex.Transaction | Knex,
    opts: { userId?: string; olderThanHours: number },
  ) {
    let q = trx('conversations')
      .where('total_messages', 0)
      .whereNull('deleted_at')
      .where('created_at', '<', trx.raw(`now() - interval '${opts.olderThanHours} hours'`));

    if (opts.userId) {
      q = q.andWhere('user_id', opts.userId);
    }

    for (const table of ConversationService.CLEANUP_PROTECTED_TABLES) {
      q = q.whereNotExists(
        trx(table).whereRaw(`${table}.conversation_id = conversations.id`),
      );
    }

    return q;
  }

  async purgeEmptyConversations(userId: string): Promise<number> {
    const gracePeriodHours = this.configService.get<number>('cleanup.gracePeriodHours') ?? 24;
    return this.buildCleanupCandidatesQuery(this.knex, { userId, olderThanHours: gracePeriodHours }).delete();
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

  /**
   * Reconciliation read for the durable chat command path — messages saved
   * after a given conversation_sequence. Rows saved before sequencing was
   * added (or via saveMessageWithTranscriptSegments, which doesn't assign
   * one) have a NULL conversation_sequence and are never returned here.
   */
  async getMessagesAfterSequence(
    conversationId: string,
    userId: string,
    afterSequence: number,
  ): Promise<ConversationMessage[]> {
    await this.assertOwnership(conversationId, userId);
    return this.knex('conversation_messages')
      .where('conversation_id', conversationId)
      .andWhere('conversation_sequence', '>', afterSequence)
      .orderBy('conversation_sequence', 'asc');
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
   * Returns all documents attached to a specific conversation, formatted as a
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

  /**
   * Unified document context for AI injection.
   *
   * Combines three sources:
   *   1. Documents attached directly to this conversation (chat attachment upload)
   *   2. Resources explicitly tagged to this conversation from the Resources tab
   *      ("Create Resource" with conversationIds).
   *   3. Field-level resources with extracted text content — up to the 5 most
   *      recently added ones for the conversation's professional field, excluding
   *      anything already covered by (2) so it isn't duplicated.
   *
   * This fixes the disconnect where a resource uploaded via the Resources tab was
   * acknowledged in chat but invisible to the AI because it lived in a separate table.
   */
  async getFullDocumentContext(conversationId: string, userId: string): Promise<string | null> {
    // ── 1. Conversation-specific attachments ─────────────────────────────────
    const convDocs = await this.knex('conversation_documents')
      .where('conversation_id', conversationId)
      .orderBy('created_at', 'asc')
      .select('filename', 'content_markdown');

    // ── 2. Resources explicitly tagged to this conversation ──────────────────
    const taggedResources: { id: string; title: string; extracted_content: string }[] = await this.knex('resources')
      .join('resource_conversations', 'resources.id', 'resource_conversations.resource_id')
      .where('resource_conversations.conversation_id', conversationId)
      .whereNotNull('resources.extracted_content')
      .whereRaw("resources.extracted_content <> ''")
      .orderBy('resource_conversations.created_at', 'asc')
      .select('resources.id', 'resources.title', 'resources.extracted_content');

    const taggedResourceIds = taggedResources.map((r) => r.id);

    // ── 3. Field resources (Resources-tab uploads, matched by professional field) ──
    // Look up the field that this conversation belongs to so we only pull
    // resources from the matching professional context.
    const conv = await this.knex('conversations')
      .where('id', conversationId)
      .first('field_id');

    const fieldResources: { title: string; extracted_content: string }[] = conv?.field_id
      ? await this.knex('resources')
          .where('user_id', userId)
          .where('field_id', conv.field_id)
          .whereNotNull('extracted_content')
          .whereRaw("extracted_content <> ''")
          .modify((qb) => {
            if (taggedResourceIds.length) qb.whereNotIn('id', taggedResourceIds);
          })
          .orderBy('created_at', 'desc')
          .limit(5)
          .select('title', 'extracted_content')
      : [];

    const parts: string[] = [
      ...convDocs.map((d: { filename: string; content_markdown: string }) =>
        `=== ATTACHED DOCUMENT: ${d.filename} ===\n\n${d.content_markdown}\n\n=== END OF DOCUMENT ===`,
      ),
      ...taggedResources.map((r) =>
        `=== TAGGED RESOURCE: ${r.title} ===\n\n${r.extracted_content}\n\n=== END OF RESOURCE ===`,
      ),
      ...fieldResources.map((r) =>
        `=== FIELD RESOURCE: ${r.title} ===\n\n${r.extracted_content}\n\n=== END OF RESOURCE ===`,
      ),
    ];

    return parts.length > 0 ? parts.join('\n\n') : null;
  }

  async listConversationDocuments(conversationId: string): Promise<{ id: string; filename: string; mimeType: string; charCount: number; createdAt: Date }[]> {
    return this.knex('conversation_documents')
      .where('conversation_id', conversationId)
      .orderBy('created_at', 'asc')
      .select('id', 'filename', 'mime_type as mimeType', 'char_count as charCount', 'created_at as createdAt');
  }

  // ─── Conversation participants (durable speaker identity) ─────────────────

  /**
   * Creates or updates a conversation participant by display_name.
   * Using display_name as the natural key — one record per named speaker per conversation.
   */
  async upsertConversationParticipant(dto: UpsertParticipantDto): Promise<ConversationParticipant> {
    const existing = await this.knex('conversation_participants')
      .where('conversation_id', dto.conversationId)
      .whereRaw('LOWER(display_name) = ?', [dto.displayName.toLowerCase()])
      .first();

    if (existing) {
      const [updated] = await this.knex('conversation_participants')
        .where('id', existing.id)
        .update({
          speaker_id: dto.speakerId ?? existing.speaker_id,
          voice_speaker_id: dto.voiceSpeakerId ?? existing.voice_speaker_id,
          voice_confirmed: dto.voiceConfirmed ?? existing.voice_confirmed,
          role: dto.role ?? existing.role,
          updated_at: new Date(),
        })
        .returning('*');
      return updated;
    }

    const [created] = await this.knex('conversation_participants')
      .insert({
        conversation_id: dto.conversationId,
        user_id: dto.userId,
        display_name: dto.displayName,
        role: dto.role ?? 'participant',
        speaker_id: dto.speakerId ?? null,
        voice_speaker_id: dto.voiceSpeakerId ?? null,
        voice_confirmed: dto.voiceConfirmed ?? false,
      })
      .returning('*');
    return created;
  }

  /** Returns all participants for a conversation, ordered by creation time. */
  async getConversationParticipants(conversationId: string): Promise<ConversationParticipant[]> {
    return this.knex('conversation_participants')
      .where('conversation_id', conversationId)
      .orderBy('created_at', 'asc');
  }

  // ─── Conversation images (Claude Vision) ───────────────────────────────────

  /** Saves an uploaded image for vision injection on every subsequent AI call. */
  async saveConversationImage(dto: SaveConversationImageDto): Promise<ConversationImage> {
    const [row] = await this.knex('conversation_images')
      .insert({
        conversation_id: dto.conversationId,
        user_id: dto.userId,
        filename: dto.filename,
        mime_type: dto.mimeType,
        file_url: dto.fileUrl,
        image_base64: dto.imageBase64,
        sent_to_ai: false,
      })
      .returning('*');
    return row;
  }

  /**
   * Returns all images attached to a conversation, so they stay in context for
   * the lifetime of the conversation — the same treatment as attached documents.
   */
  async getConversationImagesForAI(conversationId: string): Promise<ConversationImage[]> {
    return this.knex('conversation_images')
      .where('conversation_id', conversationId)
      .orderBy('created_at', 'asc');
  }

  /** Lists all images ever attached to a conversation (for display purposes). */
  async listConversationImages(conversationId: string): Promise<Pick<ConversationImage, 'id' | 'filename' | 'mime_type' | 'file_url' | 'sent_to_ai' | 'created_at'>[]> {
    return this.knex('conversation_images')
      .where('conversation_id', conversationId)
      .orderBy('created_at', 'asc')
      .select('id', 'filename', 'mime_type', 'file_url', 'sent_to_ai', 'created_at');
  }
}

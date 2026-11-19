import { Injectable, Logger, NotFoundException, Inject } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Knex } from 'knex';
import { fetchTimingDetail, fetchTimingSummaries } from './recording-timing.service';
import { SummaryEmailReason, SummaryEmailStatus, deriveSummaryEmail } from '../utils/summary-email-status.util';

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
  /** Provider-connection epoch the speaker number belongs to. */
  providerEpoch?: number | null;
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
  provider_epoch?: number | null;
  /** Alias of recording_session_id under the name web/mobile parse for speaker scoping. */
  provider_session_epoch?: string | null;
  is_corrected: boolean;
  recording_session_id: string | null;
  created_at: Date;
}

export type SummaryStatus = 'not_started' | 'pending' | 'ready' | 'failed' | 'skipped';

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
  summary_status: SummaryStatus;
  summary_skip_reason: string | null;
  summary_document_id: string | null;
}

export interface ConversationSummaryPart {
  id: string;
  conversation_id: string;
  title: string;
  topic: string | null;
  sections: Array<{ heading: string; content: string }>;
  covers_from: Date;
  covers_to: Date;
  /** Structured session content (summary, transcript turns with insights, key insights, actions); null for older parts. */
  session_data?: import('@/modules/documents/summary-report/summary-report.types').StoredSessionData | null;
  created_at: Date;
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
  /** The conversation's owner — enforced inside the write, so a conversation id alone can't be written to. */
  userId: string;
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

  /**
   * Ownership predicate for child tables keyed by conversation_id: the parent conversation
   * belongs to `userId` and is not deleted. Applied INSIDE every conversation-scoped query below,
   * so a conversation id alone never grants access — even for internal (gateway/worker) callers.
   */
  private whereConversationOwnedBy(qb: Knex.QueryBuilder, table: string, userId: string): Knex.QueryBuilder {
    return qb.whereExists(
      this.knex('conversations')
        .select(this.knex.raw('1'))
        .whereRaw('conversations.id = ??.conversation_id', [table])
        .andWhere('conversations.user_id', userId)
        .whereNull('conversations.deleted_at'),
    );
  }

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
    // Ownership is part of the claim: only the owner's conversation is written to. (Soft-deleted
    // conversations still accept a late in-flight reply, as before — ownership is what matters here.)
    const claimed = await trx('conversations')
      .where({ id: dto.conversationId, user_id: dto.userId })
      .update({
        total_messages: trx.raw('total_messages + 1'),
        next_message_sequence: trx.raw('next_message_sequence + 1'),
        last_activity_at: new Date(),
        updated_at: new Date(),
      })
      .returning('next_message_sequence');
    if (claimed.length === 0) throw new NotFoundException('Conversation not found');
    const conversationSequence = claimed[0].next_message_sequence;

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
      const owned = await trx('conversations').where({ id: dto.conversationId, user_id: dto.userId }).first('id');
      if (!owned) throw new NotFoundException('Conversation not found');

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
            // always the message's own (ownership-checked) conversation — never a per-segment id
            conversation_id: dto.conversationId,
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
            provider_epoch: s.providerEpoch ?? null,
          })),
        );
      }

      await trx('conversations')
        .where({ id: dto.conversationId, user_id: dto.userId })
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
  async relabelSpeakers(conversationId: string, userId: string): Promise<void> {
    await this.knex.raw(
      `UPDATE conversation_messages
          SET speaker_label = CASE
            WHEN speaker_label = 'owner' THEN 'other'
            WHEN speaker_label = 'other' THEN 'owner'
            ELSE speaker_label
          END
        WHERE conversation_id = ?
          AND speaker_label IN ('owner', 'other')
          AND EXISTS (SELECT 1 FROM conversations c
                       WHERE c.id = conversation_messages.conversation_id AND c.user_id = ? AND c.deleted_at IS NULL)`,
      [conversationId, userId],
    );
  }

  /**
   * The conversation's own title — e.g. for the summary-ready email's
   * "{{Conversation Name}}", which should read like the sidebar entry the
   * user actually clicked into, not whatever title the generated document
   * itself picked (the two commonly differ in wording).
   */
  async getConversationTitle(conversationId: string, userId: string): Promise<string | null> {
    const row = await this.knex('conversations').where({ id: conversationId, user_id: userId }).whereNull('deleted_at').first('title');
    return row?.title ?? null;
  }

  /**
   * Sets an AI-generated title on the conversation.
   * Only updates when the title is still NULL — never overwrites a user-set or
   * previously generated title. Returns whether the update actually happened
   * so the caller can emit a real-time event to the client.
   */
  async setTitle(conversationId: string, userId: string, title: string): Promise<boolean> {
    const updated = await this.knex('conversations')
      .where({ id: conversationId, user_id: userId })
      .whereNull('deleted_at')
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
    fieldId: string | null = null,
  ): Promise<Conversation | null> {
    const q = this.knex('conversations')
      .where({ user_id: userId, mode, total_messages: 0 })
      .whereNull('deleted_at');
    // Reuse only inside the same professional field (null matches null): an empty
    // Healthcare conversation must never be handed back to a Law session.
    if (fieldId) q.andWhere('field_id', fieldId);
    else q.whereNull('field_id');
    return (await q.orderBy('created_at', 'desc').first()) ?? null;
  }

  /** The field a conversation was created under (null = none, and also null if it isn't `userId`'s conversation). */
  async getConversationFieldId(conversationId: string, userId: string): Promise<string | null> {
    const row = await this.knex('conversations').where({ id: conversationId, user_id: userId }).whereNull('deleted_at').first('field_id');
    return row?.field_id ?? null;
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

    // Additive: list-safe timing aggregate + independent message-date bounds.
    const summaries = await fetchTimingSummaries(this.knex, data);
    const withTiming = data.map((conv) => ({ ...conv, ...(summaries.get(conv.id) ?? {}), summaryEmail: deriveSummaryEmail(conv as any) }));

    return { data: withTiming, total, page, lastPage: Math.ceil(total / limit) };
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
  ): Promise<Conversation & { messages: ConversationMessage[]; transcriptSegments: TranscriptSegment[]; timing: Record<string, unknown>; messageDateBounds: Record<string, unknown>; summaryEmail: ReturnType<typeof deriveSummaryEmail> }> {
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
        .select('*', this.knex.raw('recording_session_id AS provider_session_epoch')),
    ]);

    const { timing, messageDateBounds } = await fetchTimingDetail(this.knex, conversation);

    return { ...conversation, messages, transcriptSegments, timing, messageDateBounds, summaryEmail: deriveSummaryEmail(conversation) };
  }

  // ── Auto-summary status ─────────────────────────────────────────────────────

  /**
   * Persists where the auto-generated conversation summary stands, so a
   * client can poll `GET /conversations/:id` for a real answer instead of
   * guessing from a live socket event that routinely arrives after the
   * client has already disconnected (see voice.gateway.ts's
   * autoGenerateConversationSummary). No ownership check — called
   * internally by the gateway, which already trusts the session.
   */
  /**
   * Atomically claims the right to generate an auto-summary for a conversation.
   * Returns false when another run already holds it ('pending' and fresh) or
   * the existing 'ready' summary already covers every message — so a socket
   * drop/reconnect/stop cycle can't produce one summary (and one email) per
   * cycle. A 'ready' summary is only superseded when real messages (not the
   * "summary is ready" document message) were saved after the last summarised
   * part; a 'pending' claim older than the stale window is treated as a
   * crashed run and may be re-claimed.
   */
  async claimSummaryGeneration(conversationId: string, userId: string, staleAfterMs = 10 * 60 * 1000): Promise<boolean> {
    const staleBefore = new Date(Date.now() - staleAfterMs);
    const result = await this.knex.raw(
      `UPDATE conversations
          SET summary_status = 'pending', updated_at = NOW()
        WHERE id = ?
          AND user_id = ?
          AND deleted_at IS NULL
          AND (
            summary_status IN ('not_started', 'failed', 'skipped')
            OR (summary_status = 'pending' AND updated_at < ?)
            OR (summary_status = 'ready' AND EXISTS (
                  SELECT 1 FROM conversation_messages m
                   WHERE m.conversation_id = conversations.id
                     AND m.document_id IS NULL
                     AND m.created_at > COALESCE(
                           (SELECT MAX(p.covers_to) FROM conversation_summary_parts p
                             WHERE p.conversation_id = conversations.id),
                           '-infinity'::timestamptz)))
          )`,
      [conversationId, userId, staleBefore],
    );
    return (result?.rowCount ?? 0) > 0;
  }

  /**
   * Messages added since the last summarised part (all of them if none yet),
   * oldest first. The cutoff is resolved inside SQL so microsecond timestamps
   * are compared exactly; the "X is ready" document messages are excluded.
   */
  async getUnsummarizedMessages(conversationId: string, userId: string): Promise<ConversationMessage[]> {
    const result = await this.knex.raw(
      `SELECT m.* FROM conversation_messages m
        WHERE m.conversation_id = ?
          AND EXISTS (SELECT 1 FROM conversations c WHERE c.id = m.conversation_id AND c.user_id = ? AND c.deleted_at IS NULL)
          AND m.document_id IS NULL
          AND m.created_at > COALESCE(
                (SELECT MAX(p.covers_to) FROM conversation_summary_parts p WHERE p.conversation_id = ?),
                '-infinity'::timestamptz)
        ORDER BY m.created_at ASC`,
      [conversationId, userId, conversationId],
    );
    return (result?.rows ?? []) as ConversationMessage[];
  }

  async getSummaryParts(conversationId: string, userId: string): Promise<ConversationSummaryPart[]> {
    return this.whereConversationOwnedBy(
      this.knex('conversation_summary_parts').where('conversation_id', conversationId),
      'conversation_summary_parts',
      userId,
    )
      .orderBy('covers_from', 'asc')
      .select('*');
  }

  /** Records a summarised stretch; covers_from/to are copied from the messages' own timestamps. */
  async addSummaryPart(
    conversationId: string,
    userId: string,
    part: { title: string; topic: string | null; sections: Array<{ heading: string; content: string }> },
    firstMessageId: string,
    lastMessageId: string,
    sessionData?: import('@/modules/documents/summary-report/summary-report.types').StoredSessionData | null,
  ): Promise<void> {
    // Only for the owner's conversation, and the covered range is read from messages of THAT
    // conversation: an id from elsewhere yields NULL (rejected by NOT NULL), never a foreign timestamp.
    const result = await this.knex.raw(
      `INSERT INTO conversation_summary_parts (conversation_id, title, topic, sections, session_data, covers_from, covers_to)
       SELECT c.id, ?, ?, ?::jsonb, ?::jsonb,
              (SELECT created_at FROM conversation_messages WHERE id = ? AND conversation_id = c.id),
              (SELECT created_at FROM conversation_messages WHERE id = ? AND conversation_id = c.id)
         FROM conversations c
        WHERE c.id = ? AND c.user_id = ? AND c.deleted_at IS NULL`,
      [part.title, part.topic, JSON.stringify(part.sections), sessionData ? JSON.stringify(sessionData) : null, firstMessageId, lastMessageId, conversationId, userId],
    );
    if ((result?.rowCount ?? 0) === 0) throw new NotFoundException('Conversation not found');
  }

  /**
   * Records the coarse outcome of the summary email (see summary-email-status.util.ts).
   * `pending` (or an immediate `skipped`) opens a new attempt for a summary document; a final
   * accepted/failed status only applies if that attempt is still the current one, so a slow older attempt can't overwrite a newer
   * one. Never stores a recipient, provider response or content. Only applies to `userId`'s own conversation.
   */
  async setSummaryEmailStatus(
    conversationId: string,
    userId: string,
    outcome: { status: SummaryEmailStatus; reason?: SummaryEmailReason | null; documentId: string | null },
  ): Promise<boolean> {
    const update = {
      summary_email_status: outcome.status,
      summary_email_reason: outcome.reason ?? null,
      summary_email_updated_at: new Date(),
      summary_email_document_id: outcome.documentId,
    };
    const q = this.knex('conversations').where({ id: conversationId, user_id: userId }).whereNull('deleted_at');
    if (outcome.status === 'accepted_by_provider' || outcome.status === 'failed') {
      q.andWhere((b) => {
        b.whereNull('summary_email_document_id');
        if (outcome.documentId) b.orWhere('summary_email_document_id', outcome.documentId);
      });
    }
    return (await q.update(update)) > 0;
  }

  async setSummaryStatus(
    conversationId: string,
    userId: string,
    status: SummaryStatus,
    opts: { skipReason?: string | null; documentId?: string | null } = {},
  ): Promise<void> {
    const update: Record<string, unknown> = { summary_status: status, updated_at: new Date() };
    if ('skipReason' in opts) update.summary_skip_reason = opts.skipReason ?? null;
    // A success must not keep an earlier attempt's failure reason ("ready / generation_error").
    else if (status === 'ready') update.summary_skip_reason = null;
    if ('documentId' in opts) update.summary_document_id = opts.documentId ?? null;

    // Only the owner's (non-deleted) conversation; anything else updates nothing.
    await this.knex('conversations').where({ id: conversationId, user_id: userId }).whereNull('deleted_at').update(update);
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
   * Lightweight alternative for internal gateway use: caps to the most recent `limit` messages so
   * Claude context doesn't grow unbounded. Ownership is enforced inside the query (not trusted from the caller).
   */
  async getRecentHistoryForAI(
    conversationId: string,
    userId: string,
    limit = 40,
  ): Promise<Array<{ role: 'user' | 'assistant'; content: string }>> {
    const messages = await this.whereConversationOwnedBy(
      this.knex('conversation_messages').where('conversation_id', conversationId),
      'conversation_messages',
      userId,
    )
      .orderBy('created_at', 'desc')
      .limit(limit)
      .select('role', 'content');

    // Reverse so oldest-first order is preserved for Claude
    return (messages as Array<{ role: string; content: string }>).reverse().map((m) => ({ role: m.role as 'user' | 'assistant', content: m.content }));
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

  async saveTranscriptSegments(segments: SaveTranscriptSegmentDto[], userId: string): Promise<void> {
    if (!segments.length) return;
    // Every distinct conversation these segments name must belong to `userId`.
    for (const conversationId of new Set(segments.map((s) => s.conversationId))) {
      await this.assertOwnership(conversationId, userId);
    }
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
        provider_epoch: s.providerEpoch ?? null,
      })),
    );
  }

  /**
   * A provider speaker number is only an identity *within one provider
   * connection of one recording session*. Every ordinal-based update is
   * therefore pinned to (recording session, provider epoch); without both we
   * refuse rather than widen to every segment in the conversation that
   * happens to share the number.
   */
  private scopeToProviderSpeaker(
    query: Knex.QueryBuilder,
    scope: { deepgramSpeakerId: number; recordingSessionId?: string | null; providerEpoch?: number | null },
  ): Knex.QueryBuilder {
    return query
      .andWhere('deepgram_speaker_id', scope.deepgramSpeakerId)
      .andWhere('recording_session_id', scope.recordingSessionId as string)
      .andWhere('provider_epoch', scope.providerEpoch as number);
  }

  private hasProviderScope(scope: { recordingSessionId?: string | null; providerEpoch?: number | null }): boolean {
    return !!scope.recordingSessionId && Number.isInteger(scope.providerEpoch);
  }

  async correctTranscriptSpeaker(input: {
    conversationId: string;
    userId: string;
    deepgramSpeakerId?: number;
    segmentId?: string;
    speakerId: string;
    speakerLabel: string;
    applyTo: 'segment' | 'session_speaker' | 'conversation_speaker';
    recordingSessionId?: string | null;
    providerEpoch?: number | null;
  }): Promise<void> {
    const query = this.whereConversationOwnedBy(
      this.knex('conversation_transcript_segments').where('conversation_id', input.conversationId),
      'conversation_transcript_segments',
      input.userId,
    );

    if (input.applyTo === 'segment') {
      if (!input.segmentId) throw new Error('Correction requires segmentId');
      query.andWhere('id', input.segmentId);
    } else {
      if (input.deepgramSpeakerId == null) throw new Error('Correction requires segmentId or deepgramSpeakerId');
      if (!this.hasProviderScope(input)) {
        throw new Error('Correction by speaker number requires a recording session and provider epoch');
      }
      // Speaker numbers are not identities across recordings or provider
      // reconnects, so both 'session_speaker' and 'conversation_speaker' stay
      // inside the (recording session, provider epoch) the number came from.
      this.scopeToProviderSpeaker(query, { ...input, deepgramSpeakerId: input.deepgramSpeakerId });
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
    userId: string;
    deepgramSpeakerId: number;
    speakerLabel: string;
    applyTo: 'session_speaker' | 'conversation_speaker';
    recordingSessionId?: string | null;
    providerEpoch?: number | null;
  }): Promise<void> {
    if (!this.hasProviderScope(input)) {
      throw new Error('Rename by speaker number requires a recording session and provider epoch');
    }
    const query = this.whereConversationOwnedBy(this.knex('conversation_transcript_segments'), 'conversation_transcript_segments', input.userId)
      .where('conversation_id', input.conversationId)
      // Only anonymous rows: never rename segments already tied to a real identity.
      .whereNull('speaker_id');
    this.scopeToProviderSpeaker(query, input);

    await query.update({
      speaker_label: input.speakerLabel,
      identification_method: 'manual',
      is_corrected: true,
    });
  }

  // ── Gap 6: retroactive segment update after voice ID resolves a speaker ────

  /**
   * Returns the number of segments updated. Only updates rows in the exact
   * (recording session, provider epoch) the identification ran for, and never
   * rows that were manually corrected or are already confirmed as a
   * different identity — a late or stale voice-ID result cannot rewrite them.
   */
  async updateTranscriptSpeakerByDeepgramId(input: {
    conversationId: string;
    userId: string;
    deepgramSpeakerId: number;
    speakerId: string | null;
    speakerLabel: string;
    identificationMethod: 'voice_id' | 'manual' | 'diarization' | 'unknown';
    recordingSessionId?: string | null;
    providerEpoch?: number | null;
  }): Promise<number> {
    if (!this.hasProviderScope(input)) return 0;

    const query = this.whereConversationOwnedBy(this.knex('conversation_transcript_segments'), 'conversation_transcript_segments', input.userId)
      .where('conversation_id', input.conversationId)
      .andWhere('is_corrected', false)
      .andWhere((b) => {
        b.whereNull('speaker_id');
        if (input.speakerId) b.orWhere('speaker_id', input.speakerId);
      });
    this.scopeToProviderSpeaker(query, input);

    return query.update({
      speaker_id: input.speakerId,
      speaker_label: input.speakerLabel,
      identification_method: input.identificationMethod,
    });
  }

  // ── Gap 3: dedicated segment read ─────────────────────────────────────────

  /**
   * The spoken record for the summary transcript: every non-document message of the owner's
   * conversation, oldest first, each with its per-speaker transcript segments attached (who said
   * what, including later guest renames — the message text alone only has the original labels).
   */
  async getMessagesWithSegments(
    conversationId: string,
    userId: string,
  ): Promise<Array<ConversationMessage & { segments: Array<Pick<TranscriptSegment, 'speaker_label' | 'transcript' | 'start_ms'>> }>> {
    await this.assertOwnership(conversationId, userId);
    const [messages, segments] = await Promise.all([
      this.knex('conversation_messages')
        .where('conversation_id', conversationId)
        .whereNull('document_id')
        .orderBy('created_at', 'asc')
        .orderBy('id', 'asc')
        .select('*'),
      this.knex('conversation_transcript_segments')
        .where('conversation_id', conversationId)
        .whereNotNull('message_id')
        .orderByRaw('COALESCE(start_ms, 999999999) ASC, created_at ASC')
        .select('message_id', 'speaker_label', 'transcript', 'start_ms'),
    ]);
    const byMessage = new Map<string, Array<Pick<TranscriptSegment, 'speaker_label' | 'transcript' | 'start_ms'>>>();
    for (const s of segments as Array<TranscriptSegment>) {
      const list = byMessage.get(s.message_id!) ?? [];
      list.push({ speaker_label: s.speaker_label, transcript: s.transcript, start_ms: s.start_ms });
      byMessage.set(s.message_id!, list);
    }
    return (messages as ConversationMessage[]).map((m) => ({ ...m, segments: byMessage.get(m.id) ?? [] }));
  }

  async getTranscriptSegments(
    conversationId: string,
    userId: string,
  ): Promise<TranscriptSegment[]> {
    await this.assertOwnership(conversationId, userId);

    return this.knex('conversation_transcript_segments')
      .where('conversation_id', conversationId)
      .orderByRaw('created_at ASC, COALESCE(start_ms, 999999999) ASC')
      .select('*', this.knex.raw('recording_session_id AS provider_session_epoch'));
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
    await this.assertOwnership(data.conversationId, data.userId);
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

  async listConversationDocuments(conversationId: string, userId: string): Promise<{ id: string; filename: string; mimeType: string; charCount: number; createdAt: Date }[]> {
    return this.whereConversationOwnedBy(this.knex('conversation_documents').where('conversation_id', conversationId), 'conversation_documents', userId)
      .orderBy('created_at', 'asc')
      .select('id', 'filename', 'mime_type as mimeType', 'char_count as charCount', 'created_at as createdAt');
  }

  // ─── Conversation participants (durable speaker identity) ─────────────────

  /**
   * Creates or updates a conversation participant by display_name.
   * Using display_name as the natural key — one record per named speaker per conversation.
   */
  async upsertConversationParticipant(dto: UpsertParticipantDto): Promise<ConversationParticipant> {
    await this.assertOwnership(dto.conversationId, dto.userId);
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
  async getConversationParticipants(conversationId: string, userId: string): Promise<ConversationParticipant[]> {
    return this.whereConversationOwnedBy(this.knex('conversation_participants').where('conversation_id', conversationId), 'conversation_participants', userId)
      .orderBy('created_at', 'asc');
  }

  // ─── Conversation images (Claude Vision) ───────────────────────────────────

  /** Saves an uploaded image for vision injection on every subsequent AI call. */
  async saveConversationImage(dto: SaveConversationImageDto): Promise<ConversationImage> {
    await this.assertOwnership(dto.conversationId, dto.userId);
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
   * The images that have NOT yet been sent to the model (`sent_to_ai = false`), oldest first, capped.
   * Each uploaded image is analysed on the next AI call and then marked sent (see markImagesSentToAi) —
   * it is not re-attached to every later call. Re-sending every earlier image made a new upload get
   * "merged" with the previous ones: the model saw all of them next to a prompt about "the attached file".
   * (Images beyond the cap simply stay pending for the following call.)
   */
  async getPendingImagesForAI(conversationId: string, userId: string, limit = 6): Promise<ConversationImage[]> {
    return this.whereConversationOwnedBy(
      this.knex('conversation_images').where({ conversation_id: conversationId, sent_to_ai: false }),
      'conversation_images',
      userId,
    )
      .orderBy('created_at', 'asc')
      .limit(limit);
  }

  /** File names of images already analysed in this conversation (names only — never re-attached). */
  async getAnalysedImageNames(conversationId: string, userId: string, limit = 20): Promise<string[]> {
    const rows = await this.whereConversationOwnedBy(
      this.knex('conversation_images').where({ conversation_id: conversationId, sent_to_ai: true }),
      'conversation_images',
      userId,
    )
      .orderBy('created_at', 'desc')
      .limit(limit)
      .select('filename');
    return (rows as Array<{ filename: string }>).map((r) => r.filename).reverse();
  }

  /** Marks images as analysed once an AI response that included them has completed. Owner's images only. */
  async markImagesSentToAi(conversationId: string, userId: string, imageIds: string[]): Promise<number> {
    if (imageIds.length === 0) return 0;
    return this.whereConversationOwnedBy(
      this.knex('conversation_images').where('conversation_id', conversationId).whereIn('id', imageIds),
      'conversation_images',
      userId,
    ).update({ sent_to_ai: true });
  }

  /** Lists all images ever attached to a conversation (for display purposes). */
  async listConversationImages(conversationId: string, userId: string): Promise<Pick<ConversationImage, 'id' | 'filename' | 'mime_type' | 'file_url' | 'sent_to_ai' | 'created_at'>[]> {
    return this.whereConversationOwnedBy(this.knex('conversation_images').where('conversation_id', conversationId), 'conversation_images', userId)
      .orderBy('created_at', 'asc')
      .select('id', 'filename', 'mime_type', 'file_url', 'sent_to_ai', 'created_at');
  }
}

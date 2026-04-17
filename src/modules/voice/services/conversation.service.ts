import { Injectable, Logger, NotFoundException, Inject } from '@nestjs/common';
import { Knex } from 'knex';

// ─── Types ────────────────────────────────────────────────────────────────────

export type ConversationMode = 'single' | 'double' | 'multi' | 'dual_speaker';
export type MessageRole = 'user' | 'assistant';

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

    // Update conversation metadata in parallel
    await Promise.all([
      this.knex('conversations').where('id', dto.conversationId).increment('total_messages', 1),
      this.knex('conversations')
        .where('id', dto.conversationId)
        .update({ last_activity_at: new Date(), updated_at: new Date() }),
    ]);

    // Auto-title from first user message
    if (dto.role === 'user') {
      const conv = await this.knex('conversations')
        .where('id', dto.conversationId)
        .whereNull('title')
        .first();

      if (conv && dto.content.length > 0) {
        const autoTitle = dto.content.slice(0, 60) + (dto.content.length > 60 ? '...' : '');
        await this.knex('conversations')
          .where('id', dto.conversationId)
          .update({ title: autoTitle });
      }
    }

    return message;
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

  async getConversation(conversationId: string, userId: string): Promise<Conversation & { messages: ConversationMessage[] }> {
    const conversation = await this.knex('conversations')
      .where({ id: conversationId, user_id: userId })
      .whereNull('deleted_at')
      .first();

    if (!conversation) throw new NotFoundException('Conversation not found');

    const messages = await this.knex('conversation_messages')
      .where('conversation_id', conversationId)
      .orderBy('created_at', 'asc')
      .select('*');

    return { ...conversation, messages };
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

  private async assertOwnership(conversationId: string, userId: string): Promise<void> {
    const conv = await this.knex('conversations')
      .where({ id: conversationId, user_id: userId })
      .whereNull('deleted_at')
      .first();

    if (!conv) throw new NotFoundException('Conversation not found');
  }
}
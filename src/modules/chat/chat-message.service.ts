import { ConflictException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { Knex } from 'knex';
import { ConversationService } from '../voice/services/conversation.service';
import { SubmitMessageDto } from './dto/chat.dto';

export interface SubmitMessageResult {
  status: 'accepted';
  conversationId: string;
  messageId: string;
  clientMessageId: string;
  jobId: string;
  conversationSequence: number;
}

export type JobStatus = 'accepted' | 'processing' | 'completed' | 'failed';

export interface JobStatusResult {
  jobId: string;
  status: JobStatus;
  conversationId: string;
  requestMessageId: string;
  responseMessageId: string | null;
  responseContent: string | null;
  lastErrorMessage: string | null;
}

/**
 * Durable chat command service — the counterpart to voice.gateway.ts's
 * text:send/processPrompt, but decoupled from any live Socket.IO session.
 * Owns: idempotent acceptance, conversation resolution, and atomic
 * message+job persistence. Does NOT run the model itself — see
 * ChatJobWorkerService for that.
 */
@Injectable()
export class ChatMessageService {
  constructor(
    @Inject('KNEX_CONNECTION') private readonly knex: Knex,
    private readonly conversationService: ConversationService,
  ) {}

  async submitMessage(userId: string, dto: SubmitMessageDto): Promise<SubmitMessageResult> {
    let conversationId = dto.conversationId;
    if (conversationId) {
      await this.conversationService.assertOwnership(conversationId, userId);
    } else {
      const conversation = await this.conversationService.createConversation(userId, 'single', dto.fieldId);
      conversationId = conversation.id;
    }

    const existing = await this.knex('conversation_messages')
      .where({ conversation_id: conversationId, client_message_id: dto.clientMessageId })
      .first();

    if (existing) {
      if (existing.content !== dto.text) {
        throw new ConflictException(
          'This clientMessageId was already used with different message content.',
        );
      }

      const job = await this.knex('ai_response_jobs')
        .where('request_message_id', existing.id)
        .first();

      return {
        status: 'accepted',
        conversationId,
        messageId: existing.id,
        clientMessageId: dto.clientMessageId,
        jobId: job.id,
        conversationSequence: existing.conversation_sequence,
      };
    }

    return this.knex.transaction(async (trx) => {
      const message = await this.conversationService.saveMessage(
        {
          conversationId: conversationId!,
          role: 'user',
          content: dto.text,
          clientMessageId: dto.clientMessageId,
          deliverySource: 'text',
        },
        trx,
      );

      const [job] = await trx('ai_response_jobs')
        .insert({
          conversation_id: conversationId,
          request_message_id: message.id,
          status: 'accepted',
        })
        .returning('*');

      return {
        status: 'accepted',
        conversationId: conversationId!,
        messageId: message.id,
        clientMessageId: dto.clientMessageId,
        jobId: job.id,
        conversationSequence: message.conversation_sequence!,
      };
    });
  }

  async getJobStatus(userId: string, jobId: string): Promise<JobStatusResult> {
    const job = await this.knex('ai_response_jobs')
      .join('conversations', 'conversations.id', 'ai_response_jobs.conversation_id')
      .where('ai_response_jobs.id', jobId)
      .andWhere('conversations.user_id', userId)
      .select('ai_response_jobs.*')
      .first();

    if (!job) throw new NotFoundException('Job not found');

    let responseContent: string | null = null;
    if (job.response_message_id) {
      const responseMessage = await this.knex('conversation_messages')
        .where('id', job.response_message_id)
        .first();
      responseContent = responseMessage?.content ?? null;
    }

    return {
      jobId: job.id,
      status: job.status,
      conversationId: job.conversation_id,
      requestMessageId: job.request_message_id,
      responseMessageId: job.response_message_id,
      responseContent,
      lastErrorMessage: job.last_error_message,
    };
  }
}

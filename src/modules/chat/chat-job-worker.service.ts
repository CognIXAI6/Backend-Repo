import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Interval } from '@nestjs/schedule';
import { Knex } from 'knex';
import {
  ClaudeService,
  ConversationImage as ClaudeConversationImage,
} from '../voice/services/claude.service';
import { ConversationService } from '../voice/services/conversation.service';
import { UsersService } from '../users/users.service';
import { FieldsService } from '../fields/fields.service';
import { computeBackoffDelayMs } from '../voice/utils/backoff.util';

const EMPTY_RESPONSE_FALLBACK =
  "- I didn't quite catch that — could you rephrase?\n" +
  '- Try asking something specific about your question.';

/**
 * Minimal polling worker for ai_response_jobs, created for the durable chat
 * command path (POST /chat/messages). Deliberately does not stream tokens —
 * nothing consumes this path in real time yet (no correlated Socket.IO
 * events built for it), so this just runs the model to completion and
 * persists the final response. voice.gateway.ts's processPrompt is
 * untouched and keeps doing its own thing for the live voice/text:send path.
 */
@Injectable()
export class ChatJobWorkerService {
  private readonly logger = new Logger(ChatJobWorkerService.name);
  private isPolling = false;

  constructor(
    @Inject('KNEX_CONNECTION') private readonly knex: Knex,
    private readonly conversationService: ConversationService,
    private readonly claudeService: ClaudeService,
    private readonly usersService: UsersService,
    private readonly fieldsService: FieldsService,
    private readonly configService: ConfigService,
  ) {}

  // @Interval's argument runs at class-decoration time (module load), before
  // DI/ConfigService exist — read the env var directly rather than via
  // ConfigService here. isPolling below guards against overlapping runs if
  // one poll takes longer than the interval.
  @Interval(parseInt(process.env.CHAT_WORKER_POLL_INTERVAL_MS || '2000', 10))
  async pollAndProcessJobs(): Promise<void> {
    if (this.isPolling) return;
    this.isPolling = true;
    try {
      const batchSize = this.configService.get<number>('chat.batchSize') ?? 5;
      const leaseDurationMs = this.configService.get<number>('chat.leaseDurationMs') ?? 30_000;

      const claimedIds = await this.knex.transaction(async (trx) => {
        const rows = await trx('ai_response_jobs')
          .where('status', 'accepted')
          .orWhere((qb) => qb.where('status', 'processing').andWhere('lease_expires_at', '<', new Date()))
          .orderBy('available_at', 'asc')
          .limit(batchSize)
          .forUpdate()
          .skipLocked()
          .select('id');

        const ids = rows.map((r: { id: string }) => r.id);
        if (ids.length === 0) return [];

        await trx('ai_response_jobs')
          .whereIn('id', ids)
          .update({
            status: 'processing',
            started_at: trx.raw('COALESCE(started_at, now())'),
            lease_expires_at: new Date(Date.now() + leaseDurationMs),
            attempt_count: trx.raw('attempt_count + 1'),
            updated_at: new Date(),
          });

        return ids;
      });

      for (const jobId of claimedIds) {
        await this.processJob(jobId);
      }
    } catch (err) {
      this.logger.error(`Poll tick failed: ${(err as Error).message}`, (err as Error).stack);
    } finally {
      this.isPolling = false;
    }
  }

  private async processJob(jobId: string): Promise<void> {
    const job = await this.knex('ai_response_jobs').where('id', jobId).first();
    if (!job) return;

    try {
      const requestMessage = await this.knex('conversation_messages').where('id', job.request_message_id).first();
      const conversation = await this.knex('conversations').where('id', job.conversation_id).first();
      if (!requestMessage || !conversation) {
        throw new Error('Request message or conversation no longer exists');
      }

      const userId: string = conversation.user_id;

      const [user, field, history, documentContext, images] = await Promise.all([
        this.usersService.findById(userId),
        conversation.field_id ? this.fieldsService.findById(conversation.field_id) : Promise.resolve(null),
        this.conversationService.getRecentHistoryForAI(job.conversation_id, 40),
        this.conversationService.getFullDocumentContext(job.conversation_id, userId).catch(() => null),
        this.conversationService.getConversationImagesForAI(job.conversation_id).catch(() => []),
      ]);

      const visionImages: ClaudeConversationImage[] = images.map((img) => ({
        mimeType: img.mime_type as ClaudeConversationImage['mimeType'],
        imageBase64: img.image_base64,
        filename: img.filename,
      }));

      const systemPrompt = this.claudeService.buildSystemPrompt(
        field?.name,
        user?.ai_memory ?? undefined,
        documentContext,
      );

      const startedAt = Date.now();
      // No socket to stream tokens to on this path — onToken is a no-op;
      // onDone's fullText is the complete, authoritative response.
      const { text: responseText, inputTokens, outputTokens } = await new Promise<{
        text: string;
        inputTokens: number;
        outputTokens: number;
      }>((resolve, reject) => {
        this.claudeService
          .streamResponse(
            requestMessage.content,
            history,
            systemPrompt,
            {
              onToken: () => {},
              onDone: (fullText, inTok, outTok) => {
                resolve({ text: fullText.trim() ? fullText : EMPTY_RESPONSE_FALLBACK, inputTokens: inTok, outputTokens: outTok });
              },
              onError: (err) => reject(err),
            },
            { enableWebSearch: false, enableDocumentGeneration: false, images: visionImages },
          )
          .catch(reject);
      });

      const responseMessage = await this.conversationService.saveMessage({
        conversationId: job.conversation_id,
        role: 'assistant',
        content: responseText,
        tokensUsed: inputTokens + outputTokens,
        latencyMs: Date.now() - startedAt,
        deliverySource: 'text',
      });

      await this.knex('ai_response_jobs')
        .where('id', jobId)
        .update({
          status: 'completed',
          completed_at: new Date(),
          response_message_id: responseMessage.id,
          updated_at: new Date(),
        });
    } catch (err) {
      await this.handleJobFailure(job, err as Error);
    }
  }

  private async handleJobFailure(job: { id: string; attempt_count: number }, err: Error): Promise<void> {
    const maxAttempts = this.configService.get<number>('chat.maxAttempts') ?? 3;
    this.logger.warn(`Job ${job.id} attempt ${job.attempt_count} failed: ${err.message}`);

    // Never persist a raw stack trace or provider error body — same
    // discipline as GlobalExceptionFilter's DB-error sanitization.
    const sanitizedMessage = err.message.slice(0, 500);

    if (job.attempt_count < maxAttempts) {
      const delayMs = computeBackoffDelayMs(job.attempt_count);
      await this.knex('ai_response_jobs')
        .where('id', job.id)
        .update({
          status: 'accepted',
          available_at: new Date(Date.now() + delayMs),
          last_error_category: err.name,
          last_error_message: sanitizedMessage,
          updated_at: new Date(),
        });
    } else {
      await this.knex('ai_response_jobs')
        .where('id', job.id)
        .update({
          status: 'failed',
          completed_at: new Date(),
          last_error_category: err.name,
          last_error_message: sanitizedMessage,
          updated_at: new Date(),
        });
    }
  }
}

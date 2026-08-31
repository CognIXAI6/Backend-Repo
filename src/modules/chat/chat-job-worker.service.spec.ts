import { ChatJobWorkerService } from './chat-job-worker.service';

function createFakeKnex(overrides: { job?: any; requestMessage?: any; conversation?: any }) {
  const aiJobsChain: any = {
    where: jest.fn().mockReturnThis(),
    first: jest.fn().mockResolvedValue(overrides.job),
    update: jest.fn().mockResolvedValue(1),
  };
  const messagesChain: any = {
    where: jest.fn().mockReturnThis(),
    first: jest.fn().mockResolvedValue(overrides.requestMessage),
  };
  const conversationsChain: any = {
    where: jest.fn().mockReturnThis(),
    first: jest.fn().mockResolvedValue(overrides.conversation),
  };
  const knexLike: any = jest.fn((table: string) => {
    if (table === 'ai_response_jobs') return aiJobsChain;
    if (table === 'conversation_messages') return messagesChain;
    if (table === 'conversations') return conversationsChain;
    throw new Error(`unexpected table: ${table}`);
  });
  return { knexLike, aiJobsChain, messagesChain, conversationsChain };
}

function createFakeConversationService() {
  return {
    getRecentHistoryForAI: jest.fn().mockResolvedValue([]),
    getFullDocumentContext: jest.fn().mockResolvedValue(null),
    getConversationImagesForAI: jest.fn().mockResolvedValue([]),
    saveMessage: jest.fn().mockResolvedValue({ id: 'resp-msg-1' }),
  } as any;
}

function createFakeAncillaryServices() {
  return {
    usersService: { findById: jest.fn().mockResolvedValue({ ai_memory: 'some memory' }) } as any,
    fieldsService: { findById: jest.fn().mockResolvedValue({ name: 'General Knowledge' }) } as any,
    configService: { get: jest.fn((key: string) => (key === 'chat.maxAttempts' ? 3 : undefined)) } as any,
  };
}

const baseJob = { id: 'job-1', conversation_id: 'conv-1', request_message_id: 'msg-1', attempt_count: 1 };
const baseRequestMessage = { id: 'msg-1', content: 'What is the capital of France?' };
const baseConversation = { id: 'conv-1', user_id: 'user-1', field_id: null };

describe('ChatJobWorkerService.processJob', () => {
  it('persists the assistant response and marks the job completed on success', async () => {
    const { knexLike, aiJobsChain } = createFakeKnex({
      job: baseJob,
      requestMessage: baseRequestMessage,
      conversation: baseConversation,
    });
    const conversationService = createFakeConversationService();
    const claudeService: any = {
      buildSystemPrompt: jest.fn().mockReturnValue('system prompt'),
      streamResponse: jest.fn((_msg: string, _hist: unknown, _sys: string, callbacks: any) => {
        callbacks.onDone('Paris.', 10, 20);
        return Promise.resolve();
      }),
    };
    const { usersService, fieldsService, configService } = createFakeAncillaryServices();

    const worker = new ChatJobWorkerService(knexLike, conversationService, claudeService, usersService, fieldsService, configService);
    await (worker as any).processJob('job-1');

    expect(conversationService.saveMessage).toHaveBeenCalledWith(
      expect.objectContaining({ conversationId: 'conv-1', role: 'assistant', content: 'Paris.', tokensUsed: 30 }),
    );
    expect(aiJobsChain.update).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'completed', response_message_id: 'resp-msg-1' }),
    );
  });

  it('resets the job to accepted with a future available_at when under maxAttempts', async () => {
    const { knexLike, aiJobsChain } = createFakeKnex({
      job: { ...baseJob, attempt_count: 1 },
      requestMessage: baseRequestMessage,
      conversation: baseConversation,
    });
    const conversationService = createFakeConversationService();
    const claudeService: any = {
      buildSystemPrompt: jest.fn().mockReturnValue('system prompt'),
      streamResponse: jest.fn((_msg: string, _hist: unknown, _sys: string, callbacks: any) => {
        callbacks.onError(new Error('model provider timed out'));
        return Promise.resolve();
      }),
    };
    const { usersService, fieldsService, configService } = createFakeAncillaryServices();

    const worker = new ChatJobWorkerService(knexLike, conversationService, claudeService, usersService, fieldsService, configService);
    await (worker as any).processJob('job-1');

    expect(conversationService.saveMessage).not.toHaveBeenCalled();
    const updateCall = aiJobsChain.update.mock.calls[0][0];
    expect(updateCall.status).toBe('accepted');
    expect(updateCall.available_at.getTime()).toBeGreaterThan(Date.now());
    expect(updateCall.last_error_message).toContain('model provider timed out');
  });

  it('marks the job permanently failed once maxAttempts is reached, with a sanitized error', async () => {
    const { knexLike, aiJobsChain } = createFakeKnex({
      job: { ...baseJob, attempt_count: 3 },
      requestMessage: baseRequestMessage,
      conversation: baseConversation,
    });
    const conversationService = createFakeConversationService();
    const claudeService: any = {
      buildSystemPrompt: jest.fn().mockReturnValue('system prompt'),
      streamResponse: jest.fn((_msg: string, _hist: unknown, _sys: string, callbacks: any) => {
        callbacks.onError(new Error('select * from users - relation does not exist'));
        return Promise.resolve();
      }),
    };
    const { usersService, fieldsService, configService } = createFakeAncillaryServices();

    const worker = new ChatJobWorkerService(knexLike, conversationService, claudeService, usersService, fieldsService, configService);
    await (worker as any).processJob('job-1');

    expect(aiJobsChain.update).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'failed' }),
    );
  });
});

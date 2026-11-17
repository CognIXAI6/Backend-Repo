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
    fieldsService: { findFieldRecordForUser: jest.fn().mockResolvedValue({ id: 'f1', name: 'General Knowledge', isCustom: false }) } as any,
    settingsService: { getEffectiveLanguage: jest.fn().mockResolvedValue('en') } as any,
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
    const { usersService, fieldsService, settingsService, configService } = createFakeAncillaryServices();

    const worker = new ChatJobWorkerService(knexLike, conversationService, claudeService, usersService, fieldsService, settingsService, configService);
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
    const { usersService, fieldsService, settingsService, configService } = createFakeAncillaryServices();

    const worker = new ChatJobWorkerService(knexLike, conversationService, claudeService, usersService, fieldsService, settingsService, configService);
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
    const { usersService, fieldsService, settingsService, configService } = createFakeAncillaryServices();

    const worker = new ChatJobWorkerService(knexLike, conversationService, claudeService, usersService, fieldsService, settingsService, configService);
    await (worker as any).processJob('job-1');

    expect(aiJobsChain.update).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'failed' }),
    );
  });
});


describe('ChatJobWorkerService.processJob — conversation field context', () => {
  const run = async (conversation: Record<string, unknown>, fieldRecord: { id: string; name: string; isCustom: boolean } | null) => {
    const { knexLike } = createFakeKnex({ job: baseJob, requestMessage: baseRequestMessage, conversation });
    const conversationService = createFakeConversationService();
    const claudeService: any = {
      buildSystemPrompt: jest.fn().mockReturnValue('system prompt'),
      streamResponse: jest.fn((_m: string, _h: unknown, _s: string, cb: any) => { cb.onDone('ok', 1, 1); return Promise.resolve(); }),
    };
    const { usersService, fieldsService, settingsService, configService } = createFakeAncillaryServices();
    fieldsService.findFieldRecordForUser.mockResolvedValue(fieldRecord);
    const worker = new ChatJobWorkerService(knexLike, conversationService, claudeService, usersService, fieldsService, settingsService, configService);
    await (worker as any).processJob('job-1');
    return { claudeService, fieldsService };
  };

  it("a custom-field conversation keeps its field in the queued response — resolved for the conversation's OWNER, like live voice", async () => {
    const { claudeService, fieldsService } = await run({ ...baseConversation, field_id: 'custom-field-1' }, { id: 'custom-field-1', name: 'My Practice', isCustom: true });
    expect(fieldsService.findFieldRecordForUser).toHaveBeenCalledWith('user-1', 'custom-field-1');
    expect(claudeService.buildSystemPrompt.mock.calls[0][0]).toBe('My Practice');
  });

  it('a built-in field still works', async () => {
    const { claudeService } = await run({ ...baseConversation, field_id: 'f-law' }, { id: 'f-law', name: 'Law', isCustom: false });
    expect(claudeService.buildSystemPrompt.mock.calls[0][0]).toBe('Law');
  });

  it("a field that is not resolvable for the owner (someone else's custom field, deleted) contributes no field context", async () => {
    const { claudeService } = await run({ ...baseConversation, field_id: 'foreign-custom' }, null);
    expect(claudeService.buildSystemPrompt.mock.calls[0][0]).toBeUndefined();
  });

  it('no field on the conversation → no lookup at all', async () => {
    const { claudeService, fieldsService } = await run({ ...baseConversation, field_id: null }, null);
    expect(fieldsService.findFieldRecordForUser).not.toHaveBeenCalled();
    expect(claudeService.buildSystemPrompt.mock.calls[0][0]).toBeUndefined();
  });
});

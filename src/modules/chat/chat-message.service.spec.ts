import { ConflictException } from '@nestjs/common';
import { ChatMessageService } from './chat-message.service';

function createFakeConversationService(overrides: Record<string, unknown> = {}) {
  return {
    assertOwnership: jest.fn().mockResolvedValue(undefined),
    createConversation: jest.fn(),
    saveMessage: jest.fn(),
    ...overrides,
  } as any;
}

describe('ChatMessageService.submitMessage', () => {
  it('persists a new message + job atomically and returns the acceptance result', async () => {
    const conversationMessagesChain: any = {
      where: jest.fn().mockReturnThis(),
      first: jest.fn().mockResolvedValue(undefined), // no existing row for this clientMessageId
    };
    const jobInsertChain: any = {
      insert: jest.fn().mockReturnThis(),
      returning: jest.fn().mockResolvedValue([{ id: 'job-1', conversation_id: 'conv-1', request_message_id: 'msg-1' }]),
    };

    const trx: any = jest.fn((table: string) => {
      if (table === 'ai_response_jobs') return jobInsertChain;
      throw new Error(`unexpected table in trx: ${table}`);
    });

    const knexLike: any = jest.fn((table: string) => {
      if (table === 'conversation_messages') return conversationMessagesChain;
      throw new Error(`unexpected table: ${table}`);
    });
    knexLike.transaction = jest.fn(async (cb: (trx: any) => Promise<any>) => cb(trx));

    const conversationService = createFakeConversationService({
      saveMessage: jest.fn().mockResolvedValue({
        id: 'msg-1',
        conversation_id: 'conv-1',
        conversation_sequence: 7,
      }),
    });

    const service = new ChatMessageService(knexLike, conversationService);
    const result = await service.submitMessage('user-1', {
      clientMessageId: 'client-msg-1',
      conversationId: 'conv-1',
      text: 'hello',
    });

    expect(conversationService.assertOwnership).toHaveBeenCalledWith('conv-1', 'user-1');
    expect(conversationService.saveMessage).toHaveBeenCalledWith(
      expect.objectContaining({ conversationId: 'conv-1', clientMessageId: 'client-msg-1', deliverySource: 'text' }),
      trx,
    );
    expect(jobInsertChain.insert).toHaveBeenCalledWith(
      expect.objectContaining({ conversation_id: 'conv-1', request_message_id: 'msg-1', status: 'accepted' }),
    );
    expect(result).toEqual({
      status: 'accepted',
      conversationId: 'conv-1',
      messageId: 'msg-1',
      clientMessageId: 'client-msg-1',
      jobId: 'job-1',
      conversationSequence: 7,
    });
  });

  it('replays the original result for a retried clientMessageId with identical content — no new insert', async () => {
    const existingRow = { id: 'msg-1', content: 'hello', conversation_sequence: 7 };
    const conversationMessagesChain: any = {
      where: jest.fn().mockReturnThis(),
      first: jest.fn().mockResolvedValue(existingRow),
    };
    const jobLookupChain: any = {
      where: jest.fn().mockReturnThis(),
      first: jest.fn().mockResolvedValue({ id: 'job-1' }),
    };

    const knexLike: any = jest.fn((table: string) => {
      if (table === 'conversation_messages') return conversationMessagesChain;
      if (table === 'ai_response_jobs') return jobLookupChain;
      throw new Error(`unexpected table: ${table}`);
    });
    knexLike.transaction = jest.fn();

    const conversationService = createFakeConversationService();
    const service = new ChatMessageService(knexLike, conversationService);

    const result = await service.submitMessage('user-1', {
      clientMessageId: 'client-msg-1',
      conversationId: 'conv-1',
      text: 'hello',
    });

    expect(knexLike.transaction).not.toHaveBeenCalled();
    expect(conversationService.saveMessage).not.toHaveBeenCalled();
    expect(result).toEqual({
      status: 'accepted',
      conversationId: 'conv-1',
      messageId: 'msg-1',
      clientMessageId: 'client-msg-1',
      jobId: 'job-1',
      conversationSequence: 7,
    });
  });

  it('throws 409 when the same clientMessageId is retried with different content', async () => {
    const conversationMessagesChain: any = {
      where: jest.fn().mockReturnThis(),
      first: jest.fn().mockResolvedValue({ id: 'msg-1', content: 'original text', conversation_sequence: 7 }),
    };
    const knexLike: any = jest.fn((table: string) => {
      if (table === 'conversation_messages') return conversationMessagesChain;
      throw new Error(`unexpected table: ${table}`);
    });
    knexLike.transaction = jest.fn();

    const conversationService = createFakeConversationService();
    const service = new ChatMessageService(knexLike, conversationService);

    await expect(
      service.submitMessage('user-1', {
        clientMessageId: 'client-msg-1',
        conversationId: 'conv-1',
        text: 'a completely different message',
      }),
    ).rejects.toThrow(ConflictException);

    expect(knexLike.transaction).not.toHaveBeenCalled();
  });
});

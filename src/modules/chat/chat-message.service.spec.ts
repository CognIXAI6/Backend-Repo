import { ConflictException, NotFoundException } from '@nestjs/common';
import { ChatMessageService } from './chat-message.service';

function createFakeConversationService(overrides: Record<string, unknown> = {}) {
  return {
    assertOwnership: jest.fn().mockResolvedValue(undefined),
    createConversation: jest.fn(),
    saveMessage: jest.fn(),
    ...overrides,
  } as any;
}

const fieldsStub = { resolveAuthorizedField: jest.fn().mockResolvedValue(null), getUserPrimaryField: jest.fn().mockResolvedValue(null) };

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

    const entitlementsService: any = {
      getUserEntitlements: jest.fn().mockResolvedValue({ tier: 'free', entitlements: { maxMessagesPerMonth: null } }),
    };
    const usageService: any = {
      tryConsume: jest.fn().mockResolvedValue({ canUse: true, used: 1, limit: null, remaining: null }),
    };

    const service = new ChatMessageService(knexLike, conversationService, entitlementsService, usageService, fieldsStub as any);
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
    const service = new ChatMessageService(knexLike, conversationService, {} as any, {} as any, fieldsStub as any);

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
    const service = new ChatMessageService(knexLike, conversationService, {} as any, {} as any, fieldsStub as any);

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


describe('ChatMessageService.submitMessage — ownership and field authority', () => {
  const CONV = '11111111-1111-1111-1111-111111111111';
  const MSG = '22222222-2222-2222-2222-222222222222';

  const build = (opts: { owned?: boolean; authorized?: { id: string } | null; primary?: any } = {}) => {
    const knexCalls: string[] = [];
    const chain: any = { where: jest.fn().mockReturnThis(), first: jest.fn().mockResolvedValue(undefined) };
    const knexLike: any = jest.fn((table: string) => { knexCalls.push(table); return chain; });
    const jobChain: any = { insert: jest.fn().mockReturnThis(), returning: jest.fn().mockResolvedValue([{ id: 'job-1' }]) };
    const trx: any = jest.fn(() => jobChain);
    knexLike.transaction = jest.fn(async (cb: (t: any) => Promise<any>) => cb(trx));
    const conversationService: any = {
      assertOwnership: jest.fn(async () => { if (opts.owned === false) throw new NotFoundException('Conversation not found'); }),
      createConversation: jest.fn().mockResolvedValue({ id: 'new-conv' }),
      saveMessage: jest.fn().mockResolvedValue({ id: 'm1', conversation_sequence: 1 }),
    };
    const usageService: any = { tryConsume: jest.fn().mockResolvedValue({ canUse: true, limit: 100 }) };
    const entitlementsService: any = { getUserEntitlements: jest.fn().mockResolvedValue({ entitlements: { maxMessagesPerMonth: 100 } }) };
    const fields: any = {
      resolveAuthorizedField: jest.fn().mockResolvedValue(opts.authorized ?? null),
      getUserPrimaryField: jest.fn().mockResolvedValue(opts.primary ?? null),
    };
    const service = new ChatMessageService(knexLike, conversationService, entitlementsService, usageService, fields);
    return { service, knexCalls, conversationService, usageService, entitlementsService, fields };
  };

  it('a conversation the caller does not own is rejected BEFORE any lookup or quota accounting', async () => {
    const { service, knexCalls, usageService, entitlementsService } = build({ owned: false });
    await expect(service.submitMessage('attacker', { clientMessageId: MSG, conversationId: CONV, text: 'hi' } as any)).rejects.toBeInstanceOf(NotFoundException);
    expect(knexCalls).toEqual([]); // no clientMessageId probe against someone else's conversation
    expect(entitlementsService.getUserEntitlements).not.toHaveBeenCalled();
    expect(usageService.tryConsume).not.toHaveBeenCalled();
  });

  it('writes the message with the caller as owner', async () => {
    const { service, conversationService } = build();
    await service.submitMessage('user-1', { clientMessageId: MSG, conversationId: CONV, text: 'hi' } as any);
    expect(conversationService.assertOwnership).toHaveBeenCalledWith(CONV, 'user-1');
    expect(conversationService.saveMessage).toHaveBeenCalledWith(expect.objectContaining({ conversationId: CONV, userId: 'user-1' }), expect.anything());
  });

  it("a new conversation never takes someone else's field id: it falls back to the account's primary field", async () => {
    const { service, conversationService, fields } = build({ authorized: null, primary: { field_id: 'f-primary', name: 'Healthcare' } });
    await service.submitMessage('user-1', { clientMessageId: MSG, text: 'hi', fieldId: 'f-someone-elses' } as any);
    expect(fields.resolveAuthorizedField).toHaveBeenCalledWith('user-1', 'f-someone-elses');
    expect(conversationService.createConversation).toHaveBeenCalledWith('user-1', 'single', 'f-primary');
  });

  it('an authorized field id is used as given; with no usable field the conversation has none', async () => {
    const authorized = build({ authorized: { id: 'f-law' }, primary: { field_id: 'f-primary' } });
    await authorized.service.submitMessage('user-1', { clientMessageId: MSG, text: 'hi', fieldId: 'f-law' } as any);
    expect(authorized.conversationService.createConversation).toHaveBeenCalledWith('user-1', 'single', 'f-law');

    const none = build({ authorized: null, primary: null });
    await none.service.submitMessage('user-1', { clientMessageId: MSG, text: 'hi', fieldId: 'f-bogus' } as any);
    expect(none.conversationService.createConversation).toHaveBeenCalledWith('user-1', 'single', undefined);
  });
});

import { ROUTE_ARGS_METADATA } from '@nestjs/common/constants';
import { RouteParamtypes } from '@nestjs/common/enums/route-paramtypes.enum';
import { ParseUUIDPipe } from '@nestjs/common';
import { ConversationsController } from '../conversations/conversations.controller';

describe('ConversationsController :id parameters', () => {
  it('every route that takes a conversation id validates it as a UUID (a malformed id is a 400, not a database error)', () => {
    const proto = ConversationsController.prototype as any;
    const routes = Object.getOwnPropertyNames(proto).filter((n) => n !== 'constructor' && typeof proto[n] === 'function');
    const withId: string[] = [];
    const unvalidated: string[] = [];
    for (const name of routes) {
      const meta = Reflect.getMetadata(ROUTE_ARGS_METADATA, ConversationsController, name) ?? {};
      for (const [key, arg] of Object.entries<any>(meta)) {
        // '5:<index>' is Nest's @Param(); custom decorators such as @CurrentUser('id') use a different key
        if (key.startsWith(`${RouteParamtypes.PARAM}:`) && arg.data === 'id') {
          withId.push(name);
          if (!(arg.pipes ?? []).some((p: any) => p === ParseUUIDPipe || p instanceof ParseUUIDPipe)) unvalidated.push(name);
        }
      }
    }
    expect(withId.length).toBeGreaterThanOrEqual(8);
    expect(unvalidated).toEqual([]);
  });
});

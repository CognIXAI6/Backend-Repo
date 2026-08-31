import { ConfigService } from '@nestjs/config';
import { ConversationService } from './conversation.service';

const PROTECTED_TABLES = [
  'conversation_messages',
  'conversation_transcript_segments',
  'conversation_participants',
  'conversation_images',
  'conversation_documents',
  'resource_conversations',
  'generated_documents',
];

function createFakeQueryBuilder() {
  const qb: any = {};
  ['where', 'whereNull', 'andWhere', 'whereNotExists', 'whereIn', 'select', 'limit', 'forUpdate', 'skipLocked', 'whereRaw']
    .forEach((method) => {
      qb[method] = jest.fn(() => qb);
    });
  qb.delete = jest.fn().mockResolvedValue(3);
  return qb;
}

function createFakeConfigService(values: Record<string, unknown> = {}) {
  return { get: jest.fn((key: string) => values[key]) } as unknown as ConfigService;
}

describe('ConversationService.buildCleanupCandidatesQuery', () => {
  it('applies the pre-filter, age cutoff, and a NOT EXISTS check for every protected table', () => {
    const knexLike: any = jest.fn(() => createFakeQueryBuilder());
    knexLike.raw = jest.fn((sql: string) => sql);

    const service = new ConversationService({} as any, createFakeConfigService());
    const result = service.buildCleanupCandidatesQuery(knexLike, { userId: 'user-1', olderThanHours: 24 });

    expect(knexLike).toHaveBeenCalledWith('conversations');
    const outerBuilder = knexLike.mock.results[0].value;

    expect(outerBuilder.where).toHaveBeenCalledWith('total_messages', 0);
    expect(outerBuilder.whereNull).toHaveBeenCalledWith('deleted_at');
    expect(outerBuilder.andWhere).toHaveBeenCalledWith('user_id', 'user-1');
    expect(outerBuilder.whereNotExists).toHaveBeenCalledTimes(PROTECTED_TABLES.length);

    for (const table of PROTECTED_TABLES) {
      expect(knexLike).toHaveBeenCalledWith(table);
    }
    expect(result).toBe(outerBuilder);
  });

  it('omits the user filter when no userId is given (the scheduled job runs system-wide)', () => {
    const knexLike: any = jest.fn(() => createFakeQueryBuilder());
    knexLike.raw = jest.fn((sql: string) => sql);

    const service = new ConversationService({} as any, createFakeConfigService());
    const result = service.buildCleanupCandidatesQuery(knexLike, { olderThanHours: 24 });

    expect(result.andWhere).not.toHaveBeenCalled();
  });
});

describe('ConversationService.purgeEmptyConversations', () => {
  it('reads the grace period from config and scopes the query to the given user', async () => {
    const knexLike: any = jest.fn(() => createFakeQueryBuilder());
    knexLike.raw = jest.fn((sql: string) => sql);

    const service = new ConversationService(knexLike, createFakeConfigService({ 'cleanup.gracePeriodHours': 48 }));
    const deleted = await service.purgeEmptyConversations('user-1');

    const outerBuilder = knexLike.mock.results[0].value;
    expect(outerBuilder.andWhere).toHaveBeenCalledWith('user_id', 'user-1');
    expect(outerBuilder.delete).toHaveBeenCalled();
    expect(deleted).toBe(3);
  });
});

describe('ConversationService.saveMessage', () => {
  function createFakeTransaction(opts: { conversationsUpdateError?: Error } = {}) {
    const chainsByTable: Record<string, any> = {};
    const trx: any = jest.fn((table: string) => {
      const chain: any = {
        insert: jest.fn(() => chain),
        where: jest.fn(() => chain),
        update: jest.fn(() => chain),
        returning:
          table === 'conversations'
            ? opts.conversationsUpdateError
              ? jest.fn().mockRejectedValue(opts.conversationsUpdateError)
              : jest.fn().mockResolvedValue([{ next_message_sequence: 7 }])
            : jest.fn().mockResolvedValue([{ id: 'msg-1', conversation_id: 'conv-1' }]),
      };
      chainsByTable[table] = chain;
      return chain;
    });
    trx.raw = jest.fn((sql: string) => sql);
    return { trx, chainsByTable };
  }

  it('inserts the message and bumps total_messages/sequence inside a single transaction', async () => {
    const { trx, chainsByTable } = createFakeTransaction();
    const knexLike: any = {
      transaction: jest.fn(async (cb: (trx: any) => Promise<any>) => cb(trx)),
    };

    const service = new ConversationService(knexLike, createFakeConfigService());
    const message = await service.saveMessage({
      conversationId: 'conv-1',
      role: 'user',
      content: 'hello',
    });

    expect(knexLike.transaction).toHaveBeenCalledTimes(1);
    expect(chainsByTable['conversation_messages'].insert).toHaveBeenCalledWith(
      expect.objectContaining({ conversation_sequence: 7 }),
    );
    expect(chainsByTable['conversations'].update).toHaveBeenCalled();
    expect(message).toEqual({ id: 'msg-1', conversation_id: 'conv-1' });
  });

  it('propagates a failure from the counter update through the transaction — callers cannot observe a half-committed save', async () => {
    const { trx } = createFakeTransaction({ conversationsUpdateError: new Error('counter update failed') });
    const knexLike: any = {
      transaction: jest.fn(async (cb: (trx: any) => Promise<any>) => cb(trx)),
    };

    const service = new ConversationService(knexLike, createFakeConfigService());

    await expect(
      service.saveMessage({ conversationId: 'conv-1', role: 'user', content: 'hello' }),
    ).rejects.toThrow('counter update failed');
  });
});

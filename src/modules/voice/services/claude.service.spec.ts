import { ConfigService } from '@nestjs/config';
import { ClaudeService } from './claude.service';

function createFakeStream(events: unknown[], finalMessage: unknown) {
  return {
    [Symbol.asyncIterator]: async function* () {
      for (const event of events) yield event;
    },
    finalMessage: jest.fn().mockResolvedValue(finalMessage),
  };
}

function createService() {
  const configService = { get: jest.fn() } as unknown as ConfigService;
  return new ClaudeService(configService);
}

describe('ClaudeService.stripToolCallArtifacts', () => {
  it('removes a leaked <tool_call>/<tool_response> narration, keeping the real answer', () => {
    const service = createService() as any;
    const text =
      'Let me search for that.\n\n' +
      '<tool_call>{"name": "web_search", "arguments": {"query": "latest news"}}</tool_call>\n' +
      '<tool_response>No web search results found. The search returned empty.</tool_response>\n\n' +
      '- The capital of France is Paris.';

    const result = service.stripToolCallArtifacts(text);

    expect(result).not.toContain('<tool_call>');
    expect(result).not.toContain('<tool_response>');
    expect(result).toContain('The capital of France is Paris.');
  });

  it('leaves ordinary text with no tool-call artifacts unchanged', () => {
    const service = createService() as any;
    const text = '- The capital of France is Paris.\n- It is on the Seine.';

    expect(service.stripToolCallArtifacts(text)).toBe(text);
  });
});

describe('ClaudeService.streamResponse — empty web search results', () => {
  it('never sends an empty-string tool_result when Tavily returns zero results', async () => {
    const service = createService() as any;

    const firstStreamEvents = [
      { type: 'message_start', message: { usage: { input_tokens: 10 } } },
      { type: 'content_block_start', content_block: { type: 'tool_use', id: 'tool-1', name: 'web_search' } },
      { type: 'content_block_delta', delta: { type: 'input_json_delta', partial_json: '{"query":"latest news in Nigeria"}' } },
      { type: 'message_delta', usage: { output_tokens: 5 } },
    ];
    const firstFinalMessage = {
      stop_reason: 'tool_use',
      content: [{ type: 'tool_use', id: 'tool-1', name: 'web_search', input: { query: 'latest news in Nigeria' } }],
    };

    const followUpEvents = [
      { type: 'content_block_delta', delta: { type: 'text_delta', text: '- No live results, answering from training knowledge.' } },
      { type: 'message_delta', usage: { output_tokens: 3 } },
    ];

    const streamMock = jest
      .fn()
      .mockReturnValueOnce(createFakeStream(firstStreamEvents, firstFinalMessage))
      .mockReturnValueOnce(createFakeStream(followUpEvents, {}));

    service.client = { messages: { stream: streamMock } };
    service.tavilyClient = { search: jest.fn().mockResolvedValue({ results: [] }) };
    service.model = 'test-model';

    const callbacks = { onToken: jest.fn(), onDone: jest.fn(), onError: jest.fn() };
    await service.streamResponse('latest news in Nigeria', [], 'system prompt', callbacks, { enableWebSearch: true });

    expect(callbacks.onError).not.toHaveBeenCalled();
    expect(streamMock).toHaveBeenCalledTimes(2);

    const followUpCallArgs = streamMock.mock.calls[1][0];
    const toolResultMessage = followUpCallArgs.messages.find(
      (m: any) => m.role === 'user' && Array.isArray(m.content),
    );
    const toolResultBlock = toolResultMessage.content[0];

    expect(toolResultBlock.content).not.toBe('');
    expect(toolResultBlock.content).toContain('No web search results were found');
  });
});

describe('ClaudeService.streamResponse — blocked web search', () => {
  function streamWithOneWebSearchCall() {
    const firstStreamEvents = [
      { type: 'message_start', message: { usage: { input_tokens: 10 } } },
      { type: 'content_block_start', content_block: { type: 'tool_use', id: 'tool-1', name: 'web_search' } },
      { type: 'content_block_delta', delta: { type: 'input_json_delta', partial_json: '{"query":"today\'s exchange rate"}' } },
      { type: 'message_delta', usage: { output_tokens: 5 } },
    ];
    const firstFinalMessage = {
      stop_reason: 'tool_use',
      content: [{ type: 'tool_use', id: 'tool-1', name: 'web_search', input: { query: "today's exchange rate" } }],
    };
    const followUpEvents = [
      { type: 'content_block_delta', delta: { type: 'text_delta', text: '- Answering from training knowledge.' } },
      { type: 'message_delta', usage: { output_tokens: 3 } },
    ];
    return jest
      .fn()
      .mockReturnValueOnce(createFakeStream(firstStreamEvents, firstFinalMessage))
      .mockReturnValueOnce(createFakeStream(followUpEvents, {}));
  }

  it('intercepts an actual tool-use call instead of hitting Tavily, and fires onWebSearchBlocked once', async () => {
    const service = createService() as any;
    const streamMock = streamWithOneWebSearchCall();
    const tavilySearch = jest.fn();

    service.client = { messages: { stream: streamMock } };
    service.tavilyClient = { search: tavilySearch };
    service.model = 'test-model';

    const onWebSearchBlocked = jest.fn();
    const callbacks = { onToken: jest.fn(), onDone: jest.fn(), onError: jest.fn(), onWebSearchBlocked };

    await service.streamResponse("what's today's exchange rate", [], 'system prompt', callbacks, {
      enableWebSearch: true,
      webSearchBlockReason: 'quota_exhausted',
    });

    expect(tavilySearch).not.toHaveBeenCalled();
    expect(onWebSearchBlocked).toHaveBeenCalledTimes(1);
    expect(onWebSearchBlocked).toHaveBeenCalledWith({ query: "today's exchange rate", reason: 'quota_exhausted' });

    const followUpCallArgs = streamMock.mock.calls[1][0];
    const toolResultMessage = followUpCallArgs.messages.find((m: any) => m.role === 'user' && Array.isArray(m.content));
    expect(toolResultMessage.content[0].content).toContain('Live web search is not available');

    // onDone's webSearchCalls count must not include the blocked call — it
    // never ran, so it must never be metered against the user's quota.
    expect(callbacks.onDone).toHaveBeenCalledWith(expect.any(String), expect.any(Number), expect.any(Number), 0);
  });

  it('never calls onWebSearchBlocked for a turn where Claude never asks to search', async () => {
    const service = createService() as any;
    const streamMock = jest.fn().mockReturnValueOnce(
      createFakeStream(
        [{ type: 'content_block_delta', delta: { type: 'text_delta', text: '- Plain answer, no search needed.' } }],
        { stop_reason: 'end_turn', content: [] },
      ),
    );
    service.client = { messages: { stream: streamMock } };
    service.tavilyClient = { search: jest.fn() };
    service.model = 'test-model';

    const onWebSearchBlocked = jest.fn();
    const callbacks = { onToken: jest.fn(), onDone: jest.fn(), onError: jest.fn(), onWebSearchBlocked };

    await service.streamResponse('hello', [], 'system prompt', callbacks, {
      enableWebSearch: true,
      webSearchBlockReason: 'quota_exhausted',
    });

    expect(onWebSearchBlocked).not.toHaveBeenCalled();
  });

  it('runs the real search normally when no block reason is set, even with a quota-capable tier', async () => {
    const service = createService() as any;
    const streamMock = streamWithOneWebSearchCall();
    const tavilySearch = jest.fn().mockResolvedValue({ results: [{ title: 'T', content: 'C', url: 'https://x' }] });

    service.client = { messages: { stream: streamMock } };
    service.tavilyClient = { search: tavilySearch };
    service.model = 'test-model';

    const onWebSearchBlocked = jest.fn();
    const callbacks = { onToken: jest.fn(), onDone: jest.fn(), onError: jest.fn(), onWebSearchBlocked };

    await service.streamResponse("what's today's exchange rate", [], 'system prompt', callbacks, {
      enableWebSearch: true,
    });

    expect(tavilySearch).toHaveBeenCalledTimes(1);
    expect(onWebSearchBlocked).not.toHaveBeenCalled();
    expect(callbacks.onDone).toHaveBeenCalledWith(expect.any(String), expect.any(Number), expect.any(Number), 1);
  });
});

describe('ClaudeService.streamResponse — generate_document truncated by max_tokens', () => {
  it('reports a clear failure instead of silently dropping the whole turn', async () => {
    const service = createService() as any;

    // A large document body cut off mid tool-call — the stream ends with
    // stop_reason 'max_tokens', not 'tool_use', and the JSON is incomplete.
    const truncatedInputJson = '{"title":"Role of INEC in Nigeria","topic":"INEC","sections":[{"heading":"Intro","content":"tex';

    const firstStreamEvents = [
      { type: 'message_start', message: { usage: { input_tokens: 10 } } },
      { type: 'content_block_start', content_block: { type: 'tool_use', id: 'tool-1', name: 'generate_document' } },
      { type: 'content_block_delta', delta: { type: 'input_json_delta', partial_json: truncatedInputJson } },
      { type: 'message_delta', usage: { output_tokens: 4000 } },
    ];
    const firstFinalMessage = {
      stop_reason: 'max_tokens',
      content: [{ type: 'tool_use', id: 'tool-1', name: 'generate_document', input: {} }],
    };

    const followUpEvents = [
      {
        type: 'content_block_delta',
        delta: { type: 'text_delta', text: '- That document was too long — try asking for fewer pages.' },
      },
      { type: 'message_delta', usage: { output_tokens: 8 } },
    ];

    const streamMock = jest
      .fn()
      .mockReturnValueOnce(createFakeStream(firstStreamEvents, firstFinalMessage))
      .mockReturnValueOnce(createFakeStream(followUpEvents, {}));

    service.client = { messages: { stream: streamMock } };
    service.tavilyClient = null;
    service.model = 'test-model';

    const onDocumentRequest = jest.fn();
    const callbacks = { onToken: jest.fn(), onDone: jest.fn(), onError: jest.fn(), onDocumentRequest };

    await service.streamResponse(
      'Discuss the role of INEC in Nigeria in a 4 page doc',
      [],
      'system prompt',
      callbacks,
      { enableDocumentGeneration: true },
    );

    expect(callbacks.onError).not.toHaveBeenCalled();
    // The old bug: gating on stop_reason === 'tool_use' meant this whole branch
    // was skipped, onDone got called with empty text, and the caller fell back to
    // the generic "didn't quite catch that" message despite a perfectly clear request.
    expect(onDocumentRequest).not.toHaveBeenCalled();
    expect(callbacks.onDone).toHaveBeenCalledWith(
      expect.stringContaining('too long'),
      expect.any(Number),
      expect.any(Number),
      expect.any(Number),
    );

    const followUpCallArgs = streamMock.mock.calls[1][0];
    const toolResultMessage = followUpCallArgs.messages.find(
      (m: any) => m.role === 'user' && Array.isArray(m.content),
    );
    expect(toolResultMessage.content[0].content).toContain('cut off');
  });
});

describe('ClaudeService — field relevance guidance', () => {
  it('treats General Knowledge as maximally broad and never tells it to decline for being "too general"', () => {
    const service = createService();
    const prompt = service.buildSystemPrompt('General Knowledge');

    expect(prompt).toContain('maximally broad');
    expect(prompt).not.toContain("switch your field to 'General Knowledge'");
  });

  it('for every other field, the decline message suggests switching to General Knowledge instead of a dead end', () => {
    const service = createService();
    const prompt = service.buildSystemPrompt('Law');

    expect(prompt).not.toContain("I'm focused on helping you professionally. Try asking something related to your work or industry.");
    expect(prompt).toContain("switch your field to 'General Knowledge'");
    expect(prompt).toContain("outside Law's professional scope");
  });

  it('has no field-relevance section at all when no field is set', () => {
    const service = createService();
    const prompt = service.buildSystemPrompt();

    expect(prompt).not.toContain('Field relevance guidance');
  });
});

describe('ClaudeService — output language directive', () => {
  it('buildSystemPrompt defaults to English and omits the mandatory directive', () => {
    const service = createService();
    const prompt = service.buildSystemPrompt();

    expect(prompt).toContain('Respond in English.');
    expect(prompt).not.toContain('OUTPUT LANGUAGE — MANDATORY');
  });

  it('buildSystemPrompt includes a mandatory non-English directive when a language is passed', () => {
    const service = createService();
    const prompt = service.buildSystemPrompt(undefined, undefined, null, false, false, undefined, undefined, 'es');

    expect(prompt).toContain('OUTPUT LANGUAGE — MANDATORY');
    expect(prompt).toContain('Spanish');
    expect(prompt).toContain('es');
  });

  it('buildDualSpeakerPrompt includes the directive for the requested language', () => {
    const service = createService();
    const prompt = service.buildDualSpeakerPrompt(undefined, undefined, null, 'fr');

    expect(prompt).toContain('French');
  });
});

describe('ClaudeService.generateConversationTitle', () => {
  function mockCreate(service: any, blocks: unknown[]) {
    const create = jest.fn().mockResolvedValue({ content: blocks });
    service.client = { messages: { create } };
    return create;
  }

  it('includes the language directive in the system prompt and a 10s timeout option', async () => {
    const service = createService() as any;
    const create = mockCreate(service, [{ type: 'text', text: 'Un Résumé Rapide' }]);

    const title = await service.generateConversationTitle('hola', 'respuesta', undefined, 'fr');

    expect(title).toBe('Un Résumé Rapide');
    const [params, options] = create.mock.calls[0];
    expect(params.system).toContain('French');
    expect(options).toEqual({ timeout: 10_000 });
  });

  it('throws instead of falling back to raw/untranslated user input when the model returns empty text', async () => {
    const service = createService() as any;
    mockCreate(service, [{ type: 'text', text: '   ' }]);

    await expect(service.generateConversationTitle('some user prompt', 'ai response')).rejects.toThrow();
  });

  it('throws when the model returns a non-text block', async () => {
    const service = createService() as any;
    mockCreate(service, [{ type: 'tool_use' }]);

    await expect(service.generateConversationTitle('some user prompt', 'ai response')).rejects.toThrow();
  });
});


describe('ClaudeService summary generation — no silent truncation', () => {
  const textResponse = (text: string) => ({ content: [{ type: 'text', text }] });
  const doc = JSON.stringify({ title: 'T', topic: 't', sections: [{ heading: 'Summary', content: 'S' }] });
  const withClient = (create: jest.Mock) => {
    const service = createService() as any;
    service.client = { messages: { create } };
    return service;
  };

  it('sends the WHOLE transcript — the beginning and the end both reach the model (the old code cut at 12,000 characters)', async () => {
    const create = jest.fn().mockResolvedValue(textResponse(doc));
    const service = withClient(create);
    const turns = [
      { role: 'user', content: 'OPENING-MARKER ' + 'a'.repeat(15_000) },
      { role: 'assistant', content: 'b'.repeat(15_000) + ' CLOSING-MARKER' },
    ];
    expect(await service.generateConversationSummaryDocument(turns, 'Law')).toMatchObject({ title: 'T' });
    const sent: string = create.mock.calls[0][0].messages[0].content;
    expect(sent.length).toBeGreaterThan(30_000);
    expect(sent).toContain('OPENING-MARKER');
    expect(sent).toContain('CLOSING-MARKER');
  });

  it('refuses an input beyond the hard limit instead of truncating it (no model call)', async () => {
    const create = jest.fn();
    const service = withClient(create);
    const result = await service.generateConversationSummaryDocument([{ role: 'user', content: 'x'.repeat(81_000) }]);
    expect(result).toBeNull();
    expect(create).not.toHaveBeenCalled();
  });

  it('writes the final summary from ordered notes, labelled as parts of one conversation', async () => {
    const create = jest.fn().mockResolvedValue(textResponse(doc));
    const service = withClient(create);
    await service.generateConversationSummaryFromNotes(['- first topic', '- middle topic', '- last topic'], 'Law');
    const call = create.mock.calls[0][0];
    expect(call.messages[0].content).toMatch(/Part 1 of 3:\n- first topic[\s\S]*Part 2 of 3:\n- middle topic[\s\S]*Part 3 of 3:\n- last topic/);
    expect(call.system).toMatch(/beginning, the middle and the end/);
    expect(await service.generateConversationSummaryFromNotes([])).toBeNull();
  });

  describe('summarizeConversationChunk', () => {
    it('asks for notes on one numbered part and caps the notes at maxChars', async () => {
      const create = jest.fn().mockResolvedValue(textResponse('- ' + 'n'.repeat(5_000)));
      const service = withClient(create);
      const notes = await service.summarizeConversationChunk([{ role: 'user', content: 'hello' }], { index: 2, total: 5 }, undefined, 2_400);
      expect(notes).toHaveLength(2_400);
      expect(create.mock.calls[0][0].system).toMatch(/part 2 of 5/);
      expect(create.mock.calls[0][0].messages[0].content).toContain('Part 2 of 5');
    });

    it('returns null (never throws) for a non-text answer, an empty answer, or a failed call', async () => {
      expect(await withClient(jest.fn().mockResolvedValue({ content: [{ type: 'tool_use' }] })).summarizeConversationChunk([{ role: 'user', content: 'x' }], { index: 1, total: 2 }, undefined, 100)).toBeNull();
      expect(await withClient(jest.fn().mockResolvedValue(textResponse('   '))).summarizeConversationChunk([{ role: 'user', content: 'x' }], { index: 1, total: 2 }, undefined, 100)).toBeNull();
      expect(await withClient(jest.fn().mockRejectedValue(new Error('rate limited for a@b.com'))).summarizeConversationChunk([{ role: 'user', content: 'x' }], { index: 1, total: 2 }, undefined, 100)).toBeNull();
      expect(await withClient(jest.fn()).summarizeConversationChunk([], { index: 1, total: 1 }, undefined, 100)).toBeNull();
    });
  });
});

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
    );

    const followUpCallArgs = streamMock.mock.calls[1][0];
    const toolResultMessage = followUpCallArgs.messages.find(
      (m: any) => m.role === 'user' && Array.isArray(m.content),
    );
    expect(toolResultMessage.content[0].content).toContain('cut off');
  });
});

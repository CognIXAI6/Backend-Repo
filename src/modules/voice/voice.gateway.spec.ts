import { Logger } from '@nestjs/common';
import { EventEmitter } from 'events';
import { VoiceGateway } from './voice.gateway';

function createFakeSession(overrides: Record<string, unknown> = {}) {
  return {
    userId: 'user-1',
    conversationId: 'conv-1',
    isGuest: false,
    deepgramEmitter: new EventEmitter(),
    sendAudio: jest.fn(),
    sendFinalize: jest.fn(),
    closeDeepgram: jest.fn(),
    accumulatedTranscript: '',
    pendingInterimTranscript: '',
    transcriptConfidences: [],
    isProcessingAI: false,
    mode: 'single',
    isDualSpeaker: false,
    isMultiSpeaker: false,
    ownerSpeakerId: null,
    calibrationPhase: false,
    dualSpeakerHistory: [],
    pendingOtherText: '',
    pendingOwnerText: '',
    utteranceDebounceMs: 3000,
    utteranceDebounceTimer: null,
    speakerRoster: [],
    speakerRosterByVoiceId: new Map(),
    resolvedSpeakers: new Map(),
    multiSpeakerHistory: [],
    pendingMultiSpeakerTurns: [],
    anonymousSpeakerLabels: new Map(),
    nextAnonymousSpeakerNumber: 1,
    audioSource: 'mic_only',
    cachedAiMemory: null,
    cachedVoiceSpeakerId: null,
    cachedOwnerName: 'You',
    otherSpeakerName: null,
    identifiedDeepgramSpeakers: new Map(),
    speakerIdentificationTriggered: new Set(),
    speakerIdentificationAtSeconds: new Map(),
    speakerIdentificationFailed: new Set(),
    currentDominantSpeaker: 0,
    speakerAudioBuffers: new Map(),
    speakerAudioBytes: new Map(),
    ownerBiometricallyConfirmed: false,
    audioHeaderChunk: null,
    audioBuffer: [],
    audioBufferBytes: 0,
    speakerWordSeconds: new Map(),
    voiceCalibrationTriggered: false,
    singleSpeakerSpeechSeconds: 0,
    singleSpeakerProfileTriggered: false,
    idleTimeoutHandle: null,
    recordingSessionId: 'rec-1',
    clientSessionId: null,
    activeStreamId: null as string | null,
    lastHandledStopStreamId: null as string | null,
    streamSequences: new Map(),
    audioGapCount: 0,
    providerState: 'active',
    providerEpoch: 0,
    currentRecoveryId: null,
    recoveryAttempt: 0,
    providerConnectOptions: { diarize: false, utteranceEndMs: 1500, meetingMode: false, audioFormat: undefined },
    recoveryAudioBuffer: [] as Array<{ chunk: Buffer; enqueuedAt: number }>,
    recoveryAudioBufferBytes: 0,
    recoveryBufferOverflowStartedAt: null as number | null,
    ...overrides,
  };
}

function createGateway() {
  const deepgramService = { createLiveSession: jest.fn() };
  const errorLogService = { log: jest.fn() };
  const noop = {} as any;

  const gateway = new VoiceGateway(
    deepgramService as any,
    noop, // claudeService
    noop, // conversationService
    noop, // guestSessionService
    noop, // voiceVerificationService
    noop, // uploadService
    noop, // usersService
    noop, // fieldsService
    noop, // emailService
    errorLogService as any,
    noop, // jwtService
    noop, // configService
    noop, // speakersService
    noop, // documentService
    noop, // pushNotificationService
    noop, // entitlementsService
    noop, // usageService
    noop, // settingsService
  );

  return { gateway: gateway as any, deepgramService, errorLogService };
}

function createFakeClient(id: string) {
  return { id, emit: jest.fn() } as any;
}

describe('VoiceGateway provider recovery', () => {
  beforeEach(() => {
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'debug').mockImplementation(() => undefined);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('recovers successfully on the first attempt without tearing down the session', async () => {
    const { gateway, deepgramService } = createGateway();
    const newSendAudio = jest.fn();
    const newClose = jest.fn();
    deepgramService.createLiveSession.mockResolvedValue({
      emitter: new EventEmitter(),
      sendAudio: newSendAudio,
      close: newClose,
    });

    const client = createFakeClient('sock-1');
    const session = createFakeSession();
    gateway.sessions.set(client.id, session);

    await gateway.recoverProviderSession(client, session, 0, 'deepgram_closed', null);

    expect(client.emit).toHaveBeenCalledWith(
      'session:recovering',
      expect.objectContaining({ attempt: 1, maxAttempts: 3, recoverable: true }),
    );
    expect(client.emit).toHaveBeenCalledWith(
      'session:recovered',
      expect.objectContaining({ providerEpoch: 1, audioGapDetected: false, droppedDurationMs: 0 }),
    );
    expect(session.providerState).toBe('recovered');
    expect(session.providerEpoch).toBe(1);
    expect(session.sendAudio).toBe(newSendAudio);
    expect(session.closeDeepgram).toBe(newClose);
    expect(gateway.sessions.has(client.id)).toBe(true);
  });

  it('emits exactly one terminal session:degraded after exhausting all retries', async () => {
    const { gateway, deepgramService, errorLogService } = createGateway();
    deepgramService.createLiveSession.mockRejectedValue(new Error('connect failed'));

    const client = createFakeClient('sock-2');
    const session = createFakeSession();
    gateway.sessions.set(client.id, session);

    await gateway.recoverProviderSession(client, session, 0, 'deepgram_closed', { code: 1006 });

    expect(deepgramService.createLiveSession).toHaveBeenCalledTimes(3);

    const degradedCalls = client.emit.mock.calls.filter(([event]: [string]) => event === 'session:degraded');
    expect(degradedCalls).toHaveLength(1);
    expect(degradedCalls[0][1]).toEqual(
      expect.objectContaining({ category: 'provider_recovery_failed', recoverable: false, incidentId: expect.any(String) }),
    );
    expect(errorLogService.log).toHaveBeenCalledWith(
      expect.objectContaining({ code: 'PROVIDER_RECOVERY_EXHAUSTED' }),
    );
    expect(session.providerState).toBe('failed');
    expect(gateway.sessions.has(client.id)).toBe(false); // cleanupSession ran
  }, 10_000);

  it('collapses a duplicate error+close pair into a single recovery sequence', async () => {
    const { gateway, deepgramService } = createGateway();
    let resolveConnect!: (v: unknown) => void;
    deepgramService.createLiveSession.mockReturnValue(
      new Promise((resolve) => {
        resolveConnect = resolve;
      }),
    );

    const client = createFakeClient('sock-3');
    const session = createFakeSession();
    gateway.sessions.set(client.id, session);

    gateway.handleProviderDisruption(client, session, 0, 'deepgram_error');
    gateway.handleProviderDisruption(client, session, 0, 'deepgram_closed', { code: 1006 });

    expect(deepgramService.createLiveSession).toHaveBeenCalledTimes(1);

    resolveConnect({ emitter: new EventEmitter(), sendAudio: jest.fn(), close: jest.fn() });
    await Promise.resolve();
    await Promise.resolve();

    expect(session.providerState).toBe('recovered');
  });

  it('bounds the recovery buffer by bytes and flushes it in order on reconnect', () => {
    const { gateway } = createGateway();
    const session = createFakeSession({ providerState: 'recovering' });

    const chunk = Buffer.alloc(200_000, 1);
    gateway.bufferAudioForRecovery(session, chunk); // 200k — fits
    gateway.bufferAudioForRecovery(session, chunk); // would be 400k > 320k cap — dropped
    gateway.bufferAudioForRecovery(session, chunk); // also dropped

    expect(session.recoveryAudioBufferBytes).toBeLessThanOrEqual(320_000);
    expect(session.recoveryAudioBuffer).toHaveLength(1);
    expect(session.recoveryBufferOverflowStartedAt).not.toBeNull();

    const { flushedBytes, droppedDurationMs } = gateway.flushRecoveryBuffer(session);

    expect(flushedBytes).toBe(200_000);
    expect(session.sendAudio).toHaveBeenCalledWith(chunk);
    expect(droppedDurationMs).toBeGreaterThanOrEqual(0);
    expect(session.recoveryAudioBuffer).toHaveLength(0);
    expect(session.recoveryAudioBufferBytes).toBe(0);
    expect(session.recoveryBufferOverflowStartedAt).toBeNull();
  });

  it('suppresses recovery when cleanupSession races an in-flight disruption', async () => {
    const { gateway, deepgramService } = createGateway();
    const client = createFakeClient('sock-5');
    const session = createFakeSession();
    gateway.sessions.set(client.id, session);

    gateway.cleanupSession(client.id); // intentional teardown lands first
    await gateway.recoverProviderSession(client, session, 0, 'deepgram_closed', null);

    expect(deepgramService.createLiveSession).not.toHaveBeenCalled();
    expect(client.emit).not.toHaveBeenCalledWith('session:recovering', expect.anything());
    expect(client.emit).not.toHaveBeenCalledWith('session:degraded', expect.anything());
    expect(session.providerState).toBe('intentionally_closed');
  });

  it('ignores a disruption event for an already-superseded epoch', async () => {
    const { gateway, deepgramService } = createGateway();
    const client = createFakeClient('sock-6');
    const session = createFakeSession({ providerEpoch: 1 }); // already recovered once, now on epoch 1

    gateway.sessions.set(client.id, session);

    await gateway.recoverProviderSession(client, session, 0, 'deepgram_closed', null); // stale epoch=0

    expect(deepgramService.createLiveSession).not.toHaveBeenCalled();
    expect(session.providerState).toBe('active');
  });
});

describe('VoiceGateway.prepareAudioForUpload — mobile raw PCM vs web container audio', () => {
  it('wraps raw linear16 PCM in a WAV header for native mobile sessions', () => {
    const { gateway } = createGateway();
    const session = createFakeSession({
      providerConnectOptions: { diarize: false, utteranceEndMs: 1500, meetingMode: false, audioFormat: { encoding: 'linear16', sampleRate: 16000, channels: 1 } },
    });
    const pcm = Buffer.from([9, 9, 9, 9]);

    const result = gateway.prepareAudioForUpload(session, pcm);

    expect(result.length).toBe(44 + pcm.length);
    expect(result.toString('ascii', 0, 4)).toBe('RIFF'); // actually WAV-wrapped, not passed through raw
    expect(result.subarray(44)).toEqual(pcm);
  });

  it('leaves web/container audio (already has a real header) untouched', () => {
    const { gateway } = createGateway();
    const session = createFakeSession({
      providerConnectOptions: { diarize: false, utteranceEndMs: 1500, meetingMode: false, audioFormat: undefined },
    });
    const webmChunk = Buffer.from([0x1a, 0x45, 0xdf, 0xa3]); // EBML/WebM magic bytes

    const result = gateway.prepareAudioForUpload(session, webmChunk);

    expect(result).toBe(webmChunk); // same reference — no copy, no wrapping
  });

  it('defaults to 16kHz mono when the format hint omits sampleRate/channels', () => {
    const { gateway } = createGateway();
    const session = createFakeSession({
      providerConnectOptions: { diarize: false, utteranceEndMs: 1500, meetingMode: false, audioFormat: { encoding: 'linear16' } },
    });

    const result = gateway.prepareAudioForUpload(session, Buffer.from([1, 2]));

    expect(result.readUInt32LE(24)).toBe(16000); // sample rate
    expect(result.readUInt16LE(22)).toBe(1); // channels
  });
});

describe('VoiceGateway beforeApplicationShutdown', () => {
  beforeEach(() => {
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  });
  afterEach(() => jest.restoreAllMocks());

  it('broadcasts server:restarting to every connected client when sessions are active', async () => {
    const { gateway } = createGateway();
    gateway.server = { emit: jest.fn() };
    gateway.sessions.set('sock-1', createFakeSession());
    gateway.sessions.set('sock-2', createFakeSession());

    const start = Date.now();
    await gateway.beforeApplicationShutdown('SIGTERM');
    const elapsedMs = Date.now() - start;

    expect(gateway.server.emit).toHaveBeenCalledWith(
      'server:restarting',
      expect.objectContaining({ message: expect.any(String) }),
    );
    expect(elapsedMs).toBeGreaterThanOrEqual(450); // the grace sleep actually ran
  });

  it('does nothing when there are no active sessions', async () => {
    const { gateway } = createGateway();
    gateway.server = { emit: jest.fn() };

    await gateway.beforeApplicationShutdown('SIGTERM');

    expect(gateway.server.emit).not.toHaveBeenCalled();
  });
});

describe('VoiceGateway audio:stop finalize-and-drain', () => {
  beforeEach(() => {
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'debug').mockImplementation(() => undefined);
  });

  afterEach(() => {
    jest.restoreAllMocks();
    jest.useRealTimers();
  });

  it('finalizeAndDrain resolves as soon as the "finalized" signal fires, without waiting out the timeout', async () => {
    const { gateway } = createGateway();
    const session = createFakeSession();

    const drainPromise = (gateway as any).finalizeAndDrain(session, 5_000);
    session.deepgramEmitter.emit('finalized');
    await drainPromise;

    expect(session.sendFinalize).toHaveBeenCalledTimes(1);
    expect(session.deepgramEmitter.listenerCount('finalized')).toBe(0);
  });

  it('finalizeAndDrain resolves via the bounded timeout when no signal ever arrives, and removes its listener', async () => {
    jest.useFakeTimers();
    const { gateway } = createGateway();
    const session = createFakeSession();

    const drainPromise = (gateway as any).finalizeAndDrain(session, 1_500);
    jest.advanceTimersByTime(1_500);
    await drainPromise;

    expect(session.deepgramEmitter.listenerCount('finalized')).toBe(0);
  });

  it('does not mutate accumulatedTranscript when a newer stream started while the drain was in flight', async () => {
    const { gateway } = createGateway();
    const client = createFakeClient('sock-stale');
    const session = createFakeSession({ activeStreamId: 'stream-A', accumulatedTranscript: 'a valid prompt' });
    gateway.sessions.set(client.id, session);

    // Simulate a new recording starting mid-drain, before finalizeAndDrain resolves.
    (gateway as any).finalizeAndDrain = jest.fn().mockImplementation(async () => {
      session.activeStreamId = 'stream-B';
    });

    await gateway.handleAudioStop(client);

    expect(session.accumulatedTranscript).toBe('a valid prompt'); // untouched
    expect(client.emit).not.toHaveBeenCalledWith('ai:skipped', expect.anything());
    expect(client.emit).not.toHaveBeenCalledWith('audio:finalized', expect.anything());
  });

  it('is idempotent for a duplicate audio:stop on the same recording', async () => {
    const { gateway } = createGateway();
    const client = createFakeClient('sock-dup');
    const session = createFakeSession({ activeStreamId: 'stream-A' }); // empty transcript — short-circuits before processPrompt
    gateway.sessions.set(client.id, session);

    session.sendFinalize.mockImplementation(() => {
      queueMicrotask(() => session.deepgramEmitter.emit('finalized'));
    });

    await gateway.handleAudioStop(client);
    await gateway.handleAudioStop(client);

    expect(session.sendFinalize).toHaveBeenCalledTimes(1);
    expect(client.emit).toHaveBeenCalledWith('ai:skipped', { reason: 'empty_transcript' });
  });
});

describe('VoiceGateway processPrompt — blocked web search signal', () => {
  function createProcessPromptGateway(opts: { webSearchStatus: { canUse: boolean; used: number; limit: number | null } }) {
    const conversationService = {
      getRecentHistoryForAI: jest.fn().mockResolvedValue([]),
      saveMessage: jest.fn().mockResolvedValue(undefined),
      getFullDocumentContext: jest.fn().mockResolvedValue(null),
      getConversationImagesForAI: jest.fn().mockResolvedValue([]),
      setTitle: jest.fn().mockResolvedValue(false),
    };
    const usageService = {
      getStatus: jest.fn((_userId: string, kind: string) =>
        kind === 'web_searches' ? Promise.resolve(opts.webSearchStatus) : Promise.resolve({ canUse: true, used: 0, limit: 10 }),
      ),
      tryConsume: jest.fn().mockResolvedValue(undefined),
    };
    const settingsService = { getEffectiveLanguage: jest.fn().mockResolvedValue('en') };
    const claudeService = {
      buildSystemPrompt: jest.fn().mockReturnValue('system prompt'),
      generateConversationTitle: jest.fn().mockResolvedValue('Title'),
      streamResponse: jest.fn(),
    };
    const noop = {} as any;

    const gateway = new VoiceGateway(
      noop, claudeService as any, conversationService as any, noop, noop, noop, noop, noop, noop, noop,
      noop, noop, noop, noop, noop, noop, usageService as any, settingsService as any,
    ) as any;

    return { gateway, claudeService, usageService, conversationService };
  }

  const entitlements = { maxWebSearchesPerMonth: 10, maxMessagesPerMonth: 500 } as any;

  beforeEach(() => {
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  });
  afterEach(() => jest.restoreAllMocks());

  it('emits feature:unavailable when Claude actually attempts a search this turn and quota is exhausted', async () => {
    const { gateway, claudeService } = createProcessPromptGateway({
      webSearchStatus: { canUse: false, used: 10, limit: 10 },
    });
    claudeService.streamResponse.mockImplementation(async (_msg: string, _hist: unknown, _sys: string, callbacks: any) => {
      callbacks.onWebSearchBlocked({ query: 'current exchange rate', reason: 'quota_exhausted' });
      await callbacks.onDone('Here is my best answer without live search.', 10, 5, 0);
    });
    const client = createFakeClient('sock-1');
    const session = createFakeSession({ entitlements });

    await gateway.processPrompt(client, session, "what's today's exchange rate", 'text');

    expect(client.emit).toHaveBeenCalledWith(
      'feature:unavailable',
      expect.objectContaining({
        feature: 'web_search',
        reason: 'quota_exhausted',
        used: 10,
        limit: 10,
        conversationId: session.conversationId,
        turnId: expect.any(String),
      }),
    );
    // The streamResponse call itself must still offer the tool (so Claude can
    // decide), not silently drop it — only execution is intercepted.
    const optsArg = claudeService.streamResponse.mock.calls[0][4];
    expect(optsArg.enableWebSearch).toBe(true);
    expect(optsArg.webSearchBlockReason).toBe('quota_exhausted');
  });

  it('does not emit feature:unavailable for an ordinary turn that never attempts a search, even with quota exhausted', async () => {
    const { gateway, claudeService } = createProcessPromptGateway({
      webSearchStatus: { canUse: false, used: 10, limit: 10 },
    });
    claudeService.streamResponse.mockImplementation(async (_msg: string, _hist: unknown, _sys: string, callbacks: any) => {
      // Claude never calls onWebSearchBlocked — this turn didn't need a search.
      await callbacks.onDone('Hello! How can I help today?', 5, 5, 0);
    });
    const client = createFakeClient('sock-2');
    const session = createFakeSession({ entitlements });

    await gateway.processPrompt(client, session, 'hello', 'text');

    expect(client.emit).not.toHaveBeenCalledWith('feature:unavailable', expect.anything());
  });

  it('does not emit feature:unavailable when quota allows the search to run normally', async () => {
    const { gateway, claudeService } = createProcessPromptGateway({
      webSearchStatus: { canUse: true, used: 2, limit: 10 },
    });
    claudeService.streamResponse.mockImplementation(async (_msg: string, _hist: unknown, _sys: string, callbacks: any) => {
      await callbacks.onDone('Here is the current rate.', 10, 5, 1);
    });
    const client = createFakeClient('sock-3');
    const session = createFakeSession({ entitlements });

    await gateway.processPrompt(client, session, "what's today's exchange rate", 'text');

    expect(client.emit).not.toHaveBeenCalledWith('feature:unavailable', expect.anything());
    const optsArg = claudeService.streamResponse.mock.calls[0][4];
    expect(optsArg.webSearchBlockReason).toBeUndefined();
  });
});

describe('VoiceGateway auto-generated conversation summary', () => {
  function createSummaryGateway() {
    const conversationService = {
      getRecentHistoryForAI: jest.fn(),
      getConversationMessagesInternal: jest.fn().mockResolvedValue([]),
      setSummaryStatus: jest.fn().mockResolvedValue(undefined),
      saveMessage: jest.fn().mockResolvedValue({ id: 'msg-1' }),
      getConversationTitle: jest.fn().mockResolvedValue('My Conversation'),
    };
    const claudeService = { generateConversationSummaryDocument: jest.fn() };
    const documentService = {
      generateAndUpload: jest.fn(),
      buildSummaryPdfBuffer: jest.fn().mockResolvedValue(Buffer.from('pdf-bytes')),
    };
    const usageService = { getStatus: jest.fn().mockResolvedValue({ canUse: true }), tryConsume: jest.fn().mockResolvedValue(undefined) };
    const pushNotificationService = { sendToUser: jest.fn().mockResolvedValue(undefined) };
    const usersService = { findById: jest.fn().mockResolvedValue({ id: 'user-1', email: 'owner@example.com' }) };
    const emailService = { sendConversationSummaryEmail: jest.fn().mockResolvedValue(undefined) };
    const noop = {} as any;

    const gateway = new VoiceGateway(
      noop, claudeService as any, conversationService as any, noop, noop, noop, usersService as any, noop, emailService as any, noop,
      noop, noop, noop, documentService as any, pushNotificationService as any, noop, usageService as any, noop,
    ) as any;

    return { gateway, conversationService, claudeService, documentService, usageService, pushNotificationService, usersService, emailService };
  }

  const entitlements = { maxDocumentsPerMonth: 5, allowedDocumentDepths: ['brief'] } as any;

  beforeEach(() => {
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
  });
  afterEach(() => jest.restoreAllMocks());

  describe('buildVerbatimTranscript', () => {
    it('resolves owner/other labels to the session’s real names and keeps assistant turns attributed to CognIX AI', async () => {
      const { gateway, conversationService } = createSummaryGateway();
      conversationService.getConversationMessagesInternal.mockResolvedValue([
        { role: 'user', speaker_label: 'owner', content: 'hello there', transcript: 'hello there' },
        { role: 'user', speaker_label: 'other', content: 'hi back', transcript: 'hi back' },
        { role: 'assistant', content: 'Nothing to flag.' },
      ]);
      const session = createFakeSession({ cachedOwnerName: 'Mr Tolu', otherSpeakerName: 'Dr Amaka' });

      const transcript = await gateway.buildVerbatimTranscript('conv-1', session);

      expect(transcript).toBe('Mr Tolu: hello there\nDr Amaka: hi back\nCognIX AI: Nothing to flag.');
    });

    it('reformats bracketed multi-speaker lines into "Name: text" without the brackets', async () => {
      const { gateway, conversationService } = createSummaryGateway();
      conversationService.getConversationMessagesInternal.mockResolvedValue([
        { role: 'user', speaker_label: 'multiple_speakers', content: '[Dr Smith]: first point\n[Dr Jones]: second point', transcript: '[Dr Smith]: first point\n[Dr Jones]: second point' },
      ]);
      const session = createFakeSession();

      const transcript = await gateway.buildVerbatimTranscript('conv-1', session);

      expect(transcript).toBe('Dr Smith: first point\nDr Jones: second point');
    });
  });

  describe('autoGenerateConversationSummary', () => {
    it('marks skipped with a reason and makes no model/document calls when the tier has no document entitlement', async () => {
      const { gateway, conversationService, claudeService, documentService } = createSummaryGateway();
      const client = createFakeClient('sock-1');
      const session = createFakeSession({ entitlements: { maxDocumentsPerMonth: 0, allowedDocumentDepths: [] } });

      await gateway.autoGenerateConversationSummary(client, session);

      expect(conversationService.setSummaryStatus).toHaveBeenCalledWith(session.conversationId, 'pending');
      expect(conversationService.setSummaryStatus).toHaveBeenLastCalledWith(session.conversationId, 'skipped', { skipReason: 'tier_no_documents' });
      expect(claudeService.generateConversationSummaryDocument).not.toHaveBeenCalled();
      expect(documentService.generateAndUpload).not.toHaveBeenCalled();
    });

    it('marks skipped as too_short only when genuinely nothing was said', async () => {
      const { gateway, conversationService } = createSummaryGateway();
      conversationService.getRecentHistoryForAI.mockResolvedValue([]);
      const client = createFakeClient('sock-1');
      const session = createFakeSession({ entitlements });

      await gateway.autoGenerateConversationSummary(client, session);

      expect(conversationService.setSummaryStatus).toHaveBeenLastCalledWith(session.conversationId, 'skipped', { skipReason: 'too_short' });
    });

    it('still generates a real document for a short conversation instead of skipping it', async () => {
      const { gateway, conversationService, claudeService, documentService } = createSummaryGateway();
      // A single short exchange — previously blocked by a < 40-word floor.
      // Every conversation with any content at all should produce something.
      conversationService.getRecentHistoryForAI.mockResolvedValue([{ role: 'user', content: 'hi' }]);
      claudeService.generateConversationSummaryDocument.mockResolvedValue({
        title: 'Quick Hello',
        topic: 'A brief greeting',
        sections: [{ heading: 'Summary', content: 'The user said hello.' }],
      });
      documentService.generateAndUpload.mockResolvedValue({ docId: 'doc-2', downloadUrl: 'https://example.com/doc-2' });
      const client = createFakeClient('sock-1');
      const session = createFakeSession({ entitlements });

      await gateway.autoGenerateConversationSummary(client, session);

      expect(conversationService.setSummaryStatus).not.toHaveBeenCalledWith(session.conversationId, 'skipped', expect.anything());
      expect(documentService.generateAndUpload).toHaveBeenCalled();
      expect(conversationService.setSummaryStatus).toHaveBeenLastCalledWith(session.conversationId, 'ready', { documentId: 'doc-2' });
    });

    it('omits Action Points entirely when the model omits Follow-up Actions, instead of a placeholder section', async () => {
      const { gateway, conversationService, claudeService, documentService } = createSummaryGateway();
      conversationService.getRecentHistoryForAI.mockResolvedValue([
        { role: 'user', content: "what's the capital of France?" },
        { role: 'assistant', content: 'Paris.' },
      ]);
      // No "Key Insights" or "Follow-up Actions" — a purely informational
      // exchange with nothing actionable or non-obvious to report.
      claudeService.generateConversationSummaryDocument.mockResolvedValue({
        title: 'Capital of France',
        topic: 'A quick factual question',
        sections: [{ heading: 'Summary', content: 'The user asked for the capital of France; the AI answered Paris.' }],
      });
      documentService.generateAndUpload.mockResolvedValue({ docId: 'doc-3', downloadUrl: 'https://example.com/doc-3' });
      const client = createFakeClient('sock-1');
      const session = createFakeSession({ entitlements, cachedOwnerName: 'Mr Tolu' });

      await gateway.autoGenerateConversationSummary(client, session);

      const uploadCall = documentService.generateAndUpload.mock.calls[0][0];
      const headings = uploadCall.sections.map((s: any) => s.heading);
      expect(headings).not.toContain('Action Points / Next Steps');
      expect(headings).not.toContain('Key Insights');
      expect(headings[0]).toBe('Summary');
    });

    it('marks skipped as quota_exceeded when the monthly document cap is hit', async () => {
      const { gateway, conversationService, usageService } = createSummaryGateway();
      conversationService.getRecentHistoryForAI.mockResolvedValue([
        { role: 'user', content: 'a '.repeat(25) },
        { role: 'assistant', content: 'b '.repeat(25) },
      ]);
      usageService.getStatus.mockResolvedValue({ canUse: false });
      const client = createFakeClient('sock-1');
      const session = createFakeSession({ entitlements });

      await gateway.autoGenerateConversationSummary(client, session);

      expect(conversationService.setSummaryStatus).toHaveBeenLastCalledWith(session.conversationId, 'skipped', { skipReason: 'quota_exceeded' });
    });

    it('marks failed with generation_error when the model returns nothing usable', async () => {
      const { gateway, conversationService, claudeService } = createSummaryGateway();
      conversationService.getRecentHistoryForAI.mockResolvedValue([
        { role: 'user', content: 'a '.repeat(25) },
        { role: 'assistant', content: 'b '.repeat(25) },
      ]);
      claudeService.generateConversationSummaryDocument.mockResolvedValue(null);
      const client = createFakeClient('sock-1');
      const session = createFakeSession({ entitlements });

      await gateway.autoGenerateConversationSummary(client, session);

      expect(conversationService.setSummaryStatus).toHaveBeenLastCalledWith(session.conversationId, 'failed', { skipReason: 'generation_error' });
    });

    it('splices a code-built Transcript section after Summary and moves Action Points / Next Steps to the end, landing at exactly 4 sections', async () => {
      const { gateway, conversationService, claudeService, documentService, usageService } = createSummaryGateway();
      conversationService.getRecentHistoryForAI.mockResolvedValue([
        { role: 'user', content: 'a '.repeat(25) },
        { role: 'assistant', content: 'b '.repeat(25) },
      ]);
      conversationService.getConversationMessagesInternal.mockResolvedValue([
        { role: 'user', speaker_label: 'owner', content: 'hello', transcript: 'hello' },
      ]);
      claudeService.generateConversationSummaryDocument.mockResolvedValue({
        title: 'Quick Sync',
        topic: 'A quick sync',
        sections: [
          { heading: 'Summary', content: 'They synced.' },
          { heading: 'Key Insights', content: '- Insight one' },
          { heading: 'Follow-up Actions', content: '- Do the thing' },
        ],
      });
      documentService.generateAndUpload.mockResolvedValue({ docId: 'doc-1', downloadUrl: 'https://example.com/doc-1' });
      const client = createFakeClient('sock-1');
      const session = createFakeSession({ entitlements, cachedOwnerName: 'Mr Tolu' });

      await gateway.autoGenerateConversationSummary(client, session);

      const uploadCall = documentService.generateAndUpload.mock.calls[0][0];
      expect(uploadCall.sections.map((s: any) => s.heading)).toEqual([
        'Summary',
        'Transcript',
        'Key Insights',
        'Action Points / Next Steps',
      ]);
      expect(uploadCall.sections[1].content).toBe('Mr Tolu: hello');
      expect(uploadCall.sections[3].content).toBe('- Do the thing');

      expect(usageService.tryConsume).toHaveBeenCalledWith(session.userId, 'documents', 1, entitlements.maxDocumentsPerMonth);
      expect(conversationService.setSummaryStatus).toHaveBeenLastCalledWith(session.conversationId, 'ready', { documentId: 'doc-1' });
      expect(client.emit).toHaveBeenCalledWith('document:ready', expect.objectContaining({ docId: 'doc-1', auto: true }));

      // Regression coverage for a real bug: the auto-summary's "ready"
      // announcement was previously only ever emitted live — never saved as
      // a conversation_messages row — so a client reopening the conversation
      // later had no trace of the document ever existing, even though the
      // document itself (and conversations.summary_document_id) survived
      // intact. It must be a real, persisted message with document_id set,
      // exactly like the manual "generate a document" chat flow already does.
      expect(conversationService.saveMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          conversationId: session.conversationId,
          role: 'assistant',
          documentId: 'doc-1',
        }),
      );
    });

    describe('summary-ready email', () => {
      function mockSuccessfulGeneration(claudeService: any, documentService: any) {
        claudeService.generateConversationSummaryDocument.mockResolvedValue({
          title: 'Quick Sync',
          topic: 'A quick sync',
          sections: [{ heading: 'Summary', content: 'They synced.' }],
        });
        documentService.generateAndUpload.mockResolvedValue({ docId: 'doc-1', downloadUrl: 'https://example.com/doc-1' });
      }

      it('emails the user a PDF attachment of the summary once it is ready', async () => {
        const { gateway, conversationService, claudeService, documentService, usersService, emailService } = createSummaryGateway();
        conversationService.getRecentHistoryForAI.mockResolvedValue([
          { role: 'user', content: 'a '.repeat(25) },
          { role: 'assistant', content: 'b '.repeat(25) },
        ]);
        mockSuccessfulGeneration(claudeService, documentService);
        const client = createFakeClient('sock-1');
        const session = createFakeSession({ entitlements, userId: 'user-1' });

        await gateway.autoGenerateConversationSummary(client, session);
        await new Promise((r) => setImmediate(r)); // fire-and-forget email step

        expect(usersService.findById).toHaveBeenCalledWith('user-1');
        expect(documentService.buildSummaryPdfBuffer).toHaveBeenCalledWith(
          'Quick Sync',
          expect.arrayContaining([expect.objectContaining({ heading: 'Summary' })]),
        );
        expect(emailService.sendConversationSummaryEmail).toHaveBeenCalledWith(
          'owner@example.com',
          'My Conversation', // the conversation's own title, not the document's
          expect.objectContaining({ filename: expect.stringContaining('.pdf'), content: Buffer.from('pdf-bytes') }),
        );
      });

      it('falls back to the document title when the conversation has no title of its own', async () => {
        const { gateway, conversationService, claudeService, documentService, emailService } = createSummaryGateway();
        conversationService.getConversationTitle.mockResolvedValue(null);
        conversationService.getRecentHistoryForAI.mockResolvedValue([
          { role: 'user', content: 'a '.repeat(25) },
          { role: 'assistant', content: 'b '.repeat(25) },
        ]);
        mockSuccessfulGeneration(claudeService, documentService);
        const client = createFakeClient('sock-1');
        const session = createFakeSession({ entitlements, userId: 'user-1' });

        await gateway.autoGenerateConversationSummary(client, session);
        await new Promise((r) => setImmediate(r));

        expect(emailService.sendConversationSummaryEmail).toHaveBeenCalledWith(
          'owner@example.com',
          'Quick Sync',
          expect.anything(),
        );
      });

      it('does not email a guest session', async () => {
        const { gateway, conversationService, claudeService, documentService, usersService, emailService } = createSummaryGateway();
        conversationService.getRecentHistoryForAI.mockResolvedValue([
          { role: 'user', content: 'a '.repeat(25) },
          { role: 'assistant', content: 'b '.repeat(25) },
        ]);
        mockSuccessfulGeneration(claudeService, documentService);
        const client = createFakeClient('sock-1');
        const session = createFakeSession({ entitlements, isGuest: true });

        await gateway.autoGenerateConversationSummary(client, session);
        await new Promise((r) => setImmediate(r));

        expect(usersService.findById).not.toHaveBeenCalled();
        expect(emailService.sendConversationSummaryEmail).not.toHaveBeenCalled();
      });

      it('does not fail the document generation when the email step throws', async () => {
        const { gateway, conversationService, claudeService, documentService, emailService } = createSummaryGateway();
        conversationService.getRecentHistoryForAI.mockResolvedValue([
          { role: 'user', content: 'a '.repeat(25) },
          { role: 'assistant', content: 'b '.repeat(25) },
        ]);
        mockSuccessfulGeneration(claudeService, documentService);
        emailService.sendConversationSummaryEmail.mockRejectedValue(new Error('SMTP down'));
        const client = createFakeClient('sock-1');
        const session = createFakeSession({ entitlements, userId: 'user-1' });

        await expect(gateway.autoGenerateConversationSummary(client, session)).resolves.toBeUndefined();
        await new Promise((r) => setImmediate(r));

        expect(conversationService.setSummaryStatus).toHaveBeenLastCalledWith(session.conversationId, 'ready', { documentId: 'doc-1' });
      });
    });

    it('marks failed and emits document:failed when the upload step throws, without losing the thrown error', async () => {
      const { gateway, conversationService, claudeService, documentService } = createSummaryGateway();
      conversationService.getRecentHistoryForAI.mockResolvedValue([
        { role: 'user', content: 'a '.repeat(25) },
        { role: 'assistant', content: 'b '.repeat(25) },
      ]);
      claudeService.generateConversationSummaryDocument.mockResolvedValue({
        title: 'Quick Sync',
        topic: 'A quick sync',
        sections: [{ heading: 'Summary', content: 'They synced.' }],
      });
      documentService.generateAndUpload.mockRejectedValue(new Error('upload failed'));
      const client = createFakeClient('sock-1');
      const session = createFakeSession({ entitlements });

      await expect(gateway.autoGenerateConversationSummary(client, session)).rejects.toThrow('upload failed');

      expect(conversationService.setSummaryStatus).toHaveBeenLastCalledWith(session.conversationId, 'failed', { skipReason: 'generation_error' });
      expect(client.emit).toHaveBeenCalledWith('document:failed', expect.objectContaining({ auto: true }));
    });
  });

  describe('handleDisconnect — same auto-summary treatment as an explicit session:end', () => {
    it('generates the auto-summary on a raw disconnect when session:end was never emitted', async () => {
      const { gateway, conversationService } = createSummaryGateway();
      const client = createFakeClient('sock-1');
      // No entitlements -> autoGenerateConversationSummary takes the cheap
      // tier_no_documents skip path; the point of this test is that it runs
      // at all on a bare disconnect, not the full generation flow (already
      // covered above).
      const session = createFakeSession();
      gateway.sessions.set(client.id, session);

      await gateway.handleDisconnect(client);
      // handleDisconnect fires the summary fire-and-forget rather than
      // awaiting it (same as handleSessionEnd) — flush the microtask queue
      // so it has a chance to run before asserting on it.
      await new Promise((r) => setImmediate(r));

      expect(conversationService.setSummaryStatus).toHaveBeenCalledWith(session.conversationId, 'pending');
      expect(conversationService.setSummaryStatus).toHaveBeenLastCalledWith(session.conversationId, 'skipped', { skipReason: 'tier_no_documents' });
      expect(gateway.sessions.has(client.id)).toBe(false);
    });

    it('does not double-generate when session:end already ran for this socket', async () => {
      const { gateway, conversationService } = createSummaryGateway();
      const client = createFakeClient('sock-1');
      const session = createFakeSession();
      gateway.sessions.set(client.id, session);

      await gateway.handleSessionEnd(client); // runs cleanupSession, removes from map
      await new Promise((r) => setImmediate(r)); // let its own fire-and-forget settle first
      conversationService.setSummaryStatus.mockClear();

      await gateway.handleDisconnect(client); // session already gone — must be a no-op
      await new Promise((r) => setImmediate(r));

      expect(conversationService.setSummaryStatus).not.toHaveBeenCalled();
    });

    it('flushes pending multi-speaker turns before cleanupSession clears their buffers', async () => {
      const { gateway } = createSummaryGateway();
      const client = createFakeClient('sock-1');
      const session = createFakeSession({
        isMultiSpeaker: true,
        pendingMultiSpeakerTurns: [{ speakerId: 's1', text: 'hello' }],
      });
      gateway.sessions.set(client.id, session);

      const flushSpy = jest.spyOn(gateway, 'flushMultiSpeakerTurns').mockResolvedValue(true);

      await gateway.handleDisconnect(client);

      expect(flushSpy).toHaveBeenCalledWith(client, session, { reason: 'session_end', minWords: 1 });
      expect(gateway.sessions.has(client.id)).toBe(false);
    });
  });
});

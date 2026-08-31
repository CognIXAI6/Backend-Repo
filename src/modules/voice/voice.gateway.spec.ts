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
    activeStreamId: null,
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

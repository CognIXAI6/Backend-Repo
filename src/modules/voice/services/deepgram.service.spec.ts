import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DeepgramService } from './deepgram.service';

const mockConnect = jest.fn();

jest.mock('@deepgram/sdk', () => ({
  DeepgramClient: jest.fn().mockImplementation(() => ({
    listen: { v1: { connect: (...args: unknown[]) => mockConnect(...args) } },
  })),
}));

function createFakeSocket() {
  const handlers: Record<string, (...args: unknown[]) => void> = {};
  const socket: {
    on: jest.Mock;
    connect: jest.Mock;
    waitForOpen: jest.Mock;
    sendMedia: jest.Mock;
    sendCloseStream: jest.Mock;
    sendKeepAlive: jest.Mock;
    close: jest.Mock;
    readyState: number;
    socket: { addEventListener: jest.Mock };
  } = {
    on: jest.fn((event: string, cb: (...args: unknown[]) => void) => {
      handlers[event] = cb;
    }),
    connect: jest.fn(),
    waitForOpen: jest.fn(() => Promise.resolve()),
    sendMedia: jest.fn(),
    sendCloseStream: jest.fn(),
    sendKeepAlive: jest.fn(),
    close: jest.fn(),
    readyState: 1,
    socket: { addEventListener: jest.fn() },
  };
  socket.connect.mockImplementation(() => socket);
  return { socket, handlers };
}

describe('DeepgramService', () => {
  let service: DeepgramService;
  // createLiveSession starts a real setInterval (KeepAlive) that only stops
  // via the returned close() — track every session created in a test so
  // afterEach can tear them down and avoid leaking timer handles into
  // later tests / Jest's process-exit check.
  let cleanups: Array<() => void>;

  beforeEach(() => {
    jest.clearAllMocks();
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'debug').mockImplementation(() => undefined);

    const configService = { get: jest.fn().mockReturnValue('fake-api-key') };
    service = new DeepgramService(configService as unknown as ConfigService);
    service.onModuleInit();
    cleanups = [];
  });

  afterEach(() => {
    cleanups.forEach((close) => close());
    jest.useRealTimers();
  });

  it('propagates close code/reason/wasClean, with errorPreceded=false when no prior error', async () => {
    const { socket, handlers } = createFakeSocket();
    mockConnect.mockResolvedValue(socket);

    const { emitter, close } = await service.createLiveSession('sess-1');
    cleanups.push(close);
    const closeListener = jest.fn();
    emitter.on('close', closeListener);

    handlers['close']({ code: 1006, reason: 'abnormal', wasClean: false });

    expect(closeListener).toHaveBeenCalledWith(
      expect.objectContaining({ code: 1006, reason: 'abnormal', wasClean: false, errorPreceded: false }),
    );
  });

  it('marks errorPreceded=true when an error frame preceded the close', async () => {
    const { socket, handlers } = createFakeSocket();
    mockConnect.mockResolvedValue(socket);

    const { emitter, close } = await service.createLiveSession('sess-2');
    cleanups.push(close);
    emitter.on('error', () => {});

    handlers['error'](new Error('boom'));

    const closeListener = jest.fn();
    emitter.on('close', closeListener);
    handlers['close']({ code: 1011, reason: 'server error', wasClean: false });

    expect(closeListener).toHaveBeenCalledWith(expect.objectContaining({ errorPreceded: true }));
  });

  it('emits transportFailure when sendMedia throws', async () => {
    const { socket } = createFakeSocket();
    socket.sendMedia.mockImplementation(() => {
      throw new Error('send failed');
    });
    mockConnect.mockResolvedValue(socket);

    const { emitter, sendAudio, close } = await service.createLiveSession('sess-3');
    cleanups.push(close);
    const failureListener = jest.fn();
    emitter.on('transportFailure', failureListener);

    sendAudio(Buffer.from('x'));

    expect(failureListener).toHaveBeenCalledWith(expect.objectContaining({ source: 'sendMedia' }));
  });

  it('emits transportFailure when sendKeepAlive throws', async () => {
    jest.useFakeTimers();
    const { socket } = createFakeSocket();
    socket.sendKeepAlive.mockImplementation(() => {
      throw new Error('keepalive failed');
    });
    mockConnect.mockResolvedValue(socket);

    const { emitter, close } = await service.createLiveSession('sess-4');
    cleanups.push(close);
    const failureListener = jest.fn();
    emitter.on('transportFailure', failureListener);

    jest.advanceTimersByTime(6_000);

    expect(failureListener).toHaveBeenCalledWith(expect.objectContaining({ source: 'sendKeepAlive' }));
  });

  it('keeps sending KeepAlive through 20s of silence without ever closing the connection', async () => {
    jest.useFakeTimers();
    const { socket } = createFakeSocket();
    mockConnect.mockResolvedValue(socket);

    const { close } = await service.createLiveSession('sess-5');
    cleanups.push(close);

    jest.advanceTimersByTime(20_000);

    expect(socket.sendKeepAlive).toHaveBeenCalledTimes(3); // fires at 6s, 12s, 18s
    expect(socket.close).not.toHaveBeenCalled();
  });
});

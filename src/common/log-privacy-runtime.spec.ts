/**
 * Runtime checks that complement the static scan: drive real code paths with
 * sentinel personal data and assert none of it reaches any log call.
 */
import { EventEmitter } from 'events';
import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import pino from 'pino';
import { EmailService } from '../modules/email/email.service';
import { VoiceGateway } from '../modules/voice/voice.gateway';
import { REDACT } from './logger/logger.module';

const ADDRESS = 'sentinel.person@example.org';
const SIGNED_URL = 'https://res.cloudinary.com/demo/raw/upload/s--SIGSENTINEL--/secret-doc.docx';
const SECRET_WORDS = 'sentinel diagnosis metformin dosage';

function captureLogs() {
  const lines: string[] = [];
  const grab = (...args: unknown[]) => { lines.push(args.map((a) => (a instanceof Error ? `${a.message}\n${a.stack}` : typeof a === 'string' ? a : JSON.stringify(a))).join(' ')); };
  (['log', 'warn', 'error', 'debug', 'verbose'] as const).forEach((m) => jest.spyOn(Logger.prototype, m).mockImplementation(grab as any));
  return lines;
}

describe('log privacy (runtime)', () => {
  afterEach(() => jest.restoreAllMocks());

  it('a failing email provider never puts the recipient address, URL or provider body in the log', async () => {
    const lines = captureLogs();
    const service = new EmailService({ get: jest.fn().mockReturnValue(undefined) } as unknown as ConfigService);
    (service as any).resend = {
      emails: {
        send: jest.fn().mockResolvedValue({
          data: null,
          error: { name: 'validation_error', statusCode: 422, message: `Invalid recipient ${ADDRESS} at ${SIGNED_URL}` },
        }),
      },
    };
    await expect(service.sendEmail({ to: ADDRESS, subject: 'Your summary', html: '<p>hi</p>' } as any)).rejects.toThrow();
    const logged = lines.join('\n');
    expect(logged).not.toContain(ADDRESS);
    expect(logged).not.toContain('SIGSENTINEL');
    expect(logged).not.toContain('example.org');
    expect(logged).toMatch(/Failed to send email \(transport=resend\)/);
    expect(logged).toMatch(/status=422/); // still diagnosable
  });

  it('a successful send logs the provider message id, not the recipient', async () => {
    const lines = captureLogs();
    const service = new EmailService({ get: jest.fn().mockReturnValue(undefined) } as unknown as ConfigService);
    (service as any).resend = { emails: { send: jest.fn().mockResolvedValue({ data: { id: 'msg_123' }, error: null }) } };
    await service.sendEmail({ to: ADDRESS, subject: 's', html: 'h' } as any);
    const logged = lines.join('\n');
    expect(logged).toContain('msg_123');
    expect(logged).not.toContain(ADDRESS);
  });

  it('a transcript the quality filter rejects is logged as a word count, never as text', async () => {
    const lines = captureLogs();
    const noop = {} as any;
    const gateway: any = new VoiceGateway(noop, noop, noop, noop, noop, noop, noop, noop, noop, { log: jest.fn() } as any, noop, noop, noop, noop, noop, noop, noop, noop);
    const client: any = { id: 'sock-1', emit: jest.fn() };
    const session: any = {
      userId: 'sentinel-user-id', isGuest: true, isMultiSpeaker: false, isDualSpeaker: false, activeStreamId: 's1', lastHandledStopStreamId: null,
      accumulatedTranscript: SECRET_WORDS, pendingInterimTranscript: '', transcriptConfidences: [0.1], inFlightTurns: new Set(), isProcessingAI: false,
      pendingOtherText: '', pendingOwnerText: '', pendingUnattributedText: '', providerState: 'active', deepgramEmitter: new EventEmitter(), sendFinalize: jest.fn().mockReturnValue(false),
      traceId: 'trace-1',
    };
    gateway.sessions.set(client.id, session);
    jest.spyOn(gateway, 'isTranscriptMeaningful').mockReturnValue({ pass: false, reason: 'low_confidence' });
    await gateway.handleAudioStop(client);
    const logged = lines.join('\n');
    expect(logged).toMatch(/Transcript filtered \[low_confidence\]: words=4/);
    expect(logged).not.toMatch(/sentinel|metformin|diagnosis/);
  });

  it('request logging redacts credentials (Authorization, cookies, API keys)', () => {
    const out: string[] = [];
    const logger = pino({ redact: REDACT }, { write: (line: string) => { out.push(line); } } as any);
    logger.info({
      req: { method: 'POST', url: '/push/register', headers: { authorization: 'Bearer eyJSENTINEL.payload.sig', cookie: 'sid=SENTINELCOOKIE', 'x-api-key': 'SENTINELKEY', accept: 'application/json' } },
      res: { headers: { 'set-cookie': 'sid=SENTINELSETCOOKIE' } },
    }, 'request completed');
    const line = out.join('');
    expect(line).not.toMatch(/SENTINEL|eyJ/);
    expect(line).toContain('[redacted]');
    expect(line).toContain('application/json'); // non-sensitive headers survive
  });
});

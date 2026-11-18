import { ConfigService } from '@nestjs/config';
import { v2 as cloudinary } from 'cloudinary';
import { DocumentService } from './document.service';

jest.mock('cloudinary', () => ({
  v2: {
    config: jest.fn(),
    uploader: {
      upload_stream: jest.fn(),
      destroy: jest.fn(),
    },
  },
}));

function createService() {
  const insert = jest.fn().mockReturnValue({
    returning: jest.fn().mockResolvedValue([{ id: 'doc-1' }]),
  });
  const knex = jest.fn(() => ({ insert })) as any;
  const configService = { get: jest.fn() } as unknown as ConfigService;
  const service = new DocumentService(knex, configService) as any;
  return { service, knex };
}

const sections = [{ heading: 'Summary', content: 'They synced.' }];

describe('DocumentService.withTimeout', () => {
  it('rejects with a clear message instead of hanging forever on a promise that never settles', async () => {
    const { service } = createService();
    const neverSettles = new Promise<string>(() => {}); // reproduces a stalled Cloudinary callback

    await expect(service.withTimeout(neverSettles, 25, 'Document upload timed out')).rejects.toThrow(
      'Document upload timed out',
    );
  });

  it('resolves with the inner value when it settles before the deadline', async () => {
    const { service } = createService();

    await expect(service.withTimeout(Promise.resolve('https://cdn.example/doc'), 5_000, 'timed out')).resolves.toBe(
      'https://cdn.example/doc',
    );
  });
});

describe('DocumentService.generateAndUpload — upload timeout wiring', () => {
  it('surfaces the bounded timeout error (not an indefinite hang) when Cloudinary never calls back', async () => {
    (cloudinary.uploader.upload_stream as jest.Mock).mockReturnValue({
      // Never invokes the error/result callback and never emits 'error' —
      // reproduces a stalled/hung upload with no network-level signal, the
      // exact condition that previously left auto-summary generation (and
      // any user-requested document) stuck on "generating" forever.
      on: jest.fn(),
      end: jest.fn(),
    });
    const { service } = createService();
    // Shrink the real 30s deadline to 25ms just for this test so it doesn't
    // take 30 real seconds — the timeout behavior itself is already covered
    // directly in the describe block above.
    service.withTimeout = () =>
      new Promise((_resolve, reject) => {
        setTimeout(() => reject(new Error('Document upload timed out — the storage provider did not respond in time.')), 25);
      });

    await expect(
      service.generateAndUpload({ userId: 'user-1', title: 'Quick Sync', topic: 't', sections }),
    ).rejects.toThrow('Document upload timed out');
  });

  it('resolves normally when the upload completes well before the timeout', async () => {
    (cloudinary.uploader.upload_stream as jest.Mock).mockImplementation((_opts: any, cb: any) => {
      cb(null, { secure_url: 'https://cloudinary.example/doc.docx' });
      return { on: jest.fn(), end: jest.fn() };
    });
    const { service, knex } = createService();

    const result = await service.generateAndUpload({ userId: 'user-1', title: 'Quick Sync', topic: 't', sections });

    expect(result).toEqual({ docId: 'doc-1', downloadUrl: 'https://cloudinary.example/doc.docx' });
    expect(knex).toHaveBeenCalledWith('generated_documents');
  });
});

describe('DocumentService.generateSummaryReport', () => {
  const report = {
    title: 'My Conversation',
    generatedAt: '2026-11-18T10:00:00.000Z',
    sessions: [
      { number: 1, date: '2026-11-17T09:00:00.000Z', title: 'Yesterday', description: 'd', summary: 'S1', transcript: [{ kind: 'turn', speaker: 'A', text: 'hi' }], keyInsights: ['k'], actionPoints: ['a'] },
      { number: 2, date: '2026-11-18T09:00:00.000Z', title: 'Today', description: 'd', summary: 'S2', transcript: [], keyInsights: [], actionPoints: [] },
    ],
  } as any;

  beforeEach(() => {
    (cloudinary.uploader.upload_stream as jest.Mock).mockImplementation((_opts: any, cb: any) => {
      cb(null, { secure_url: 'https://cloudinary.example/report.docx' });
      return { on: jest.fn(), end: jest.fn() };
    });
  });

  it('stores one Word document with one section per session', async () => {
    const { service, knex } = createService();
    const result = await service.generateSummaryReport({ userId: 'user-1', conversationId: 'c-1', report, title: 'My Conversation' });
    expect(result).toEqual({ docId: 'doc-1', downloadUrl: 'https://cloudinary.example/report.docx' });
    expect(knex).toHaveBeenCalledWith('generated_documents');
  });

  it('refuses when the plan does not allow brief documents, before any rendering or upload', async () => {
    const { service } = createService();
    (cloudinary.uploader.upload_stream as jest.Mock).mockClear();
    await expect(
      service.generateSummaryReport({ userId: 'user-1', report, allowedDepths: ['comprehensive'] }),
    ).rejects.toThrow(/brief/);
    expect(cloudinary.uploader.upload_stream).not.toHaveBeenCalled();
  });

  it('builds the email PDF without uploading or writing a row', async () => {
    const { service, knex } = createService();
    (cloudinary.uploader.upload_stream as jest.Mock).mockClear();
    const pdf: Buffer = await service.buildSummaryReportPdfBuffer(report);
    expect(pdf.subarray(0, 5).toString()).toBe('%PDF-');
    expect(cloudinary.uploader.upload_stream).not.toHaveBeenCalled();
    expect(knex).not.toHaveBeenCalled();
  });
});

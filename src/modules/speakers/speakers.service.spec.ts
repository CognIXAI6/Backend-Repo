import { Logger } from '@nestjs/common';
import { SpeakersService } from './speakers.service';

function createFakeKnex(speaker: Record<string, unknown> | null) {
  const chain: any = {
    where: jest.fn().mockReturnThis(),
    andWhere: jest.fn().mockReturnThis(),
    first: jest.fn().mockResolvedValue(speaker),
  };
  return jest.fn(() => chain) as any;
}

const audioFile = { buffer: Buffer.from('x'), size: 16000 } as Express.Multer.File;

describe('SpeakersService.enrollSpeakerVoice — upload failure logging', () => {
  beforeEach(() => {
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  });
  afterEach(() => jest.restoreAllMocks());

  it('logs which speaker/user the upload failed for, then rethrows unchanged', async () => {
    const knex = createFakeKnex({ id: 'spk-1', user_id: 'user-1', name: 'Alex' });
    const uploadError = new Error('Buffer upload failed: Unsupported video format or file');
    const uploadService = { uploadFile: jest.fn().mockRejectedValue(uploadError) };
    const voiceVerificationService = { isEnabled: false } as any;
    const warnSpy = jest.spyOn(Logger.prototype, 'warn');

    const service = new SpeakersService(knex, uploadService as any, voiceVerificationService);

    await expect(service.enrollSpeakerVoice('user-1', 'spk-1', audioFile)).rejects.toThrow(uploadError);

    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('enrollSpeakerVoice: audio upload failed for speaker spk-1 (user user-1): Buffer upload failed: Unsupported video format or file'),
    );
  });

  it('does not touch the upload path when it succeeds', async () => {
    const knex = createFakeKnex({ id: 'spk-1', user_id: 'user-1', name: 'Alex' });
    const uploadService = { uploadFile: jest.fn().mockResolvedValue({ secure_url: 'https://cdn.example/a.wav' }) };
    const voiceVerificationService = { isEnabled: false } as any;

    const service = new SpeakersService(knex, uploadService as any, voiceVerificationService);
    // knex('voice_samples').insert(...).returning('id') needs its own chain —
    // reuse the same fake by making the mock table-aware.
    (knex as jest.Mock).mockImplementation((table: string) => {
      if (table === 'speakers') {
        return { where: jest.fn().mockReturnThis(), andWhere: jest.fn().mockReturnThis(), first: jest.fn().mockResolvedValue({ id: 'spk-1', user_id: 'user-1', name: 'Alex' }) };
      }
      if (table === 'voice_samples') {
        return { insert: jest.fn().mockReturnThis(), returning: jest.fn().mockResolvedValue([{ id: 'sample-1' }]) };
      }
      throw new Error(`unexpected table: ${table}`);
    });

    const result = await service.enrollSpeakerVoice('user-1', 'spk-1', audioFile);

    expect(uploadService.uploadFile).toHaveBeenCalledWith(audioFile, 'cognix/voice-samples', 'video');
    expect(result.voiceEnrolled).toBe(false); // voiceVerificationService.isEnabled is false
  });
});

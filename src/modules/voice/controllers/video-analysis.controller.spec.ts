import { ForbiddenException } from '@nestjs/common';
import { VideoAnalysisController } from './video-analysis.controller';

function createController(opts: {
  maxVideoAnalysesPerMonth: number;
  statusCanUse?: boolean;
  statusLimit?: number | null;
}) {
  const analyseVideo = jest.fn().mockResolvedValue({ transcript: 'hi', duration: 10, wordCount: 1, filename: 'a.mp4' });
  const videoAnalysisService = { analyseVideo } as any;

  const entitlementsService = {
    getUserEntitlements: jest.fn().mockResolvedValue({
      tier: 'free',
      entitlements: { maxVideoAnalysesPerMonth: opts.maxVideoAnalysesPerMonth },
    }),
  } as any;

  const getStatus = jest.fn().mockResolvedValue({
    used: 0,
    limit: opts.statusLimit ?? opts.maxVideoAnalysesPerMonth,
    remaining: 0,
    canUse: opts.statusCanUse ?? true,
  });
  const tryConsume = jest.fn().mockResolvedValue({ used: 1, limit: opts.maxVideoAnalysesPerMonth, remaining: 0, canUse: true });
  const usageService = { getStatus, tryConsume } as any;

  const controller = new VideoAnalysisController(videoAnalysisService, entitlementsService, usageService);
  return { controller, analyseVideo, tryConsume, getStatus };
}

const fakeFile = { mimetype: 'video/mp4' } as Express.Multer.File;

describe('VideoAnalysisController — entitlement gating', () => {
  it('blocks with the upgrade message when the tier has zero video analyses, without running analysis', async () => {
    const { controller, analyseVideo, tryConsume } = createController({ maxVideoAnalysesPerMonth: 0 });

    await expect(controller.analyseVideo('user-1', fakeFile)).rejects.toThrow(
      new ForbiddenException('Upgrade your account to use this feature.'),
    );
    expect(analyseVideo).not.toHaveBeenCalled();
    expect(tryConsume).not.toHaveBeenCalled();
  });

  it('blocks with a quota-exhausted message when the monthly cap is already hit', async () => {
    const { controller, analyseVideo } = createController({
      maxVideoAnalysesPerMonth: 2,
      statusCanUse: false,
      statusLimit: 2,
    });

    await expect(controller.analyseVideo('user-1', fakeFile)).rejects.toThrow(
      "You've used all 2 video analyses included in your plan this month. Upgrade for more.",
    );
    expect(analyseVideo).not.toHaveBeenCalled();
  });

  it('runs the analysis and consumes quota when entitled and under the cap', async () => {
    const { controller, analyseVideo, tryConsume } = createController({
      maxVideoAnalysesPerMonth: 2,
      statusCanUse: true,
    });

    const result = await controller.analyseVideo('user-1', fakeFile);

    expect(analyseVideo).toHaveBeenCalledWith(fakeFile);
    expect(tryConsume).toHaveBeenCalledWith('user-1', 'video_analyses', 1, 2);
    expect(result).toEqual({ data: { transcript: 'hi', duration: 10, wordCount: 1, filename: 'a.mp4' } });
  });
});

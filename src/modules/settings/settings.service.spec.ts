import { SettingsService } from './settings.service';

function createFakeKnex(overrides: {
  existingPreferences?: any;
  insertedRow?: any;
  updatedRow?: any;
}) {
  const chain: any = {
    where: jest.fn().mockReturnThis(),
    first: jest.fn().mockResolvedValue(overrides.existingPreferences),
    insert: jest.fn().mockReturnValue({
      returning: jest.fn().mockResolvedValue([overrides.insertedRow]),
    }),
    update: jest.fn().mockReturnValue({
      returning: jest.fn().mockResolvedValue([overrides.updatedRow]),
    }),
  };
  const knexLike: any = jest.fn(() => chain);
  return { knexLike, chain };
}

const uploadServiceStub = {} as any;

describe('SettingsService.getSupportedLanguages', () => {
  it('returns every canonical code with a display name, sourced from the shared registry', () => {
    const { knexLike } = createFakeKnex({});
    const service = new SettingsService(knexLike, uploadServiceStub);

    const languages = service.getSupportedLanguages();

    expect(languages).toEqual(
      expect.arrayContaining([
        { code: 'en', name: 'English' },
        { code: 'yo', name: 'Yoruba' },
        { code: 'zh-Hans', name: 'Simplified Chinese' },
      ]),
    );
    expect(languages).toHaveLength(9);
  });
});

describe('SettingsService — AI preferences language handling', () => {
  describe('getAiPreferences', () => {
    it('normalizes a legacy/garbage stored language value to a canonical code', async () => {
      const { knexLike } = createFakeKnex({
        existingPreferences: { response_length: 'balanced', tone: 'professional', language: 'Chinese' },
      });
      const service = new SettingsService(knexLike, uploadServiceStub);

      const prefs = await service.getAiPreferences('user-1');

      expect(prefs.language).toBe('zh-Hans');
    });

    it('creates default preferences (English) when none exist yet', async () => {
      const { knexLike } = createFakeKnex({
        existingPreferences: undefined,
        insertedRow: { response_length: 'balanced', tone: 'professional', language: 'en' },
      });
      const service = new SettingsService(knexLike, uploadServiceStub);

      const prefs = await service.getAiPreferences('user-1');

      expect(prefs.language).toBe('en');
    });
  });

  describe('getEffectiveLanguage', () => {
    it('returns the normalized saved language for an existing user', async () => {
      const { knexLike } = createFakeKnex({
        existingPreferences: { language: 'fr' },
      });
      const service = new SettingsService(knexLike, uploadServiceStub);

      await expect(service.getEffectiveLanguage('user-1')).resolves.toBe('fr');
    });

    it('defaults to English when the user has no preferences row at all', async () => {
      const { knexLike } = createFakeKnex({ existingPreferences: undefined });
      const service = new SettingsService(knexLike, uploadServiceStub);

      await expect(service.getEffectiveLanguage('guest-ish-user')).resolves.toBe('en');
    });
  });

  describe('updateAiPreferences', () => {
    it('writes only the language field and preserves the other saved preferences', async () => {
      const { knexLike, chain } = createFakeKnex({
        existingPreferences: { response_length: 'detailed', tone: 'friendly', language: 'en' },
        updatedRow: { response_length: 'detailed', tone: 'friendly', language: 'de' },
      });
      const service = new SettingsService(knexLike, uploadServiceStub);

      const result = await service.updateAiPreferences('user-1', { language: 'de' } as any);

      expect(chain.update).toHaveBeenCalledWith(
        expect.objectContaining({ language: 'de' }),
      );
      expect(chain.update.mock.calls[0][0]).not.toHaveProperty('response_length');
      expect(chain.update.mock.calls[0][0]).not.toHaveProperty('tone');
      expect(result.responseLength).toBe('detailed');
      expect(result.tone).toBe('friendly');
      expect(result.language).toBe('de');
    });
  });
});

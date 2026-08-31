import { Logger } from '@nestjs/common';
import { HealthController } from './health.controller';

function createFakeResponse() {
  const res: { status: jest.Mock; json: jest.Mock; statusCode?: number; body?: unknown } = {
    status: jest.fn(),
    json: jest.fn(),
  };
  res.status.mockImplementation((code: number) => {
    res.statusCode = code;
    return res;
  });
  res.json.mockImplementation((body: unknown) => {
    res.body = body;
    return res;
  });
  return res as unknown as { status: jest.Mock; json: jest.Mock; statusCode: number; body: any };
}

describe('HealthController', () => {
  let knex: { raw: jest.Mock; migrate: { currentVersion: jest.Mock } };
  let controller: HealthController;

  beforeEach(() => {
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    knex = {
      raw: jest.fn(),
      migrate: { currentVersion: jest.fn().mockResolvedValue('20260831000044') },
    };
    controller = new HealthController(knex as any);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('live() always returns 200 without touching the database', () => {
    const result = controller.live();
    expect(result.status).toBe('alive');
    expect(knex.raw).not.toHaveBeenCalled();
  });

  it('ready() returns 200 when the database check succeeds', async () => {
    knex.raw.mockResolvedValue(undefined);
    const res = createFakeResponse();

    await controller.ready(res as any);

    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.body).toEqual({ status: 'ready', checks: { database: 'ok' } });
  });

  it('ready() returns 503 when the database check fails, with no raw error text', async () => {
    knex.raw.mockRejectedValue(new Error('password authentication failed for user "postgres"'));
    const res = createFakeResponse();

    await controller.ready(res as any);

    expect(res.status).toHaveBeenCalledWith(503);
    expect(res.body).toEqual({ status: 'not_ready', checks: { database: 'unavailable' } });
    expect(JSON.stringify(res.body)).not.toContain('password authentication');
  });

  it('checkDatabaseRoute() (legacy /health/db) returns 503 on failure, not 200', async () => {
    knex.raw.mockRejectedValue(new Error('connection refused'));
    const res = createFakeResponse();

    await controller.checkDatabaseRoute(res as any);

    expect(res.status).toHaveBeenCalledWith(503);
    expect(res.body.status).toBe('error');
    expect(res.body.database).toBe('disconnected');
    expect(JSON.stringify(res.body)).not.toContain('connection refused');
  });

  it('version() reports gitSha/processStartedAt even when migration lookup fails', async () => {
    knex.migrate.currentVersion.mockRejectedValue(new Error('no migrations table'));

    const result = await controller.version();

    expect(typeof result.gitSha).toBe('string');
    expect(typeof result.processStartedAt).toBe('string');
    expect(result.migrationVersion).toBeNull();
  });
});

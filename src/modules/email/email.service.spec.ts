import { ConfigService } from '@nestjs/config';
import { EmailService } from './email.service';

const sendMock = jest.fn();
jest.mock('resend', () => ({
  Resend: jest.fn().mockImplementation(() => ({
    emails: { send: (...args: unknown[]) => sendMock(...args) },
  })),
}));

jest.mock('nodemailer', () => ({
  createTransport: jest.fn(),
}));

function createService(resendApiKey: string | undefined = 'test-key') {
  const configService = {
    get: jest.fn((key: string) => {
      const values: Record<string, unknown> = {
        'email.resendApiKey': resendApiKey,
        'email.fromName': 'CognIX AI',
        'email.from': 'noreply@cognixai.ca',
        'app.frontendUrl': 'https://cognixai.ca',
      };
      return values[key];
    }),
  } as unknown as ConfigService;
  return new EmailService(configService);
}

describe('EmailService.sendConversationSummaryEmail', () => {
  beforeEach(() => {
    sendMock.mockReset().mockResolvedValue({ data: { id: 'email-1' }, error: null });
  });

  it('sends a PDF attachment with the conversation name in the subject', async () => {
    const service = createService();
    const pdf = Buffer.from('pdf-bytes');

    await service.sendConversationSummaryEmail('user@example.com', 'Lagos Weather Forecast', {
      filename: 'lagos-weather-forecast.pdf',
      content: pdf,
    });

    expect(sendMock).toHaveBeenCalledWith(
      expect.objectContaining({
        to: 'user@example.com',
        subject: 'Your summary is here for Lagos Weather Forecast',
        attachments: [{ filename: 'lagos-weather-forecast.pdf', content: pdf }],
      }),
    );
  });

  it('includes the conversation name in the email body too', async () => {
    const service = createService();

    await service.sendConversationSummaryEmail('user@example.com', 'Lagos Weather Forecast', {
      filename: 'x.pdf',
      content: Buffer.from('x'),
    });

    const call = sendMock.mock.calls[0][0];
    expect(call.html).toContain('Lagos Weather Forecast');
  });
});

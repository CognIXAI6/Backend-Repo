import { Injectable, Logger, BadRequestException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { tavily } from '@tavily/core';

export interface CrawlResult {
  url: string;
  title: string;
  content: string;
  charCount: number;
}

const MAX_CONTENT_CHARS = 120_000;

@Injectable()
export class WebCrawlService {
  private readonly logger = new Logger(WebCrawlService.name);
  private readonly client: ReturnType<typeof tavily> | null = null;

  constructor(private readonly config: ConfigService) {
    const key = this.config.get<string>('voice.tavilyApiKey');
    if (key) {
      this.client = tavily({ apiKey: key });
    } else {
      this.logger.warn('TAVILY_API_KEY not set — link attachment disabled');
    }
  }

  async extractUrl(rawUrl: string): Promise<CrawlResult> {
    const url = this.parseUrl(rawUrl);

    if (!this.client) {
      throw new BadRequestException(
        'Link attachment is not configured on this server. Please contact support.',
      );
    }

    let response: Awaited<ReturnType<ReturnType<typeof tavily>['extract']>>;
    try {
      response = await this.client.extract([url], {
        extractDepth: 'advanced',
      });
    } catch (err: any) {
      this.logger.error(`Tavily extract failed for "${url}":`, err);
      throw new BadRequestException(this.mapNetworkError(err));
    }

    if (response.failedResults?.length && !response.results?.length) {
      const reason = response.failedResults[0]?.error ?? '';
      this.logger.warn(`Tavily could not extract "${url}": ${reason}`);
      throw new BadRequestException(this.mapTavilyError(url, reason));
    }

    const result = response.results?.[0];
    const raw = result?.rawContent?.trim() ?? '';

    if (!raw) {
      throw new BadRequestException(
        `No readable text found at that URL. The page may require a login, be behind a paywall, or contain only images/video.`,
      );
    }

    const title = result?.title?.trim() || new URL(url).hostname;
    const content =
      raw.length > MAX_CONTENT_CHARS
        ? raw.slice(0, MAX_CONTENT_CHARS) +
          `\n\n_[Content truncated at ${MAX_CONTENT_CHARS.toLocaleString()} characters]_`
        : raw;

    return { url, title, content, charCount: content.length };
  }

  private parseUrl(raw: string): string {
    const trimmed = raw.trim();
    // Prepend https:// if missing a scheme
    const withScheme = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
    try {
      const parsed = new URL(withScheme);
      if (!['http:', 'https:'].includes(parsed.protocol)) {
        throw new Error('unsupported protocol');
      }
      return parsed.href;
    } catch {
      throw new BadRequestException(
        `"${raw}" doesn't look like a valid website URL. Please paste the full address, e.g. https://example.com`,
      );
    }
  }

  private mapNetworkError(err: any): string {
    const msg: string = (err?.message ?? '').toLowerCase();
    if (msg.includes('timeout') || msg.includes('timed out')) {
      return 'The page took too long to respond. Please try again or try a different URL.';
    }
    if (msg.includes('enotfound') || msg.includes('dns') || msg.includes('not found')) {
      return "That website couldn't be found. Please check the URL and try again.";
    }
    if (msg.includes('econnrefused') || msg.includes('connection refused')) {
      return 'The website refused the connection. It may be offline or blocking automated access.';
    }
    if (msg.includes('certificate') || msg.includes('ssl') || msg.includes('tls')) {
      return 'The website has an invalid security certificate and could not be accessed.';
    }
    return 'Something went wrong while trying to access that URL. Please check the link and try again.';
  }

  private mapTavilyError(url: string, reason: string): string {
    const r = reason.toLowerCase();
    if (r.includes('403') || r.includes('forbidden') || r.includes('blocked')) {
      return 'That website blocked access to its content. Try copying and pasting the text manually instead.';
    }
    if (r.includes('401') || r.includes('unauthorized') || r.includes('login') || r.includes('auth')) {
      return 'That page requires you to be logged in. Only publicly accessible pages can be attached.';
    }
    if (r.includes('404') || r.includes('not found')) {
      return `The page at ${url} doesn't exist (404). Please check the URL.`;
    }
    if (r.includes('429') || r.includes('rate limit') || r.includes('too many')) {
      return 'That website is temporarily limiting access. Please try again in a few minutes.';
    }
    if (r.includes('paywall') || r.includes('subscription') || r.includes('premium')) {
      return 'That page is behind a paywall. Only publicly accessible pages can be attached.';
    }
    if (r.includes('timeout')) {
      return 'The page took too long to respond. Please try again or use a different URL.';
    }
    return "Couldn't read content from that URL. Make sure it's a public webpage and try again.";
  }
}

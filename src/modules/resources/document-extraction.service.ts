import { Injectable, Logger, BadRequestException } from '@nestjs/common';
import * as mammoth from 'mammoth';
import { PDFParse } from 'pdf-parse';

const SUPPORTED_MIME_TYPES = [
  'application/pdf',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'text/plain',
  'text/markdown',
];

// Trim to ~120k chars (~30k tokens) to stay within context limits.
const MAX_CONTENT_CHARS = 120_000;

@Injectable()
export class DocumentExtractionService {
  private readonly logger = new Logger(DocumentExtractionService.name);

  /**
   * Extracts text from a PDF, DOCX, DOC, or plain-text buffer and returns it
   * as a clean Markdown string. Throws BadRequestException for unsupported types.
   */
  async extract(buffer: Buffer, mimeType: string, filename: string): Promise<string> {
    if (!SUPPORTED_MIME_TYPES.includes(mimeType)) {
      throw new BadRequestException(
        `Cannot extract text from "${filename}". Supported formats: PDF, DOCX, DOC, TXT.`,
      );
    }

    let raw = '';

    try {
      if (mimeType === 'application/pdf') {
        raw = await this.extractPdf(buffer);
      } else if (
        mimeType === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' ||
        mimeType === 'application/msword'
      ) {
        raw = await this.extractDocx(buffer);
      } else {
        // plain-text / markdown
        raw = buffer.toString('utf-8');
      }
    } catch (err) {
      this.logger.error(`Text extraction failed for "${filename}":`, err);
      throw new BadRequestException(`Failed to read "${filename}". The file may be corrupt or password-protected.`);
    }

    return this.toMarkdown(raw, filename);
  }

  private async extractPdf(buffer: Buffer): Promise<string> {
    const parser = new PDFParse({ data: buffer });
    const result = await parser.getText();
    return result.text ?? '';
  }

  private async extractDocx(buffer: Buffer): Promise<string> {
    const result = await mammoth.extractRawText({ buffer });
    if (result.messages?.length) {
      this.logger.debug('mammoth messages:', result.messages.map((m) => m.message).join('; '));
    }
    return result.value ?? '';
  }

  /**
   * Converts raw extracted text into clean Markdown.
   * Preserves headings (ALL-CAPS lines), bullet hints, and paragraph structure.
   */
  private toMarkdown(raw: string, filename: string): string {
    const lines = raw
      .replace(/\r\n/g, '\n')
      .replace(/\r/g, '\n')
      .split('\n');

    const mdLines: string[] = [];
    let blankRun = 0;

    for (const line of lines) {
      const trimmed = line.trim();

      if (!trimmed) {
        blankRun++;
        // Allow at most one blank line between paragraphs.
        if (blankRun === 1) mdLines.push('');
        continue;
      }

      blankRun = 0;

      // Heuristic: short ALL-CAPS lines (≤ 80 chars) look like section headings.
      if (trimmed.length <= 80 && trimmed === trimmed.toUpperCase() && /[A-Z]{3,}/.test(trimmed)) {
        mdLines.push(`\n## ${this.toTitleCase(trimmed)}\n`);
        continue;
      }

      // Bullet hints — lines starting with -, •, *, numbers followed by . or )
      if (/^[-•*]/.test(trimmed)) {
        mdLines.push(`- ${trimmed.replace(/^[-•*]\s*/, '')}`);
        continue;
      }
      if (/^\d+[.)]\s/.test(trimmed)) {
        mdLines.push(trimmed);
        continue;
      }

      mdLines.push(trimmed);
    }

    const body = mdLines.join('\n').replace(/\n{3,}/g, '\n\n').trim();

    // Truncate to MAX_CONTENT_CHARS with a trailing notice.
    const truncated =
      body.length > MAX_CONTENT_CHARS
        ? body.slice(0, MAX_CONTENT_CHARS) +
          `\n\n_[Document truncated at ${MAX_CONTENT_CHARS.toLocaleString()} characters for context efficiency]_`
        : body;

    return `# ${filename}\n\n${truncated}`;
  }

  private toTitleCase(str: string): string {
    return str
      .toLowerCase()
      .replace(/\b\w/g, (c) => c.toUpperCase());
  }
}

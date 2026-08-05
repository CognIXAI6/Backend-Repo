import {
  Controller,
  Get,
  Post,
  Patch,
  Delete,
  Param,
  Body,
  Query,
  UseGuards,
  UseInterceptors,
  UploadedFile,
  HttpCode,
  HttpStatus,
  BadRequestException,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { ConversationService } from '@/modules/voice/services/conversation.service';
import { DocumentExtractionService } from '@/modules/resources/document-extraction.service';
import { UploadService, UploadFolder } from '@/modules/upload/upload.service';
import { JwtAuthGuard, CurrentUser } from '@/common';

const CONVERSATION_DOC_SIZE_LIMIT = 20 * 1024 * 1024; // 20 MB
const CONVERSATION_IMG_SIZE_LIMIT = 10 * 1024 * 1024; // 10 MB

const SUPPORTED_IMAGE_TYPES = new Set([
  'image/jpeg',
  'image/jpg',
  'image/png',
  'image/gif',
  'image/webp',
]);

// Claude vision media_type whitelist (Anthropic API requirement)
const CLAUDE_MEDIA_TYPE: Record<string, 'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp'> = {
  'image/jpeg': 'image/jpeg',
  'image/jpg':  'image/jpeg',
  'image/png':  'image/png',
  'image/gif':  'image/gif',
  'image/webp': 'image/webp',
};

@Controller('conversations')
@UseGuards(JwtAuthGuard)
export class ConversationsController {
  constructor(
    private readonly conversationService: ConversationService,
    private readonly extractionService: DocumentExtractionService,
    private readonly uploadService: UploadService,
  ) {}

  /**
   * GET /conversations
   * Paginated list of the user's conversations, newest first.
   */
  @Get()
  async getHistory(
    @CurrentUser('id') userId: string,
    @Query('page') page?: string,
    @Query('limit') limit?: string,
  ) {
    return this.conversationService.getHistory(
      userId,
      page ? Number(page) : 1,
      limit ? Math.min(Number(limit), 100) : 20,
    );
  }

  @Get(':id')
  async getConversation(
    @CurrentUser('id') userId: string,
    @Param('id') conversationId: string,
  ) {
    return this.conversationService.getConversation(conversationId, userId);
  }

  @Get(':id/messages')
  async getMessages(
    @CurrentUser('id') userId: string,
    @Param('id') conversationId: string,
  ) {
    return this.conversationService.getConversationMessages(conversationId, userId);
  }

  @Patch(':id')
  async rename(
    @CurrentUser('id') userId: string,
    @Param('id') conversationId: string,
    @Body('title') title: string,
  ) {
    return this.conversationService.renameConversation(conversationId, userId, title);
  }

  /**
   * POST /conversations/:id/documents
   * Unified file attachment endpoint — handles both documents and images.
   * If the uploaded file is an image (JPEG, PNG, GIF, WebP) it is stored for
   * Claude Vision (include-once). Otherwise text is extracted and injected into
   * every subsequent AI call.
   */
  @Post(':id/documents')
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: CONVERSATION_DOC_SIZE_LIMIT } }))
  async attachDocument(
    @CurrentUser('id') userId: string,
    @Param('id') conversationId: string,
    @UploadedFile() file: Express.Multer.File,
    @Body('instruction') instruction?: string,
  ) {
    if (!file) throw new BadRequestException('No file uploaded');
    await this.conversationService.assertOwnership(conversationId, userId);

    // ── Image path ───────────────────────────────────────────────────────────
    if (SUPPORTED_IMAGE_TYPES.has(file.mimetype)) {
      const mediaType = CLAUDE_MEDIA_TYPE[file.mimetype];

      if (file.buffer.length > CONVERSATION_IMG_SIZE_LIMIT) {
        throw new BadRequestException('Image exceeds the 10 MB limit.');
      }

      const uploaded = await this.uploadService.uploadBuffer(
        file.buffer,
        UploadFolder.RESOURCES,
        `conv-img-${conversationId}-${Date.now()}`,
        'image',
      );

      await this.conversationService.saveConversationImage({
        conversationId,
        userId,
        filename: file.originalname,
        mimeType: mediaType,
        fileUrl: uploaded.secure_url,
        imageBase64: file.buffer.toString('base64'),
      });

      const announcement =
        `🖼️ **${file.originalname}** was attached to this conversation.` +
        (instruction ? `\n\n**Your instruction:** ${instruction}` : '') +
        `\n\nClaude will analyse this image when you send your next message.`;

      await this.conversationService.saveMessage({
        conversationId,
        role: 'assistant',
        content: announcement,
      });

      return {
        type: 'image',
        filename: file.originalname,
        fileUrl: uploaded.secure_url,
        mimeType: mediaType,
        message: `Image attached. Ask anything about "${file.originalname}" and Claude will analyse it.`,
      };
    }

    // ── Document path ────────────────────────────────────────────────────────
    const contentMarkdown = await this.extractionService.extract(
      file.buffer,
      file.mimetype,
      file.originalname,
    );

    const doc = await this.conversationService.saveConversationDocument({
      conversationId,
      userId,
      filename: file.originalname,
      mimeType: file.mimetype,
      fileUrl: null,
      contentMarkdown,
    });

    const announcement =
      `📄 **${file.originalname}** was attached to this conversation (${doc.charCount.toLocaleString()} characters extracted).` +
      (instruction ? `\n\n**Your instruction:** ${instruction}` : '') +
      `\n\nYou can now ask questions about this document.`;

    await this.conversationService.saveMessage({
      conversationId,
      role: 'assistant',
      content: announcement,
    });

    return {
      type: 'document',
      documentId: doc.id,
      filename: doc.filename,
      charCount: doc.charCount,
      message: `Document attached. Ask any questions about "${file.originalname}".`,
    };
  }

  @Get(':id/documents')
  async listDocuments(
    @CurrentUser('id') userId: string,
    @Param('id') conversationId: string,
  ) {
    await this.conversationService.assertOwnership(conversationId, userId);
    return this.conversationService.listConversationDocuments(conversationId);
  }

  /**
   * POST /conversations/:id/images
   * Upload a JPEG, PNG, GIF, or WebP image.
   *
   * The image is stored as base64 and sent to Claude Vision on the FIRST AI
   * call after upload (include-once strategy).  Subsequent messages in the
   * same conversation do not re-pay the vision token cost, but Claude's reply
   * carries the context forward naturally.
   */
  @Post(':id/images')
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: CONVERSATION_IMG_SIZE_LIMIT } }))
  async attachImage(
    @CurrentUser('id') userId: string,
    @Param('id') conversationId: string,
    @UploadedFile() file: Express.Multer.File,
    @Body('instruction') instruction?: string,
  ) {
    if (!file) throw new BadRequestException('No file uploaded');

    const mediaType = CLAUDE_MEDIA_TYPE[file.mimetype];
    if (!mediaType || !SUPPORTED_IMAGE_TYPES.has(file.mimetype)) {
      throw new BadRequestException(
        `Unsupported image type "${file.mimetype}". Supported: JPEG, PNG, GIF, WebP.`,
      );
    }

    await this.conversationService.assertOwnership(conversationId, userId);

    // Upload to Cloudinary for persistent URL (display / download).
    const uploaded = await this.uploadService.uploadBuffer(
      file.buffer,
      UploadFolder.RESOURCES,
      `conv-img-${conversationId}-${Date.now()}`,
      'image',
    );

    // Convert buffer to base64 for Claude Vision — stored in DB so we never
    // need to re-download at inference time.
    const imageBase64 = file.buffer.toString('base64');

    await this.conversationService.saveConversationImage({
      conversationId,
      userId,
      filename: file.originalname,
      mimeType: mediaType,
      fileUrl: uploaded.secure_url,
      imageBase64,
    });

    // Announcement message in chat history.
    const announcement =
      `🖼️ **${file.originalname}** was attached to this conversation.` +
      (instruction ? `\n\n**Your instruction:** ${instruction}` : '') +
      `\n\nClaude will analyse this image when you send your next message.`;

    await this.conversationService.saveMessage({
      conversationId,
      role: 'assistant',
      content: announcement,
    });

    return {
      filename: file.originalname,
      fileUrl: uploaded.secure_url,
      mimeType: mediaType,
      message: `Image attached. Ask anything about "${file.originalname}" and Claude will analyse it.`,
    };
  }

  /**
   * GET /conversations/:id/images
   * Lists all images ever attached to a conversation.
   */
  @Get(':id/images')
  async listImages(
    @CurrentUser('id') userId: string,
    @Param('id') conversationId: string,
  ) {
    await this.conversationService.assertOwnership(conversationId, userId);
    return this.conversationService.listConversationImages(conversationId);
  }

  /**
   * DELETE /conversations/empty
   * Removes all zero-message conversations for the current user.
   */
  @Delete('empty')
  @HttpCode(HttpStatus.OK)
  async purgeEmpty(@CurrentUser('id') userId: string) {
    const deleted = await this.conversationService.purgeEmptyConversations(userId);
    return { deleted, message: `${deleted} empty conversation(s) removed` };
  }

  @Delete(':id')
  @HttpCode(HttpStatus.OK)
  async delete(
    @CurrentUser('id') userId: string,
    @Param('id') conversationId: string,
  ) {
    await this.conversationService.deleteConversation(conversationId, userId);
    return { message: 'Conversation deleted' };
  }
}

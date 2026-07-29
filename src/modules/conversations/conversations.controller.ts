import {
  Controller,
  Get,
  Post,
  Patch,
  Delete,
  Param,
  Body,
  Query,
  Req,
  UseGuards,
  UseInterceptors,
  UploadedFile,
  HttpCode,
  HttpStatus,
  BadRequestException,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { Request } from 'express';
import { ConversationService } from '@/modules/voice/services/conversation.service';
import { DocumentExtractionService } from '@/modules/resources/document-extraction.service';
import { JwtAuthGuard, CurrentUser } from '@/common';

const CONVERSATION_DOC_SIZE_LIMIT = 20 * 1024 * 1024; // 20 MB

@Controller('conversations')
@UseGuards(JwtAuthGuard)
export class ConversationsController {
  constructor(
    private readonly conversationService: ConversationService,
    private readonly extractionService: DocumentExtractionService,
  ) {}

  /**
   * GET /conversations
   * Paginated list of the user's conversations, newest first.
   * Query params: page (default 1), limit (default 20)
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

  /**
   * GET /conversations/:id
   * Full conversation with all messages.
   */
  @Get(':id')
  async getConversation(
    @CurrentUser('id') userId: string,
    @Param('id') conversationId: string,
  ) {
    return this.conversationService.getConversation(conversationId, userId);
  }

  /**
   * GET /conversations/:id/messages
   * Messages only (no conversation metadata).
   */
  @Get(':id/messages')
  async getMessages(
    @CurrentUser('id') userId: string,
    @Param('id') conversationId: string,
  ) {
    return this.conversationService.getConversationMessages(conversationId, userId);
  }

  /**
   * PATCH /conversations/:id
   * Rename a conversation.
   * Body: { title: string }
   */
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
   * Upload a PDF, DOCX, or TXT file into the conversation context.
   * The text is extracted, converted to Markdown, and stored so the AI can
   * answer questions about its content in all subsequent messages.
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

    // Verify the user owns this conversation before attaching anything.
    await this.conversationService.assertOwnership(conversationId, userId);

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

    // Save an announcement message so the document appears in chat history.
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
      documentId: doc.id,
      filename: doc.filename,
      charCount: doc.charCount,
      message: `Document attached. Ask any questions about "${file.originalname}".`,
    };
  }

  /**
   * GET /conversations/:id/documents
   * Lists all documents attached to a conversation.
   */
  @Get(':id/documents')
  async listDocuments(
    @CurrentUser('id') userId: string,
    @Param('id') conversationId: string,
  ) {
    await this.conversationService.assertOwnership(conversationId, userId);
    return this.conversationService.listConversationDocuments(conversationId);
  }

  /**
   * DELETE /conversations/empty
   * Permanently removes all empty (no-message) conversations for the current user.
   * Call once to clean up duplicate "Untitled conversation" rows.
   */
  @Delete('empty')
  @HttpCode(HttpStatus.OK)
  async purgeEmpty(@CurrentUser('id') userId: string) {
    const deleted = await this.conversationService.purgeEmptyConversations(userId);
    return { deleted, message: `${deleted} empty conversation(s) removed` };
  }

  /**
   * DELETE /conversations/:id
   * Soft-deletes a conversation (not permanently removed).
   */
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

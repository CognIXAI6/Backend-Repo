import {
  Controller,
  Get,
  Patch,
  Delete,
  Param,
  Body,
  Query,
  UseGuards,
  HttpCode,
  HttpStatus,
} from '@nestjs/common';
import { ConversationService } from '@/modules/voice/services/conversation.service';
import { JwtAuthGuard, CurrentUser } from '@/common';

@Controller('conversations')
@UseGuards(JwtAuthGuard)
export class ConversationsController {
  constructor(private readonly conversationService: ConversationService) {}

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

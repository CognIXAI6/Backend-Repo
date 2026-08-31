import { Body, Controller, Get, Param, Post, UseGuards } from '@nestjs/common';
import { JwtAuthGuard, CurrentUser } from '@/common';
import { ChatMessageService } from './chat-message.service';
import { SubmitMessageDto } from './dto/chat.dto';

@Controller('chat')
@UseGuards(JwtAuthGuard)
export class ChatController {
  constructor(private readonly chatMessageService: ChatMessageService) {}

  /**
   * Durable message acceptance, independent of any live voice/Socket.IO
   * session. Same clientMessageId + same text always returns the original
   * acceptance result; same clientMessageId + different text is a 409.
   */
  @Post('messages')
  async submitMessage(@CurrentUser('id') userId: string, @Body() dto: SubmitMessageDto) {
    return this.chatMessageService.submitMessage(userId, dto);
  }

  @Get('jobs/:jobId')
  async getJobStatus(@CurrentUser('id') userId: string, @Param('jobId') jobId: string) {
    return this.chatMessageService.getJobStatus(userId, jobId);
  }
}

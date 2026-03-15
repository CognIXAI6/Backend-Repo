import {
  Controller,
  Get,
  Delete,
  Patch,
  Param,
  Query,
  Body,
  HttpCode,
  HttpStatus,
  ParseUUIDPipe,
  ParseIntPipe,
  DefaultValuePipe,
} from '@nestjs/common';
import { IsString, IsNotEmpty } from 'class-validator';
import { ConversationService } from '../services/conversation.service';

class RenameConversationDto {
  @IsString()
  @IsNotEmpty()
  title!: string;
}

@Controller('conversations')
export class ConversationController {
  constructor(private readonly conversationService: ConversationService) {}

  @Get()
  getHistory(
    @Query('userId') userId: string,
    @Query('page', new DefaultValuePipe(1), ParseIntPipe) page: number,
    @Query('limit', new DefaultValuePipe(20), ParseIntPipe) limit: number,
  ) {
    return this.conversationService.getHistory(userId, page, limit);
  }

  @Get(':id')
  getConversation(
    @Param('id', ParseUUIDPipe) id: string,
    @Query('userId') userId: string,
  ) {
    return this.conversationService.getConversation(id, userId);
  }

  @Get(':id/messages')
  getMessages(
    @Param('id', ParseUUIDPipe) id: string,
    @Query('userId') userId: string,
  ) {
    return this.conversationService.getConversationMessages(id, userId);
  }

  @Patch(':id')
  rename(
    @Param('id', ParseUUIDPipe) id: string,
    @Query('userId') userId: string,
    @Body() body: RenameConversationDto,
  ) {
    return this.conversationService.renameConversation(id, userId, body.title);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  delete(
    @Param('id', ParseUUIDPipe) id: string,
    @Query('userId') userId: string,
  ) {
    return this.conversationService.deleteConversation(id, userId);
  }
}
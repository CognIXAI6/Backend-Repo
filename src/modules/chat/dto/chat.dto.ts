import { IsString, IsOptional, IsUUID, IsNotEmpty } from 'class-validator';

export class SubmitMessageDto {
  /**
   * Single idempotency identity for this command — stable across retries,
   * reconnects, and app restarts. The same key + same text always returns
   * the original acceptance result; the same key with different text is a
   * conflict.
   */
  @IsUUID()
  clientMessageId: string;

  @IsOptional()
  @IsUUID()
  conversationId?: string;

  @IsString()
  @IsNotEmpty()
  text: string;

  @IsOptional()
  @IsUUID()
  fieldId?: string;
}

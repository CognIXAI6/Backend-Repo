import { Controller, Post, Delete, Body, Req, UseGuards, HttpCode, HttpStatus } from '@nestjs/common';
import { Request } from 'express';
import { JwtAuthGuard } from '@/common/guards/jwt-auth.guard';
import { PushNotificationService } from './push-notification.service';

@Controller('notifications/push')
@UseGuards(JwtAuthGuard)
export class PushNotificationController {
  constructor(private readonly pushService: PushNotificationService) {}

  @Post('register')
  @HttpCode(HttpStatus.NO_CONTENT)
  async registerToken(
    @Req() req: Request,
    @Body('token') token: string,
    @Body('platform') platform?: 'web' | 'android' | 'ios',
  ) {
    const userId = (req.user as { userId: string }).userId;
    await this.pushService.registerToken(userId, token, platform ?? 'web');
  }

  @Delete('unregister')
  @HttpCode(HttpStatus.NO_CONTENT)
  async removeToken(@Req() req: Request, @Body('token') token: string) {
    const userId = (req.user as { userId: string }).userId;
    await this.pushService.removeToken(userId, token);
  }
}

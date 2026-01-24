import {
  Controller,
  Get,
  Post,
  Body,
  Param,
  UseGuards,
} from '@nestjs/common';
import { FieldsService } from './fields.service';
import { JwtAuthGuard, CurrentUser } from '@/common';

@Controller('fields')
export class FieldsController {
  constructor(private fieldsService: FieldsService) {}

  @Get()
  async getAllFields() {
    return this.fieldsService.findAll();
  }

  @Get('settings/:key')
  async getAppSetting(@Param('key') key: string) {
    return this.fieldsService.getAppSetting(key);
  }

  @Get('user-fields')
  @UseGuards(JwtAuthGuard)
  async getUserFields(@CurrentUser('id') userId: string) {
    return this.fieldsService.getUserFields(userId);
  }

  @Get('user-custom-fields')
  @UseGuards(JwtAuthGuard)
  async getUserCustomFields(@CurrentUser('id') userId: string) {
    return this.fieldsService.getUserCustomFields(userId);
  }

  @Post('select')
  @UseGuards(JwtAuthGuard)
  async selectField(
    @CurrentUser('id') userId: string,
    @Body('fieldId') fieldId: string,
    @Body('isPrimary') isPrimary: boolean = true,
  ) {
    return this.fieldsService.assignFieldToUser(userId, fieldId, isPrimary);
  }

  @Post('custom')
  @UseGuards(JwtAuthGuard)
  async createCustomField(
    @CurrentUser('id') userId: string,
    @Body('name') name: string,
    @Body('description') description?: string,
  ) {
    return this.fieldsService.createCustomField(userId, name, description);
  }
}

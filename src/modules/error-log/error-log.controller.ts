import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { ErrorLogService } from './error-log.service';
import { JwtAuthGuard } from '@/common';

/**
 * GET /admin/logs        — paginated error log
 * GET /admin/logs/stats  — error frequency breakdown by code/source
 *
 * Protected by JWT. In a production setup you'd add an admin-role guard here.
 */
@Controller('admin/logs')
@UseGuards(JwtAuthGuard)
export class ErrorLogController {
  constructor(private readonly errorLogService: ErrorLogService) {}

  @Get()
  async getLogs(
    @Query('page') page?: string,
    @Query('limit') limit?: string,
    @Query('source') source?: string,
    @Query('code') code?: string,
    @Query('severity') severity?: string,
  ) {
    return this.errorLogService.getAll({
      page: page ? Number(page) : 1,
      limit: limit ? Number(limit) : 50,
      source,
      code,
      severity,
    });
  }

  @Get('stats')
  async getStats() {
    return this.errorLogService.getStats();
  }
}

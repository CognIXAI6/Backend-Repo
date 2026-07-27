import {
  Controller, Get, Post, Patch, Delete,
  Body, Param, Query, Req,
  UseGuards, HttpCode, HttpStatus,
} from '@nestjs/common';
import { Request } from 'express';
import { AdminService, Period, AdminRole } from './admin.service';
import { AdminGuard } from './admin.guard';

function adminFromReq(req: Request): any {
  return (req as any).admin;
}

@Controller('admin')
export class AdminController {
  constructor(private adminService: AdminService) {}

  // ── Auth ───────────────────────────────────────────────────────────────────

  // Bootstrap endpoint — only works when zero admins exist.
  @Post('auth/bootstrap')
  @HttpCode(HttpStatus.CREATED)
  bootstrap(
    @Body('email') email: string,
    @Body('name') name: string,
    @Body('password') password: string,
  ) {
    return this.adminService.createFirstAdmin(email, name, password);
  }

  @Post('auth/login')
  @HttpCode(HttpStatus.OK)
  login(@Body('email') email: string, @Body('password') password: string) {
    return this.adminService.login(email, password);
  }

  @Get('auth/me')
  @UseGuards(AdminGuard)
  getMe(@Req() req: Request) {
    return this.adminService.getMe(adminFromReq(req).id);
  }

  @Post('auth/invite')
  @UseGuards(AdminGuard)
  invite(
    @Req() req: Request,
    @Body('email') email: string,
    @Body('name') name: string,
    @Body('role') role: AdminRole = 'admin',
  ) {
    return this.adminService.inviteAdmin(email, name, role, adminFromReq(req).id);
  }

  @Post('auth/resend-invitations')
  @UseGuards(AdminGuard)
  @HttpCode(HttpStatus.OK)
  resendPendingInvitations(@Req() req: Request) {
    return this.adminService.resendPendingInvitations(adminFromReq(req).id);
  }

  @Post('auth/accept-invite')
  @HttpCode(HttpStatus.CREATED)
  acceptInvite(@Body('token') token: string, @Body('password') password: string) {
    return this.adminService.acceptInvite(token, password);
  }

  @Get('auth/admins')
  @UseGuards(AdminGuard)
  listAdmins() {
    return this.adminService.listAdmins();
  }

  @Patch('auth/admins/:id/status')
  @UseGuards(AdminGuard)
  toggleAdminStatus(@Req() req: Request, @Param('id') id: string) {
    return this.adminService.toggleAdminStatus(id, adminFromReq(req).id);
  }

  // ── User management ────────────────────────────────────────────────────────

  @Get('users')
  @UseGuards(AdminGuard)
  getUsers(
    @Query('page') page = '1',
    @Query('limit') limit = '20',
    @Query('search') search?: string,
    @Query('tier') tier?: string,
    @Query('authProvider') authProvider?: string,
  ) {
    return this.adminService.getUsers({
      page: Number(page), limit: Number(limit), search, tier, authProvider,
    });
  }

  @Get('users/:id')
  @UseGuards(AdminGuard)
  getUserDetails(@Param('id') id: string) {
    return this.adminService.getUserDetails(id);
  }

  @Patch('users/:id/tier')
  @UseGuards(AdminGuard)
  updateUserTier(@Param('id') id: string, @Body('tier') tier: 'free' | 'premium') {
    return this.adminService.updateUserTier(id, tier);
  }

  @Patch('users/:id/status')
  @UseGuards(AdminGuard)
  toggleUserStatus(@Param('id') id: string) {
    return this.adminService.toggleUserStatus(id);
  }

  // ── Revenue ────────────────────────────────────────────────────────────────

  @Get('revenue/overview')
  @UseGuards(AdminGuard)
  revenueOverview(
    @Query('period') period: Period = '30d',
    @Query('displayCurrency') displayCurrency = 'USD',
  ) {
    return this.adminService.getRevenueOverview(period, displayCurrency.toUpperCase());
  }

  @Get('revenue/transactions')
  @UseGuards(AdminGuard)
  transactions(
    @Query('page') page = '1',
    @Query('limit') limit = '20',
    @Query('displayCurrency') displayCurrency = 'USD',
    @Query('provider') provider?: string,
  ) {
    return this.adminService.getTransactions({
      page: Number(page), limit: Number(limit),
      displayCurrency: displayCurrency.toUpperCase(),
      provider,
    });
  }

  @Get('revenue/by-currency')
  @UseGuards(AdminGuard)
  revenueByCurrency(@Query('displayCurrency') displayCurrency = 'USD') {
    return this.adminService.getRevenueByCurrency(displayCurrency.toUpperCase());
  }

  // ── Analytics ─────────────────────────────────────────────────────────────

  @Get('analytics/overview')
  @UseGuards(AdminGuard)
  appOverview(@Query('period') period: Period = '30d') {
    return this.adminService.getAppOverview(period);
  }

  @Get('analytics/ai')
  @UseGuards(AdminGuard)
  aiUsage(
    @Query('period') period: Period = '30d',
    @Query('displayCurrency') displayCurrency = 'USD',
  ) {
    return this.adminService.getAiUsage(period, displayCurrency.toUpperCase());
  }

  @Get('analytics/voice')
  @UseGuards(AdminGuard)
  voiceUsage(
    @Query('period') period: Period = '30d',
    @Query('displayCurrency') displayCurrency = 'USD',
  ) {
    return this.adminService.getVoiceUsage(period, displayCurrency.toUpperCase());
  }

  @Get('analytics/conversations')
  @UseGuards(AdminGuard)
  conversationAnalytics(@Query('period') period: Period = '30d') {
    return this.adminService.getConversationAnalytics(period);
  }

  @Get('analytics/errors')
  @UseGuards(AdminGuard)
  errorLogs(
    @Query('page') page = '1',
    @Query('limit') limit = '20',
    @Query('source') source?: string,
    @Query('severity') severity?: string,
  ) {
    return this.adminService.getErrorLogs({
      page: Number(page), limit: Number(limit), source, severity,
    });
  }
}

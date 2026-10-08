import {
  Controller, Get, Post, Patch, Delete,
  Body, Param, Query, Req,
  UseGuards, HttpCode, HttpStatus, NotFoundException,
} from '@nestjs/common';
import { Request } from 'express';
import { AdminService, Period, AdminRole } from './admin.service';
import { AdminGuard } from './admin.guard';
import { FieldsService } from '../fields/fields.service';
import { CreateFieldDto, UpdateFieldDto } from '../fields/dto/fields.dto';
import { AdminPlansService } from './admin-plans.service';
import { PlanType } from '../entitlements/entitlements.types';

function adminFromReq(req: Request): any {
  return (req as any).admin;
}

@Controller('admin')
export class AdminController {
  constructor(
    private adminService: AdminService,
    private fieldsService: FieldsService,
    private adminPlansService: AdminPlansService,
  ) {}

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
  updateUserTier(@Param('id') id: string, @Body('tier') tier: PlanType) {
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

  // ── Fields management ─────────────────────────────────────────────────────

  @Get('fields')
  @UseGuards(AdminGuard)
  listFields() {
    return this.fieldsService.findAllAdmin();
  }

  @Get('fields/:id')
  @UseGuards(AdminGuard)
  async getField(@Param('id') id: string) {
    const field = await this.fieldsService.findById(id);
    if (!field) throw new NotFoundException('Field not found');
    return field;
  }

  @Post('fields')
  @UseGuards(AdminGuard)
  @HttpCode(HttpStatus.CREATED)
  createField(@Body() dto: CreateFieldDto) {
    return this.fieldsService.createField(dto);
  }

  @Patch('fields/:id')
  @UseGuards(AdminGuard)
  updateField(@Param('id') id: string, @Body() dto: UpdateFieldDto) {
    return this.fieldsService.updateField(id, dto);
  }

  // Soft delete only — deactivates the field rather than removing the row.
  // See FieldsService.deactivateField for why a hard delete isn't offered.
  @Delete('fields/:id')
  @UseGuards(AdminGuard)
  @HttpCode(HttpStatus.OK)
  deactivateField(@Param('id') id: string) {
    return this.fieldsService.deactivateField(id);
  }

  // ── Plans & entitlements (pricing + what each tier unlocks) ───────────────
  // Everything here is what EntitlementsService and PaymentService read at
  // request/checkout time — nothing in the app is statically configured
  // once this is in place. Publishing to Stripe is a separate explicit step
  // (publishPlan) from editing the price (updatePlan).

  @Get('plans')
  @UseGuards(AdminGuard)
  listPlans() {
    return this.adminPlansService.listPlans();
  }

  @Post('plans')
  @UseGuards(AdminGuard)
  @HttpCode(HttpStatus.CREATED)
  createPlan(
    @Body('planType') planType: PlanType,
    @Body('billingCycle') billingCycle: 'monthly' | 'quarterly' | 'biannual' | 'yearly',
    @Body('amountCents') amountCents: number,
    @Body('label') label: string,
    @Body('currency') currency?: string,
    @Body('discountPercent') discountPercent?: number,
  ) {
    return this.adminPlansService.createPlan({ planType, billingCycle, amountCents, label, currency, discountPercent });
  }

  @Patch('plans/:id')
  @UseGuards(AdminGuard)
  updatePlan(
    @Param('id') id: string,
    @Body('amountCents') amountCents?: number,
    @Body('discountPercent') discountPercent?: number,
    @Body('label') label?: string,
    @Body('isActive') isActive?: boolean,
  ) {
    return this.adminPlansService.updatePlan(id, { amountCents, discountPercent, label, isActive });
  }

  // Mints a fresh Stripe Price for this plan's current amount/currency/cycle
  // and archives whatever Price it replaces — see StripeSyncService.
  @Post('plans/:id/publish')
  @UseGuards(AdminGuard)
  publishPlan(@Param('id') id: string) {
    return this.adminPlansService.publish(id);
  }

  @Post('plans/:id/price-overrides')
  @UseGuards(AdminGuard)
  setPlanPriceOverride(
    @Param('id') id: string,
    @Body('currency') currency: string,
    @Body('amount') amount: number,
  ) {
    return this.adminPlansService.setPriceOverride(id, currency, amount);
  }

  @Delete('plans/:id/price-overrides/:currency')
  @UseGuards(AdminGuard)
  clearPlanPriceOverride(@Param('id') id: string, @Param('currency') currency: string) {
    return this.adminPlansService.clearPriceOverride(id, currency);
  }

  @Get('plans/:planType/entitlements')
  @UseGuards(AdminGuard)
  getPlanEntitlements(@Param('planType') planType: PlanType) {
    return this.adminPlansService.getEntitlements(planType);
  }

  @Patch('plans/:planType/entitlements')
  @UseGuards(AdminGuard)
  updatePlanEntitlements(
    @Req() req: Request,
    @Param('planType') planType: PlanType,
    @Body() dto: Parameters<AdminPlansService['updateEntitlements']>[1],
  ) {
    return this.adminPlansService.updateEntitlements(planType, dto, adminFromReq(req).id);
  }
}

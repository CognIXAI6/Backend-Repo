import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Resend } from 'resend';
import * as nodemailer from 'nodemailer';

interface EmailOptions {
  to: string;
  subject: string;
  html: string;
  text?: string;
}

@Injectable()
export class EmailService {
  private readonly logger = new Logger(EmailService.name);
  private resend: Resend | null = null;
  private transporter: nodemailer.Transporter | null = null;

  constructor(private configService: ConfigService) {
    const resendApiKey = this.configService.get<string>('email.resendApiKey');
    
    if (resendApiKey) {
      this.resend = new Resend(resendApiKey);
    } else {
      // Fallback to nodemailer
      this.transporter = nodemailer.createTransport({
        host: this.configService.get('email.smtpHost'),
        port: this.configService.get('email.smtpPort'),
        auth: {
          user: this.configService.get('email.smtpUser'),
          pass: this.configService.get('email.smtpPassword'),
        },
      });
    }
  }

async sendEmail(options: EmailOptions): Promise<void> {
  const from = `${this.configService.get('email.fromName')} <${this.configService.get('email.from')}>`;
  
  this.logger.log(`Attempting to send email to ${options.to} from ${from}`);
  this.logger.log(`Using Resend: ${!!this.resend}, Using Nodemailer: ${!!this.transporter}`);

  try {
    if (this.resend) {
      const { data, error } = await this.resend.emails.send({
        from,
        to: options.to,
        subject: options.subject,
        html: options.html,
      });
      
      if (error) {
        this.logger.error(`Resend API error:`, error);
        throw new Error(`Resend failed: ${error.message}`);
      }
      
      this.logger.log(`Email sent via Resend. ID: ${data?.id}`);
    } else if (this.transporter) {
      const info = await this.transporter.sendMail({
          from,
          to: options.to,
          subject: options.subject,
          html: options.html,
          text: options.text,
        });
      this.logger.log(`Email sent via Nodemailer. MessageId: ${info.messageId}`);
    } else {
      throw new Error('No email transport configured');
    }
  } catch (error) {
    this.logger.error(`Failed to send email to ${options.to}:`, error);
    throw error;
  }
}


  async sendVerificationEmail(email: string, token: string, name?: string): Promise<void> {
    const frontendUrl = this.configService.get('app.frontendUrl');
    const verificationUrl = `${frontendUrl}/verify-email?token=${token}`;

    await this.sendEmail({
      to: email,
      subject: 'Verify your CognIX AI account',
      html: `
        <!DOCTYPE html>
        <html>
        <head>
          <style>
            body { font-family: Arial, sans-serif; line-height: 1.6; color: #333; }
            .container { max-width: 600px; margin: 0 auto; padding: 20px; }
            .button { display: inline-block; padding: 12px 24px; background-color: #2563eb; color: white; text-decoration: none; border-radius: 8px; }
            .footer { margin-top: 30px; font-size: 12px; color: #666; }
          </style>
        </head>
        <body>
          <div class="container">
            <h1>Welcome to CognIX AI${name ? `, ${name}` : ''}!</h1>
            <p>Thank you for signing up. Please verify your email address to get started.</p>
            <p><a href="${verificationUrl}" class="button">Verify Email</a></p>
            <p>Or copy and paste this link: ${verificationUrl}</p>
            <p>This link will expire in 24 hours.</p>
            <div class="footer">
              <p>If you didn't create an account, please ignore this email.</p>
            </div>
          </div>
        </body>
        </html>
      `,
    });
  }

  async sendPasswordResetEmail(email: string, token: string): Promise<void> {
    const frontendUrl = this.configService.get('app.frontendUrl');
    const resetUrl = `${frontendUrl}/reset-password?token=${token}`;

    await this.sendEmail({
      to: email,
      subject: 'Reset your CognIX AI password',
      html: `
        <!DOCTYPE html>
        <html>
        <head>
          <style>
            body { font-family: Arial, sans-serif; line-height: 1.6; color: #333; }
            .container { max-width: 600px; margin: 0 auto; padding: 20px; }
            .button { display: inline-block; padding: 12px 24px; background-color: #2563eb; color: white; text-decoration: none; border-radius: 8px; }
            .footer { margin-top: 30px; font-size: 12px; color: #666; }
          </style>
        </head>
        <body>
          <div class="container">
            <h1>Password Reset Request</h1>
            <p>We received a request to reset your password. Click the button below to create a new password.</p>
            <p><a href="${resetUrl}" class="button">Reset Password</a></p>
            <p>Or copy and paste this link: ${resetUrl}</p>
            <p>This link will expire in 1 hour.</p>
            <div class="footer">
              <p>If you didn't request a password reset, please ignore this email.</p>
            </div>
          </div>
        </body>
        </html>
      `,
    });
  }

  async sendRegistrationOtpEmail(email: string, otp: string): Promise<void> {
    await this.sendEmail({
      to: email,
      subject: 'Your CognIX AI Verification Code',
      html: `
        <!DOCTYPE html>
        <html>
        <head>
          <style>
            body { font-family: Arial, sans-serif; line-height: 1.6; color: #333; background-color: #f4f4f4; }
            .container { max-width: 600px; margin: 0 auto; padding: 20px; background-color: #ffffff; border-radius: 8px; }
            .otp-box { background-color: #f0f7ff; border: 2px dashed #2563eb; border-radius: 8px; padding: 20px; text-align: center; margin: 20px 0; }
            .otp-code { font-size: 36px; font-weight: bold; letter-spacing: 10px; color: #2563eb; font-family: 'Courier New', monospace; }
            .footer { margin-top: 30px; font-size: 12px; color: #666; }
            .warning { color: #dc2626; font-weight: 500; }
          </style>
        </head>
        <body>
          <div class="container">
            <h1>Welcome to CognIX AI!</h1>
            <p>Use the code below to verify your email and create your account.</p>
            <div class="otp-box">
              <p style="margin: 0 0 8px 0; color: #666;">Your verification code:</p>
              <p class="otp-code">${otp}</p>
            </div>
            <p class="warning">⚠️ This code expires in 10 minutes.</p>
            <p>If you didn't request this, you can safely ignore this email.</p>
            <div class="footer"><p>— The CognIX AI Team</p></div>
          </div>
        </body>
        </html>
      `,
    });
  }

  async sendLoginOtpEmail(email: string, otp: string, name?: string): Promise<void> {
    await this.sendEmail({
      to: email,
      subject: 'Your CognIX AI Login Code',
      html: `
        <!DOCTYPE html>
        <html>
        <head>
          <style>
            body { font-family: Arial, sans-serif; line-height: 1.6; color: #333; background-color: #f4f4f4; }
            .container { max-width: 600px; margin: 0 auto; padding: 20px; background-color: #ffffff; border-radius: 8px; }
            .otp-box { background-color: #f0f7ff; border: 2px dashed #2563eb; border-radius: 8px; padding: 20px; text-align: center; margin: 20px 0; }
            .otp-code { font-size: 36px; font-weight: bold; letter-spacing: 10px; color: #2563eb; font-family: 'Courier New', monospace; }
            .footer { margin-top: 30px; font-size: 12px; color: #666; }
            .warning { color: #dc2626; font-weight: 500; }
          </style>
        </head>
        <body>
          <div class="container">
            <h1>Welcome back${name ? `, ${name}` : ''}!</h1>
            <p>Here is your one-time sign-in code for CognIX AI.</p>
            <div class="otp-box">
              <p style="margin: 0 0 8px 0; color: #666;">Your sign-in code:</p>
              <p class="otp-code">${otp}</p>
            </div>
            <p class="warning">⚠️ This code expires in 10 minutes.</p>
            <p>If you didn't request this, please secure your account.</p>
            <div class="footer"><p>— The CognIX AI Team</p></div>
          </div>
        </body>
        </html>
      `,
    });
  }

  async sendAdminInvitationEmail(params: {
    to: string;
    name: string;
    invitedByName: string;
    role: string;
    token: string;
    acceptUrl: string;
    expiresAt: Date;
  }): Promise<void> {
    const { to, name, invitedByName, role, acceptUrl, expiresAt } = params;
    const roleLabel = role === 'super_admin' ? 'Super Admin' : 'Admin';
    const expiryText = expiresAt.toLocaleString('en-US', {
      weekday: 'long', month: 'long', day: 'numeric',
      hour: '2-digit', minute: '2-digit', timeZoneName: 'short',
    });

    await this.sendEmail({
      to,
      subject: `You've been invited to join CognIX Admin`,
      html: `
        <!DOCTYPE html>
        <html>
        <head>
          <style>
            body { font-family: Arial, sans-serif; line-height: 1.6; color: #333; background-color: #f4f4f4; margin: 0; padding: 0; }
            .container { max-width: 600px; margin: 0 auto; padding: 20px; background-color: #ffffff; border-radius: 8px; }
            .header { background: linear-gradient(135deg, #1a1a2e 0%, #16213e 100%); color: white; padding: 32px 24px; border-radius: 8px 8px 0 0; text-align: center; }
            .header h1 { margin: 0; font-size: 24px; letter-spacing: 1px; }
            .header p { margin: 8px 0 0; color: #a0aec0; font-size: 14px; }
            .body { padding: 32px 24px; }
            .role-badge {
              display: inline-block;
              background: #eff6ff;
              color: #2563eb;
              border: 1px solid #bfdbfe;
              border-radius: 20px;
              padding: 4px 16px;
              font-size: 13px;
              font-weight: 600;
              margin-bottom: 24px;
            }
            .cta-button {
              display: block;
              background: linear-gradient(135deg, #2563eb, #1d4ed8);
              color: white !important;
              text-decoration: none;
              padding: 16px 32px;
              border-radius: 8px;
              font-size: 16px;
              font-weight: 600;
              text-align: center;
              margin: 28px 0;
            }
            .info-box {
              background: #f8fafc;
              border: 1px solid #e2e8f0;
              border-radius: 8px;
              padding: 16px 20px;
              margin: 20px 0;
              font-size: 14px;
            }
            .info-box p { margin: 4px 0; color: #475569; }
            .expiry { color: #dc2626; font-weight: 600; }
            .footer { text-align: center; padding: 20px 24px; color: #94a3b8; font-size: 12px; border-top: 1px solid #e2e8f0; }
          </style>
        </head>
        <body>
          <div class="container">
            <div class="header">
              <h1>CognIX AI</h1>
              <p>Admin Portal Invitation</p>
            </div>
            <div class="body">
              <p>Hi <strong>${name}</strong>,</p>
              <p><strong>${invitedByName}</strong> has invited you to join the <strong>CognIX AI</strong> admin team.</p>

              <div class="role-badge">${roleLabel}</div>

              <p>Click the button below to set your password and activate your admin account:</p>

              <a href="${acceptUrl}" class="cta-button">Accept Invitation &amp; Set Password</a>

              <div class="info-box">
                <p><strong>Your invitation details:</strong></p>
                <p>Email: ${to}</p>
                <p>Role: ${roleLabel}</p>
                <p>Invited by: ${invitedByName}</p>
                <p class="expiry">Expires: ${expiryText}</p>
              </div>

              <p style="color:#64748b;font-size:13px;">
                If the button above doesn't work, copy and paste this link into your browser:<br>
                <span style="color:#2563eb;word-break:break-all;">${acceptUrl}</span>
              </p>

              <p style="color:#64748b;font-size:13px;">
                If you weren't expecting this invitation, you can safely ignore this email.
              </p>
            </div>
            <div class="footer">
              <p>CognIX AI &mdash; Admin Portal Invitation</p>
              <p>This invitation expires ${expiryText}</p>
            </div>
          </div>
        </body>
        </html>
      `,
    });
  }

  async sendAdminAlert(subject: string, body: string): Promise<void> {
    const adminEmail = 'cognixai6@gmail.com';
    await this.sendEmail({
      to: adminEmail,
      subject: `[CognIX Alert] ${subject}`,
      html: `
        <div style="font-family: Arial, sans-serif; padding: 20px; color: #333;">
          <h2 style="color: #dc2626;">⚠️ CognIX System Alert</h2>
          <pre style="background:#f4f4f4;padding:16px;border-radius:6px;font-size:13px;white-space:pre-wrap;">${body}</pre>
          <p style="color:#666;font-size:12px;margin-top:20px;">Sent automatically by CognIX API — ${new Date().toISOString()}</p>
        </div>
      `,
    });
  }

  async sendPasswordResetOtpEmail(email: string, otp: string): Promise<void> {
    await this.sendEmail({
      to: email,
      subject: 'Your CognIX AI Password Reset Code',
      html: `
        <!DOCTYPE html>
        <html>
        <head>
          <style>
            body { font-family: Arial, sans-serif; line-height: 1.6; color: #333; background-color: #f4f4f4; }
            .container { max-width: 600px; margin: 0 auto; padding: 20px; background-color: #ffffff; border-radius: 8px; }
            .otp-box { 
              background-color: #f0f7ff; 
              border: 2px dashed #2563eb; 
              border-radius: 8px; 
              padding: 20px; 
              text-align: center; 
              margin: 20px 0; 
            }
            .otp-code { 
              font-size: 32px; 
              font-weight: bold; 
              letter-spacing: 8px; 
              color: #2563eb; 
              font-family: 'Courier New', monospace;
            }
            .footer { margin-top: 30px; font-size: 12px; color: #666; }
            .warning { color: #dc2626; font-weight: 500; }
          </style>
        </head>
        <body>
          <div class="container">
            <h1>Password Reset Code</h1>
            <p>We received a request to reset your password. Use the code below to reset your password:</p>
            
            <div class="otp-box">
              <p style="margin: 0 0 10px 0; color: #666;">Your verification code is:</p>
              <p class="otp-code">${otp}</p>
            </div>
            
            <p class="warning">⚠️ This code will expire in 10 minutes.</p>
            <p>If you didn't request a password reset, please ignore this email or contact support if you have concerns.</p>
            
            <div class="footer">
              <p>For security reasons, never share this code with anyone.</p>
              <p>— The CognIX AI Team</p>
            </div>
          </div>
        </body>
        </html>
      `,
    });
  }
}

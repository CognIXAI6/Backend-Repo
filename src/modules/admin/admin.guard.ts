import {
  Injectable,
  CanActivate,
  ExecutionContext,
  UnauthorizedException,
  ForbiddenException,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import { Knex } from 'knex';
import { Inject } from '@nestjs/common';
import { KNEX_CONNECTION } from '@/database/database.module';

export interface AdminJwtPayload {
  sub: string;
  email: string;
  role: string;
  type: 'admin';
}

@Injectable()
export class AdminGuard implements CanActivate {
  constructor(
    private jwtService: JwtService,
    private configService: ConfigService,
    @Inject(KNEX_CONNECTION) private knex: Knex,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest();
    const authHeader: string | undefined = req.headers['authorization'];

    if (!authHeader?.startsWith('Bearer ')) {
      throw new UnauthorizedException('Admin token required');
    }

    const token = authHeader.slice(7);
    let payload: AdminJwtPayload;

    try {
      payload = this.jwtService.verify(token, {
        secret: this.configService.get<string>('jwt.secret'),
      });
    } catch {
      throw new UnauthorizedException('Invalid or expired admin token');
    }

    if (payload.type !== 'admin') {
      throw new ForbiddenException('Admin access only');
    }

    const admin = await this.knex('admins').where({ id: payload.sub, is_active: true }).first();
    if (!admin) {
      throw new UnauthorizedException('Admin account not found or deactivated');
    }

    req.admin = admin;
    return true;
  }
}

export const CurrentAdmin = () =>
  (target: object, key: string | symbol, descriptor: PropertyDescriptor) => descriptor;

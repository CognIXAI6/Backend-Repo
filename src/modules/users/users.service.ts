import { Injectable, Inject, NotFoundException } from '@nestjs/common';
import { Knex } from 'knex';
import { KNEX_CONNECTION } from '@/database/database.module';

export interface User {
  id: string;
  email: string;
  password: string;
  name: string | null;
  email_verified: boolean;
  onboarding_status: 'pending' | 'in_progress' | 'completed';
  subscription_tier: 'free' | 'premium';
  stripe_customer_id: string | null;
  created_at: Date;
  updated_at: Date;
}

export interface CreateUserDto {
  email: string;
  password: string;
}

export interface UpdateUserDto {
  name?: string;
  email_verified?: boolean;
  onboarding_status?: 'pending' | 'in_progress' | 'completed';
  subscription_tier?: 'free' | 'premium';
  stripe_customer_id?: string;
}

@Injectable()
export class UsersService {
  constructor(@Inject(KNEX_CONNECTION) private knex: Knex) {}

  async create(data: CreateUserDto): Promise<User> {
    const [user] = await this.knex('users').insert(data).returning('*');
    return user;
  }

  async findById(id: string): Promise<User | null> {
    return this.knex('users').where('id', id).first();
  }

  async findByEmail(email: string): Promise<User | null> {
    return this.knex('users').where('email', email.toLowerCase()).first();
  }

  async update(id: string, data: UpdateUserDto): Promise<User> {
    const [user] = await this.knex('users')
      .where('id', id)
      .update({ ...data, updated_at: new Date() })
      .returning('*');

    if (!user) {
      throw new NotFoundException('User not found');
    }

    return user;
  }

  async delete(id: string): Promise<void> {
    await this.knex('users').where('id', id).delete();
  }

  async getUserWithField(userId: string): Promise<any> {
    const user = await this.knex('users')
      .select('users.*', 'fields.name as field_name', 'fields.slug as field_slug')
      .leftJoin('user_fields', 'users.id', 'user_fields.user_id')
      .leftJoin('fields', 'user_fields.field_id', 'fields.id')
      .where('users.id', userId)
      .andWhere(function () {
        this.where('user_fields.is_primary', true).orWhereNull('user_fields.is_primary');
      })
      .first();

    return user;
  }

  sanitizeUser(user: User): Omit<User, 'password'> {
    const { password, ...sanitized } = user;
    return sanitized;
  }
}

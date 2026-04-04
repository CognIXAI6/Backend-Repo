import { Injectable, Inject, NotFoundException } from "@nestjs/common";
import { Knex } from "knex";
import { KNEX_CONNECTION } from "@/database/database.module";

export interface User {
  id: string;
  email: string;
  password: string | null;
  name: string | null;
  email_verified: boolean;
  auth_provider: 'email_otp' | 'clerk_oauth' | 'password';
  clerk_user_id: string | null;
  onboarding_status: "pending" | "in_progress" | "completed";
  subscription_tier: "free" | "premium";
  stripe_customer_id: string | null;
  avatar_url: string | null;
  voice_sample_skipped: boolean;
  voice_sample_completed_at: Date | null;
  deleted_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

export interface CreateUserDto {
  email: string;
  password?: string | null;
  name?: string | null;
  auth_provider?: 'email_otp' | 'clerk_oauth' | 'password';
  clerk_user_id?: string | null;
  avatar_url?: string | null;
  email_verified?: boolean;
}

export interface UpdateUserDto {
  name?: string;
  email_verified?: boolean;
  onboarding_status?: "pending" | "in_progress" | "completed";
  subscription_tier?: "free" | "premium";
  stripe_customer_id?: string;
  avatar_url?: string;
  voice_sample_skipped?: boolean;
  voice_sample_completed_at?: Date;
  clerk_user_id?: string;
  auth_provider?: 'email_otp' | 'clerk_oauth' | 'password';
}

@Injectable()
export class UsersService {
  constructor(@Inject(KNEX_CONNECTION) private knex: Knex) {}

  async create(data: CreateUserDto): Promise<User> {
    const [user] = await this.knex("users").insert(data).returning("*");
    return user;
  }

  async findById(id: string): Promise<User | null> {
    return this.knex("users").where("id", id).whereNull("deleted_at").first();
  }

  async findByEmail(email: string): Promise<User | null> {
    return this.knex("users")
      .where("email", email.toLowerCase())
      .whereNull("deleted_at")
      .first();
  }

  async findByClerkId(clerkUserId: string): Promise<User | null> {
    return this.knex("users")
      .where("clerk_user_id", clerkUserId)
      .whereNull("deleted_at")
      .first();
  }

  async update(id: string, data: UpdateUserDto): Promise<User> {
    const [user] = await this.knex("users")
      .where("id", id)
      .whereNull("deleted_at")
      .update({ ...data, updated_at: new Date() })
      .returning("*");

    if (!user) {
      throw new NotFoundException("User not found");
    }

    return user;
  }

  async delete(id: string): Promise<any> {
    const user = await this.knex("users")
      .where("id", id)
      .whereNull("deleted_at")
      .first();

    if (!user) {
      throw new NotFoundException("User not found");
    }

    await this.knex("users")
      .where("id", id)
      .update({ deleted_at: new Date(), updated_at: new Date() });

    return { message: 'Profile deleted successfully' };
  }

  async reactivate(id: string): Promise<any> {
    const user = await this.knex("users")
      .where("id", id)
      .whereNotNull("deleted_at")
      .first();

    if (!user) {
      throw new NotFoundException("User not found or is not deactivated");
    }

    await this.knex("users")
      .where("id", id)
      .update({ deleted_at: null, updated_at: new Date() });

    return { message: 'Profile activated successfully' };
  }

  async getUserWithField(userId: string): Promise<any> {
    const user = await this.knex("users")
      .select(
        "users.*",
        "fields.name as field_name",
        "fields.slug as field_slug",
      )
      .leftJoin("user_fields", "users.id", "user_fields.user_id")
      .leftJoin("fields", "user_fields.field_id", "fields.id")
      .where("users.id", userId)
      .whereNull("users.deleted_at")
      .andWhere(function () {
        this.where("user_fields.is_primary", true).orWhereNull(
          "user_fields.is_primary",
        );
      })
      .first();

    return user;
  }

  sanitizeUser(user: User): Omit<User, "password"> {
    const { password, ...sanitized } = user;
    return sanitized;
  }
}

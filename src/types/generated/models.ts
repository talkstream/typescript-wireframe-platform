/**
 * Generated domain model types from SQL schema
 * DO NOT EDIT MANUALLY - Generated by db:types command
 */

export interface User {
  id?: number;
  telegramId: number;
  firstName: string;
  lastName?: string;
  username?: string;
  starsBalance?: number;
  createdAt?: Date;
}

export interface TelegramPayment {
  id?: number;
  playerId: number;
  telegramPaymentChargeId: string;
  invoicePayload: string;
  paymentType: string;
  relatedEntityId?: string;
  starsAmount: number;
  status: string;
  createdAt?: Date;
  updatedAt?: Date;
}

export interface PendingInvoice {
  id?: number;
  playerId: number;
  invoiceType: string;
  targetMaskedId?: string;
  targetFaction?: string;
  starsAmount: number;
  invoiceLink?: string;
  expiresAt: Date;
  createdAt?: Date;
}

export interface UserRole {
  userId?: number;
  role: string;
  grantedBy?: number;
  grantedAt?: Date;
}

export interface AccessRequest {
  id?: number;
  userId: number;
  username?: string;
  firstName?: string;
  status: string;
  createdAt?: Date;
  processedBy?: number;
  processedAt?: Date;
}

export interface BotSetting {
  key?: string;
  value: string;
  updatedAt?: Date;
}

export interface UserRolesNew {
  userId?: string;
  platformId: string;
  platform: string;
  role: string;
  grantedBy?: string;
  grantedAt?: Date;
}

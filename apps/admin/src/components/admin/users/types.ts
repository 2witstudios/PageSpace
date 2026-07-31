import type { SubscriptionTier } from '@pagespace/lib/billing/subscription-tiers';

export type { SubscriptionTier };

export interface UserStats {
  drives: number;
  pages: number;
  chatMessages: number;
  globalMessages: number;
  totalMessages: number;
}

export interface SubscriptionData {
  id: string;
  stripeSubscriptionId: string;
  status: string;
  currentPeriodEnd: string;
  cancelAtPeriodEnd: boolean;
  isGifted: boolean;
  giftedBy?: string;
  giftReason?: string;
}

export interface AdminUser {
  id: string;
  name: string;
  email: string;
  emailVerified: string | null;
  image: string | null;
  currentAiProvider: string;
  currentAiModel: string;
  tokenVersion: number;
  subscriptionTier: SubscriptionTier;
  stripeCustomerId: string | null;
  role: 'user' | 'admin';
  suspendedAt: string | null;
  suspendedReason: string | null;
  createdAt: string;
  lastActiveAt: string | null;
  stats: UserStats;
  subscription: SubscriptionData | null;
}

export interface UsersSummary {
  totalUsers: number;
  verifiedUsers: number;
  dormantUsers: number;
  suspendedUsers: number;
  totalDrives: number;
  totalPages: number;
  totalMessages: number;
}

export interface UsersListResponse {
  users: AdminUser[];
  total: number;
  limit: number;
  offset: number;
  summary: UsersSummary;
}

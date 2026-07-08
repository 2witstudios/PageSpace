import type { SubscriptionTier } from './types';

export const DORMANT_DAYS = 30;

const TIER_LABELS: Record<SubscriptionTier, string> = {
  free: 'Free',
  pro: 'Pro',
  founder: 'Founder',
  business: 'Business',
};

export function tierLabel(tier: SubscriptionTier): string {
  return TIER_LABELS[tier] ?? tier;
}

export function formatDate(dateString: string | null): string {
  if (!dateString) return 'Never';
  return new Date(dateString).toLocaleDateString();
}

export function formatDateTime(dateString: string | null): string {
  if (!dateString) return 'Never';
  return new Date(dateString).toLocaleString();
}

export function formatLastActive(dateString: string | null): string {
  if (!dateString) return 'Never';
  const d = new Date(dateString);
  const diffDays = Math.floor((Date.now() - d.getTime()) / (1000 * 60 * 60 * 24));
  if (diffDays === 0) return 'Today';
  if (diffDays === 1) return 'Yesterday';
  if (diffDays < 30) return `${diffDays}d ago`;
  if (diffDays < 365) return `${Math.floor(diffDays / 30)}mo ago`;
  return `${Math.floor(diffDays / 365)}y ago`;
}

export function isDormant(lastActiveAt: string | null): boolean {
  if (!lastActiveAt) return true;
  const diffDays = (Date.now() - new Date(lastActiveAt).getTime()) / (1000 * 60 * 60 * 24);
  return diffDays > DORMANT_DAYS;
}

export function getUserInitials(name: string | null | undefined): string {
  if (!name) return 'U';
  return name
    .split(' ')
    .map(part => part.charAt(0))
    .join('')
    .toUpperCase()
    .slice(0, 2);
}

import { isValidEmail } from '@pagespace/lib/validators'

export type ValidationResult = {
  valid: boolean
  error?: string
}

const RESERVED_SLUGS = new Set([
  'www', 'api', 'app', 'admin', 'mail', 'ftp', 'traefik', 'status',
])

const SLUG_PATTERN = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/

export type Tier = 'free' | 'pro' | 'business' | 'enterprise'
export const VALID_TIERS: ReadonlySet<string> = new Set<string>(['free', 'pro', 'business', 'enterprise'])

export const validateSlug = (slug: string): ValidationResult => {
  if (slug.length < 3 || slug.length > 63) {
    return { valid: false, error: 'Slug must be between 3 and 63 characters' }
  }

  if (!SLUG_PATTERN.test(slug)) {
    return { valid: false, error: 'Slug must contain only lowercase alphanumeric characters and hyphens, and must start and end with an alphanumeric character' }
  }

  if (slug.includes('--')) {
    return { valid: false, error: 'Slug must not contain consecutive hyphens' }
  }

  if (RESERVED_SLUGS.has(slug)) {
    return { valid: false, error: `Slug "${slug}" is reserved` }
  }

  return { valid: true }
}

export const validateEmail = (email: string): ValidationResult => {
  if (!email) {
    return { valid: false, error: 'Email is required' }
  }

  if (!isValidEmail(email)) {
    return { valid: false, error: 'Invalid email format' }
  }

  return { valid: true }
}

export const validateTier = (tier: string): ValidationResult => {
  if (!VALID_TIERS.has(tier)) {
    return { valid: false, error: `Invalid tier "${tier}". Must be one of: free, pro, business, enterprise` }
  }

  return { valid: true }
}

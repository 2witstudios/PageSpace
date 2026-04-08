const MAX_EMAIL_LENGTH = 254 // RFC 5321

// Bounded-quantifier RFC 5322 regex — O(N), no ReDoS risk
const EMAIL_PATTERN = /^[a-zA-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)*$/

export function isValidEmail(email: string): boolean {
  if (!email || email.length > MAX_EMAIL_LENGTH) return false
  if (!EMAIL_PATTERN.test(email)) return false
  // Require at least one dot in domain (TLD check)
  const domain = email.slice(email.lastIndexOf('@') + 1)
  return domain.includes('.')
}

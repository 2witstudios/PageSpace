import { describe, test, expect } from 'vitest'
import { isValidEmail } from '../email'

describe('isValidEmail', () => {
  test('given a valid email, should return true', () => {
    expect(isValidEmail('user@example.com')).toBe(true)
  })

  test('given an email with subdomain, should return true', () => {
    expect(isValidEmail('user@mail.example.com')).toBe(true)
  })

  test('given an email with plus addressing, should return true', () => {
    expect(isValidEmail('user+tag@example.com')).toBe(true)
  })

  test('given an email with RFC 5322 special characters, should return true', () => {
    expect(isValidEmail("user.name!#$%&'*+/=?^_`{|}~-@example.com")).toBe(true)
  })

  test('given an empty string, should return false', () => {
    expect(isValidEmail('')).toBe(false)
  })

  test('given a missing @ sign, should return false', () => {
    expect(isValidEmail('userexample.com')).toBe(false)
  })

  test('given a missing domain, should return false', () => {
    expect(isValidEmail('user@')).toBe(false)
  })

  test('given a missing local part, should return false', () => {
    expect(isValidEmail('@example.com')).toBe(false)
  })

  test('given no TLD (bare domain), should return false', () => {
    expect(isValidEmail('user@example')).toBe(false)
  })

  test('given an email exceeding 254 characters (RFC 5321), should return false', () => {
    const longLocal = 'a'.repeat(243)
    const email = `${longLocal}@example.com` // 255 chars
    expect(email.length).toBe(255)
    expect(isValidEmail(email)).toBe(false)
  })

  test('given an email at exactly 254 characters, should return true', () => {
    const longLocal = 'a'.repeat(242)
    const email = `${longLocal}@example.com` // 254 chars
    expect(email.length).toBe(254)
    expect(isValidEmail(email)).toBe(true)
  })

  test('given a ReDoS attack string, should complete in under 100ms', () => {
    const malicious = '!@' + '!.'.repeat(10000) + ' '
    const start = performance.now()
    const result = isValidEmail(malicious)
    const elapsed = performance.now() - start
    expect(result).toBe(false)
    expect(elapsed).toBeLessThan(100)
  })
})

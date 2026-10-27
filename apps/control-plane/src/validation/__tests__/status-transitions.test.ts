import { describe, test, expect } from 'vitest'
import { canTransition, TenantStatus } from '../status-transitions'

describe('canTransition', () => {
  // Valid transitions
  test('given provisioning -> active, should return true', () => {
    expect(canTransition('provisioning', 'active')).toBe(true)
  })

  test('given provisioning -> failed, should return true', () => {
    expect(canTransition('provisioning', 'failed')).toBe(true)
  })

  test('given active -> suspended, should return true', () => {
    expect(canTransition('active', 'suspended')).toBe(true)
  })

  test('given suspended -> active, should return true', () => {
    expect(canTransition('suspended', 'active')).toBe(true)
  })

  test('given active -> destroying, should return true', () => {
    expect(canTransition('active', 'destroying')).toBe(true)
  })

  test('given suspended -> destroying, should return true', () => {
    expect(canTransition('suspended', 'destroying')).toBe(true)
  })

  test('given destroying -> destroyed, should return true', () => {
    expect(canTransition('destroying', 'destroyed')).toBe(true)
  })

  test('given failed -> destroying, should return true', () => {
    expect(canTransition('failed', 'destroying')).toBe(true)
  })

  // Invalid transitions
  test('given destroyed -> active, should return false', () => {
    expect(canTransition('destroyed', 'active')).toBe(false)
  })

  test('given destroyed -> provisioning, should return false', () => {
    expect(canTransition('destroyed', 'provisioning')).toBe(false)
  })

  test('given provisioning -> suspended, should return false', () => {
    expect(canTransition('provisioning', 'suspended')).toBe(false)
  })

  test('given provisioning -> destroying, should return false', () => {
    expect(canTransition('provisioning', 'destroying')).toBe(false)
  })

  test('given active -> provisioning, should return false', () => {
    expect(canTransition('active', 'provisioning')).toBe(false)
  })

  test('given active -> active (same state), should return false', () => {
    expect(canTransition('active', 'active')).toBe(false)
  })

  test('given failed -> active, should return false', () => {
    expect(canTransition('failed', 'active')).toBe(false)
  })

  test('given destroying -> active, should return false', () => {
    expect(canTransition('destroying', 'active')).toBe(false)
  })
})

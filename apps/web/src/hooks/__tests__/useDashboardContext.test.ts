/**
 * useDashboardContext Hook Tests
 * Tests for detecting dashboard vs page context for sidebar behavior
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook } from '@testing-library/react';
import { useDashboardContext } from '../useDashboardContext';

// Mock next/navigation
vi.mock('next/navigation', () => ({
  useParams: vi.fn(),
  usePathname: vi.fn(),
}));

import { useParams, usePathname } from 'next/navigation';

describe('useDashboardContext', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // ============================================
  // Dashboard Context (isDashboardContext = true)
  // ============================================
  describe('dashboard context (true)', () => {
    it('should return true for /dashboard', () => {
      vi.mocked(useParams).mockReturnValue({});
      vi.mocked(usePathname).mockReturnValue('/dashboard');

      const { result } = renderHook(() => useDashboardContext());
      expect(result.current.isDashboardContext).toBe(true);
    });

    it('should return true for /dashboard/ (trailing slash)', () => {
      vi.mocked(useParams).mockReturnValue({});
      vi.mocked(usePathname).mockReturnValue('/dashboard/');

      const { result } = renderHook(() => useDashboardContext());
      expect(result.current.isDashboardContext).toBe(true);
    });

    it('should return true for drive root /dashboard/[driveId]', () => {
      vi.mocked(useParams).mockReturnValue({ driveId: 'drive-123' });
      vi.mocked(usePathname).mockReturnValue('/dashboard/drive-123');

      const { result } = renderHook(() => useDashboardContext());
      expect(result.current.isDashboardContext).toBe(true);
    });

    it('should return true for drive root with trailing slash', () => {
      vi.mocked(useParams).mockReturnValue({ driveId: 'drive-123' });
      vi.mocked(usePathname).mockReturnValue('/dashboard/drive-123/');

      const { result } = renderHook(() => useDashboardContext());
      expect(result.current.isDashboardContext).toBe(true);
    });
  });

  // ============================================
  // Page Context (isDashboardContext = false)
  // ============================================
  describe('page context (false)', () => {
    it('should return false for page view /dashboard/[driveId]/[pageId]', () => {
      vi.mocked(useParams).mockReturnValue({ driveId: 'drive-123', pageId: 'page-456' });
      vi.mocked(usePathname).mockReturnValue('/dashboard/drive-123/page-456');

      const { result } = renderHook(() => useDashboardContext());
      expect(result.current.isDashboardContext).toBe(false);
    });

    it('should return false for nested page view', () => {
      vi.mocked(useParams).mockReturnValue({ driveId: 'drive-123', pageId: 'page-456' });
      vi.mocked(usePathname).mockReturnValue('/dashboard/drive-123/page-456/subpage');

      const { result } = renderHook(() => useDashboardContext());
      expect(result.current.isDashboardContext).toBe(false);
    });
  });

  // ============================================
  // Settings Routes (isDashboardContext = false)
  // ============================================
  describe('settings routes (false)', () => {
    it('should return false for /dashboard/[driveId]/settings', () => {
      vi.mocked(useParams).mockReturnValue({ driveId: 'drive-123' });
      vi.mocked(usePathname).mockReturnValue('/dashboard/drive-123/settings');

      const { result } = renderHook(() => useDashboardContext());
      expect(result.current.isDashboardContext).toBe(false);
    });

    it('should return false for /dashboard/[driveId]/settings/mcp', () => {
      vi.mocked(useParams).mockReturnValue({ driveId: 'drive-123' });
      vi.mocked(usePathname).mockReturnValue('/dashboard/drive-123/settings/mcp');

      const { result } = renderHook(() => useDashboardContext());
      expect(result.current.isDashboardContext).toBe(false);
    });

    it('should return false for settings even without driveId', () => {
      vi.mocked(useParams).mockReturnValue({});
      vi.mocked(usePathname).mockReturnValue('/dashboard/settings');

      const { result } = renderHook(() => useDashboardContext());
      expect(result.current.isDashboardContext).toBe(false);
    });
  });

  // ============================================
  // Edge Cases
  // ============================================
  describe('edge cases', () => {
    it('should handle empty params', () => {
      vi.mocked(useParams).mockReturnValue({});
      vi.mocked(usePathname).mockReturnValue('/dashboard');

      const { result } = renderHook(() => useDashboardContext());
      expect(result.current.isDashboardContext).toBe(true);
    });

    it('should handle null-like params', () => {
      vi.mocked(useParams).mockReturnValue({ driveId: 'drive-123', pageId: undefined });
      vi.mocked(usePathname).mockReturnValue('/dashboard/drive-123');

      const { result } = renderHook(() => useDashboardContext());
      expect(result.current.isDashboardContext).toBe(true);
    });

    it('should handle non-dashboard routes', () => {
      vi.mocked(useParams).mockReturnValue({});
      vi.mocked(usePathname).mockReturnValue('/account');

      const { result } = renderHook(() => useDashboardContext());
      // No pageId and not settings, so technically "dashboard context" even though not on dashboard
      // This is fine because the hook is only used within dashboard layout
      expect(result.current.isDashboardContext).toBe(true);
    });
  });
});

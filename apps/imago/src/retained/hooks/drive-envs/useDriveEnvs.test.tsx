// @vitest-environment jsdom
import '@/retained/test/setup';
import { describe, expect, it } from 'vitest';
import { renderHook } from '@testing-library/react';
import { useDriveEnvs } from './useDriveEnvs';

describe('useDriveEnvs', () => {
  it('hands back the same refresh across renders, so a dialog keyed on it does not cancel its own request', () => {
    const { result, rerender } = renderHook(() => useDriveEnvs('drive-1', { enabled: false }));
    const first = result.current.mutate;
    rerender();
    expect(result.current.mutate).toBe(first);
  });
});

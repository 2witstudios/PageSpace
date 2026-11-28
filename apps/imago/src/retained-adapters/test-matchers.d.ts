import type { TestingLibraryMatchers } from '@testing-library/jest-dom/matchers';
import type { expect } from 'vitest';
// The workspace also installs Vitest 4 for classic. Bind copied DOM matchers
// to Imago's Vitest 3 assertion type rather than the hoisted runner version.
declare module 'vitest' {
  // Vitest declaration merging requires an interface extending the matcher map.
  // eslint-disable-next-line @typescript-eslint/no-empty-object-type
  interface Assertion<T = unknown> extends TestingLibraryMatchers<typeof expect.stringContaining, T> {}
}

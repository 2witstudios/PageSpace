import { describe, it, expect } from 'vitest';
import { suspensionLabel } from '../policy-suspension-names';

describe('policy-suspension-names: the label a suspended item shows', () => {
  it.each([
    [{ resourceType: 'page_share_link', driveName: 'Product', userName: null }, 'Page share link in Product'],
    [{ resourceType: 'published_page', driveName: 'Marketing', userName: null }, 'Published page in Marketing'],
    [{ resourceType: 'guest_hold', driveName: 'Product', userName: 'Chris Rowe' }, 'Guest Chris Rowe in Product'],
    [{ resourceType: 'custom_domain', driveName: null, userName: null }, 'Custom domain'],
  ] as const)('UI-7 (partial) %o reads "%s", never a raw id', (input, label) => {
    expect(suspensionLabel(input)).toBe(label);
  });
});

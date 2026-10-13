import { renderToStaticMarkup } from 'react-dom/server';
import { describe, test, vi } from 'vitest';
import { assert } from 'riteway/vitest';
import { VerificationRequiredAlert } from './VerificationRequiredAlert';

vi.mock('@/retained-adapters/navigation', () => ({ useRouter: () => ({ push: () => {} }) }));

describe('VerificationRequiredAlert', () => {
  test('the blocked-action card with its copy and the way to settings', () => {
    const html = renderToStaticMarkup(<VerificationRequiredAlert />);

    assert({
      given: 'an unverified viewer trying a blocked action',
      should: 'show the title, the copy and Go to Account Settings in the v3 card',
      actual: [
        html.includes('Email verification required'),
        html.includes('You need to verify your email address before you can perform this action.'),
        html.includes('>Go to Account Settings<'),
        html.includes('rounded-xl'),
      ],
      expected: [true, true, true, true],
    });
  });
});

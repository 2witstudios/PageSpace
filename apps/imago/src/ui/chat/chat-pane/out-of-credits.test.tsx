// @vitest-environment jsdom
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, test, vi } from 'vitest';
import { assert } from 'riteway/vitest';
import { mount, unmountAll } from '../../test-support/dom';
import { useChatErrorStore } from '@/retained/stores/useChatErrorStore';
import type { AIErrorCause } from '@/retained/lib/ai/shared/aiErrorCause';
import { monthlyCreditsPhrase } from '@/retained/lib/subscription/credits';
import { OUT_OF_CREDITS_COPY, OutOfCreditsAlert, PLAN_HREF, UPGRADE_TO_PRO_LABEL } from './out-of-credits';

const cause = (code: AIErrorCause['code'], message = ''): AIErrorCause => ({ code, httpStatus: null, message, retryable: false });

const billing = vi.hoisted(() => ({ enabled: true }));

vi.mock('@/retained/lib/deployment-mode', () => ({
  isBillingEnabled: () => billing.enabled,
  isOnPrem: () => false,
  isTenantMode: () => false,
  isCloud: () => true,
}));

vi.mock('@/retained/components/billing/BuyCreditsButton', () => ({
  BuyCreditsButton: () => <button type="button">Buy credits</button>,
}));

vi.mock('@/retained-adapters/link', () => ({
  default: (props: { href: string; className?: string; children?: ReactNode }) => (
    <a href={`/imago${props.href}`} className={props.className}>{props.children}</a>
  ),
}));

const CONVERSATION = 'conv-1';

beforeEach(() => {
  billing.enabled = true;
  useChatErrorStore.setState({ byConversationId: {} });
});

afterEach(unmountAll);

describe('OutOfCreditsAlert (IMC-10.10)', () => {
  test('a 402 out_of_credits turn shows the alert with the board copy and Buy credits', () => {
    useChatErrorStore.getState().setError(CONVERSATION, cause('out_of_credits', 'web copy'));
    const root = mount(<OutOfCreditsAlert conversationId={CONVERSATION} />);
    const alert = root.querySelector('[role="alert"]');
    assert({
      given: 'an out_of_credits cause for the shown conversation',
      should: 'render a role=alert with the board copy and the Buy credits action',
      actual: [alert?.textContent?.includes(OUT_OF_CREDITS_COPY) ?? false, alert?.textContent?.includes('Buy credits') ?? false],
      expected: [true, true],
    });
  });

  test('the board copy is the one from the spec, not the web copy', () => {
    assert({
      given: 'the alert copy',
      should: 'match the board wording exactly',
      actual: OUT_OF_CREDITS_COPY,
      expected: 'You have run out of credits. Add credits or wait for your monthly allowance to reset.',
    });
  });

  test('other causes and other conversations render nothing', () => {
    useChatErrorStore.getState().setError(CONVERSATION, cause('rate_limit', 'slow down'));
    const other = mount(<OutOfCreditsAlert conversationId="conv-2" />);
    const shown = mount(<OutOfCreditsAlert conversationId={CONVERSATION} />);
    assert({
      given: 'a rate_limit cause here and an out_of_credits cause only on another conversation',
      should: 'show no out-of-credits alert',
      actual: [other.querySelector('[role="alert"]'), shown.querySelector('[role="alert"]')],
      expected: [null, null],
    });
  });

  test('the Pro upsell reads the plan constants and opens the plan page on cloud billing', () => {
    useChatErrorStore.getState().setError(CONVERSATION, cause('out_of_credits'));
    const root = mount(<OutOfCreditsAlert conversationId={CONVERSATION} />);
    const link = root.querySelector('a');
    assert({
      given: 'billing enabled and an out-of-credits turn',
      should: 'offer the Pro upsell with the plan allowance, linking to the Imago plan page',
      actual: [link?.textContent, link?.getAttribute('href')],
      expected: [UPGRADE_TO_PRO_LABEL, `/imago${PLAN_HREF}`],
    });
  });

  test('the upsell label comes from the Pro allowance', () => {
    assert({
      given: 'the plan constants',
      should: 'state Pro as 900 credits/month',
      actual: UPGRADE_TO_PRO_LABEL,
      expected: `Upgrade to Pro — ${monthlyCreditsPhrase('pro')}`,
    });
  });

  test('no upsell when billing is disabled (tenant, on-prem)', () => {
    billing.enabled = false;
    useChatErrorStore.getState().setError(CONVERSATION, cause('out_of_credits'));
    const root = mount(<OutOfCreditsAlert conversationId={CONVERSATION} />);
    assert({
      given: 'billing disabled',
      should: 'keep the alert but hide the Pro upsell',
      actual: [root.querySelector('[role="alert"]') !== null, root.querySelector('a')],
      expected: [true, null],
    });
  });
});

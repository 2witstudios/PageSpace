import { describe, expect, test, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { OnboardingModal } from '../OnboardingModal';
import { useOnboardingHandoffStore } from '@/stores/useOnboardingHandoffStore';

vi.mock('@/lib/deployment-mode', () => ({ isOnPrem: () => false }));

const advanceToLastStep = async (user: ReturnType<typeof userEvent.setup>) => {
  await user.click(screen.getByRole('radio', { name: /2–10 of us/i }));
  await user.click(screen.getByRole('button', { name: 'Continue' }));
  await user.click(screen.getByRole('button', { name: 'Show me' }));
  await user.click(screen.getByRole('button', { name: 'Continue' }));
  await user.click(screen.getByRole('button', { name: 'Continue' }));
};

beforeEach(() => {
  vi.clearAllMocks();
  useOnboardingHandoffStore.setState({ pendingRequest: null });
});

describe('gating the first step', () => {
  test('cannot advance until a scale is chosen', async () => {
    render(<OnboardingModal open onFinish={vi.fn()} />);
    expect(screen.getByRole('button', { name: 'Continue' })).toBeDisabled();
  });

  test('scale options are a single-selection group, not four unrelated buttons', async () => {
    const user = userEvent.setup();
    render(<OnboardingModal open onFinish={vi.fn()} />);
    const options = screen.getAllByRole('radio');
    expect(options).toHaveLength(4);
    options.forEach((o) => expect(o).toHaveAttribute('aria-checked', 'false'));

    await user.click(screen.getByRole('radio', { name: /Just me/i }));
    expect(screen.getByRole('radio', { name: /Just me/i })).toHaveAttribute('aria-checked', 'true');
  });
});

describe('scale rewrites the flow', () => {
  test('a solo user never sees a claim aimed at teams', async () => {
    const user = userEvent.setup();
    render(<OnboardingModal open onFinish={vi.fn()} />);
    await user.click(screen.getByRole('radio', { name: /Just me/i }));
    await user.click(screen.getByRole('button', { name: 'Continue' }));
    expect(screen.getByText(/get on top of my life admin/i)).toBeInTheDocument();
    expect(screen.queryByText(/landscaping business/i)).not.toBeInTheDocument();
  });

  test('a small-business user gets their own sample request', async () => {
    const user = userEvent.setup();
    render(<OnboardingModal open onFinish={vi.fn()} />);
    await user.click(screen.getByRole('radio', { name: /2–10 of us/i }));
    await user.click(screen.getByRole('button', { name: 'Continue' }));
    expect(screen.getByText(/landscaping business/i)).toBeInTheDocument();
  });
});

describe('every claim ships with its reassurance', () => {
  test('the "it does the work" screen carries edit/throw-away and the memory promise', async () => {
    const user = userEvent.setup();
    render(<OnboardingModal open onFinish={vi.fn()} />);
    await user.click(screen.getByRole('radio', { name: /2–10 of us/i }));
    await user.click(screen.getByRole('button', { name: 'Continue' }));
    await user.click(screen.getByRole('button', { name: 'Show me' }));

    expect(screen.getByText(/It doesn’t just answer\. It does\./i)).toBeInTheDocument();
    expect(screen.getByText(/yours to edit or throw away/i)).toBeInTheDocument();
    // The memory promise is load-bearing: recordOnboardingContext is what makes
    // it true, so this asserts the two never drift apart.
    expect(screen.getByText(/never start from scratch twice/i)).toBeInTheDocument();
  });

  test('the escalation screen carries undo and privacy', async () => {
    const user = userEvent.setup();
    render(<OnboardingModal open onFinish={vi.fn()} />);
    await user.click(screen.getByRole('radio', { name: /2–10 of us/i }));
    await user.click(screen.getByRole('button', { name: 'Continue' }));
    await user.click(screen.getByRole('button', { name: 'Show me' }));
    await user.click(screen.getByRole('button', { name: 'Continue' }));

    expect(screen.getByText(/You can always undo\./i)).toBeInTheDocument();
    expect(screen.getByText(/never sees anything you’ve kept private/i)).toBeInTheDocument();
  });
});

describe('the first request', () => {
  test('cannot send an empty request', async () => {
    const user = userEvent.setup();
    render(<OnboardingModal open onFinish={vi.fn()} />);
    await advanceToLastStep(user);
    expect(screen.getByRole('button', { name: 'Ask' })).toBeDisabled();
  });

  test('an example fills the box as editable text rather than submitting', async () => {
    const user = userEvent.setup();
    const onFinish = vi.fn();
    render(<OnboardingModal open onFinish={onFinish} />);
    await advanceToLastStep(user);

    await user.click(screen.getByRole('button', { name: /Keep on top of quotes and invoices/i }));
    expect(screen.getByLabelText(/What do you want to get done/i)).toHaveValue(
      'Keep on top of quotes and invoices',
    );
    expect(onFinish).not.toHaveBeenCalled();
  });

  test('sending hands the request to the assistant and reports the scale for memory', async () => {
    const user = userEvent.setup();
    const onFinish = vi.fn();
    render(<OnboardingModal open onFinish={onFinish} />);
    await advanceToLastStep(user);

    await user.type(screen.getByLabelText(/What do you want to get done/i), 'run my bakery');
    await user.click(screen.getByRole('button', { name: 'Ask' }));

    expect(useOnboardingHandoffStore.getState().pendingRequest).toBe('run my bakery');
    expect(onFinish).toHaveBeenCalledWith({
      scaleLabel: 'A small business or a tight team',
      firstRequest: 'run my bakery',
    });
  });

  test('the "not sure" chip is offered so nobody can fail the last screen', async () => {
    const user = userEvent.setup();
    render(<OnboardingModal open onFinish={vi.fn()} />);
    await advanceToLastStep(user);
    expect(screen.getByRole('button', { name: /I’m not sure yet/i })).toBeInTheDocument();
  });
});

describe('skipping', () => {
  test('records completion so the decision to skip is honoured, and queues nothing', async () => {
    const user = userEvent.setup();
    const onFinish = vi.fn();
    render(<OnboardingModal open onFinish={onFinish} />);
    await user.click(screen.getByRole('button', { name: /Skip/i }));

    expect(onFinish).toHaveBeenCalledWith(undefined);
    expect(useOnboardingHandoffStore.getState().pendingRequest).toBeNull();
  });
});

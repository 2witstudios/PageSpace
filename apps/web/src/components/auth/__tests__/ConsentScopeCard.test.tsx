// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { ConsentScopeCard } from '../ConsentScopeCard';

const props = {
  title: 'PageSpace CLI is requesting access',
  firstParty: true,
  scopeDescriptions: ['Act as you in Studio', 'Stay connected until you revoke access'],
};

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('ConsentScopeCard', () => {
  it('given a first-party client, should show the title, the badge and one row per scope', () => {
    vi.stubEnv('NEXT_PUBLIC_IMAGO_V3_AUTH', undefined);
    render(<ConsentScopeCard {...props} />);
    expect(screen.getByRole('heading', { name: /PageSpace CLI is requesting access/ })).toBeInTheDocument();
    expect(screen.getByText('Built by PageSpace')).toBeInTheDocument();
    expect(screen.getAllByRole('listitem')).toHaveLength(2);
  });

  it('given a third-party client, should omit the badge', () => {
    render(<ConsentScopeCard {...props} firstParty={false} />);
    expect(screen.queryByText('Built by PageSpace')).not.toBeInTheDocument();
  });

  it('given Imago is on, should style the card with v3 classes and keep the children', () => {
    vi.stubEnv('NEXT_PUBLIC_IMAGO_V3_AUTH', 'true');
    render(
      <ConsentScopeCard {...props} headingLevel={2}>
        <button type="button">Allow</button>
      </ConsentScopeCard>,
    );
    const heading = screen.getByRole('heading', { level: 2 });
    expect(heading).toHaveClass('tracking-[-0.02em]');
    expect(screen.getByRole('button', { name: 'Allow' })).toBeInTheDocument();
  });
});

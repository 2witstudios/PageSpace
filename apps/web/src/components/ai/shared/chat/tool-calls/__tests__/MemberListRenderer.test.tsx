import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemberListRenderer } from '../MemberListRenderer';

// Agent Signup Phase 2b: list_drive_members labels an agent's self-chosen name
// for the model; the card shows that label and must not derive "[A" initials.
describe('MemberListRenderer — agent accounts', () => {
  it('given an agent member, should show the labelled name and "AI" initials; a human keeps name initials', () => {
    render(
      <MemberListRenderer
        members={[
          { userId: 'a1', name: '[AI agent account, self-named] "Support"', displayName: '[AI agent account, self-named] "Support"', accountType: 'agent' },
          { userId: 'h1', name: 'Ada Lovelace', displayName: 'Ada Lovelace', accountType: 'human' },
        ]}
      />,
    );

    expect(screen.getByText('[AI agent account, self-named] "Support"')).toBeInTheDocument();
    expect(screen.getByText('AI')).toBeInTheDocument();
    expect(screen.getByText('AL')).toBeInTheDocument();
  });
});

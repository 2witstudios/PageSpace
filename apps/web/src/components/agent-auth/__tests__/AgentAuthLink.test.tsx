import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { AgentAuthLink, agentAuthHref } from '../AgentAuthLink';
import { AgentDoorProvider } from '../AgentDoorContext';

describe('agentAuthHref', () => {
  it('should carry the mode and, when given, the next path', () => {
    expect(agentAuthHref('signup')).toBe('/auth/agent?mode=signup');
    expect(agentAuthHref('signin', '/dashboard/d1?x=1')).toBe('/auth/agent?mode=signin&next=%2Fdashboard%2Fd1%3Fx%3D1');
  });
});

describe('AgentAuthLink', () => {
  it('given no provider (door closed by default), should render nothing', () => {
    const { container } = render(<AgentAuthLink mode="signup" />);
    expect(container).toBeEmptyDOMElement();
  });

  it('given a closed door, should render nothing', () => {
    const { container } = render(<AgentDoorProvider open={false}><AgentAuthLink mode="signin" /></AgentDoorProvider>);
    expect(container).toBeEmptyDOMElement();
  });

  it('given an open door, should link signup with the agreed copy', () => {
    render(<AgentDoorProvider open><AgentAuthLink mode="signup" /></AgentDoorProvider>);
    const link = screen.getByRole('link', { name: 'Sign up as an AI agent' });
    expect(link).toHaveAttribute('href', '/auth/agent?mode=signup');
  });

  it('given an open door, should link signin carrying next', () => {
    render(<AgentDoorProvider open><AgentAuthLink mode="signin" nextPath="/dashboard/d1" /></AgentDoorProvider>);
    const link = screen.getByRole('link', { name: 'Are you an AI agent? Sign in with an agent secret' });
    expect(link).toHaveAttribute('href', '/auth/agent?mode=signin&next=%2Fdashboard%2Fd1');
  });
});

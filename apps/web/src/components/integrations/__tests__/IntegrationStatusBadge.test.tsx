import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { IntegrationStatusBadge } from '../IntegrationStatusBadge';

describe('IntegrationStatusBadge', () => {
  it('should render active status', () => {
    render(<IntegrationStatusBadge status="active" />);
    expect(screen.getByText('Active')).toBeInTheDocument();
  });

  it('should render pending status', () => {
    render(<IntegrationStatusBadge status="pending" />);
    expect(screen.getByText('Pending')).toBeInTheDocument();
  });

  it('should render expired status', () => {
    render(<IntegrationStatusBadge status="expired" />);
    expect(screen.getByText('Expired')).toBeInTheDocument();
  });

  it('should render error status', () => {
    render(<IntegrationStatusBadge status="error" />);
    expect(screen.getByText('Error')).toBeInTheDocument();
  });

  it('should render revoked status', () => {
    render(<IntegrationStatusBadge status="revoked" />);
    expect(screen.getByText('Revoked')).toBeInTheDocument();
  });
});

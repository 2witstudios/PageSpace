/**
 * The shared rows: a dev port is pickable with its audience stated, an
 * ignored port is disabled with its reason, "current" reads by whether it is
 * actually serving, and an empty listing is an instruction — not a failure.
 */
import { describe, test, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { PortsList, describeProbedPort, messageOf, type PortsListing } from '../PortsList';
import { ApiRequestError } from '@/lib/auth/auth-fetch';

const LISTING: PortsListing = {
  spriteInstanceId: 'inst-live',
  currentPort: null,
  ports: [
    { port: 3000, pid: 2311, kind: 'dev-server', likelihood: 'known-dev-port', current: false },
    { port: 5432, pid: 9, kind: 'ignored', reason: 'non-http-service-port', current: false },
  ] as PortsListing['ports'],
};

describe('PortsList', () => {
  test('a dev port is pickable and reports the port AND the instance it was listed against; a database port is disabled with its reason', () => {
    const onPick = vi.fn();
    render(<PortsList listing={LISTING} audience="Anyone who can open this session will be able to open it." canOpen={false} picking={null} disabled={false} onPick={onPick} />);
    expect(screen.getByText('Anyone who can open this session will be able to open it.')).toBeInTheDocument();
    fireEvent.click(screen.getByTestId('ports-pick-3000'));
    expect(onPick).toHaveBeenCalledWith(3000, 'inst-live');
    const db = screen.getByTestId('ports-pick-5432');
    expect(db).toBeDisabled();
    expect(db).toHaveAttribute('title', expect.stringContaining('database'));
  });

  test('the current port reads "Previewing" only when it is serving, else "Selected"; another row offers "instead"', () => {
    const listing = { ...LISTING, currentPort: 3000, ports: LISTING.ports.map((p) => ({ ...p, current: p.port === 3000 })) };
    const { rerender } = render(<PortsList listing={listing} audience={null} canOpen={false} picking={null} disabled={false} onPick={vi.fn()} />);
    expect(screen.getByTestId('ports-pick-3000')).toHaveTextContent('Selected');
    expect(screen.getByTestId('ports-pick-3000')).toHaveAttribute('aria-checked', 'true');
    rerender(<PortsList listing={listing} audience={null} canOpen picking={null} disabled={false} onPick={vi.fn()} />);
    expect(screen.getByTestId('ports-pick-3000')).toHaveTextContent('Previewing');
    const other = { ...listing, ports: [...listing.ports, { port: 5173, pid: 7, kind: 'dev-server', likelihood: 'known-dev-port', current: false }] as PortsListing['ports'] };
    rerender(<PortsList listing={other} audience={null} canOpen picking={null} disabled={false} onPick={vi.fn()} />);
    expect(screen.getByTestId('ports-pick-5173')).toHaveTextContent('Preview this instead');
  });

  test('every row is disabled while a pick is in flight (that row says Starting…) or when the host has no authority', () => {
    const { rerender } = render(<PortsList listing={LISTING} audience={null} canOpen={false} picking={3000} disabled={false} onPick={vi.fn()} />);
    expect(screen.getByTestId('ports-pick-3000')).toBeDisabled();
    expect(screen.getByTestId('ports-pick-3000')).toHaveTextContent('Starting…');
    rerender(<PortsList listing={LISTING} audience={null} canOpen={false} picking={null} disabled onPick={vi.fn()} />);
    expect(screen.getByTestId('ports-pick-3000')).toBeDisabled();
  });

  test('an empty listing is an instruction, not an error', () => {
    render(<PortsList listing={{ ...LISTING, ports: [] }} audience={null} canOpen={false} picking={null} disabled={false} onPick={vi.fn()} />);
    expect(screen.getByTestId('ports-list')).toHaveTextContent('Start your dev server');
  });

  test('describeProbedPort and messageOf: the reason for every kind, and the server\'s sentence over a fallback', () => {
    expect(describeProbedPort({ port: 8080, pid: 1, kind: 'ignored', reason: 'relay-own-listener', current: false } as PortsListing['ports'][number])).toContain('relay');
    expect(describeProbedPort({ port: 4444, pid: 1, kind: 'dev-server', likelihood: 'unlisted', current: false } as PortsListing['ports'][number])).toBe('Unlisted port');
    expect(messageOf(new ApiRequestError('Nothing is listening on port 3000 any more.', 409), 'fallback')).toBe('Nothing is listening on port 3000 any more.');
    expect(messageOf(new Error(''), 'fallback')).toBe('fallback');
    expect(messageOf('weird', 'fallback')).toBe('fallback');
  });
});

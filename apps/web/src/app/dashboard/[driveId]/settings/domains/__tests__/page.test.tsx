/**
 * The domain row's ownership instruction.
 *
 * A certificate waiting on Fly's `_fly-ownership` TXT is the one cert state that
 * never resolves on its own — somebody has to be told what to publish. That
 * instruction used to reach a human only as a 30-second toast behind the manual
 * "Check SSL" button, so a customer who never pressed it saw a domain sitting at
 * "provisioning" with nothing to act on.
 *
 * The server half (the list route carrying the instruction rather than
 * discarding it) is covered in the route's own suite. What is asserted HERE is
 * the half that suite cannot see: that the row actually renders it, and that it
 * disappears again the moment the instruction does.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { SWRConfig } from 'swr';

vi.mock('next/navigation', () => ({
  useParams: () => ({ driveId: 'drive-1' }),
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn(), back: vi.fn() }),
  usePathname: () => '/',
  useSearchParams: () => new URLSearchParams(),
}));

vi.mock('sonner', () => ({
  toast: { error: vi.fn(), success: vi.fn(), warning: vi.fn(), info: vi.fn() },
}));

const mockFetchWithAuth = vi.fn();
vi.mock('@/lib/auth/auth-fetch', () => ({
  fetchWithAuth: (...a: unknown[]) => mockFetchWithAuth(...a),
  del: vi.fn(),
  patch: vi.fn(),
  post: vi.fn(),
}));

const drive = {
  id: 'drive-1',
  name: 'Acme',
  isOwned: true,
  role: 'OWNER',
  notFoundPageId: null,
  publishDefaultOgImageUrl: '',
  publishFaviconUrl: '',
};

vi.mock('@/hooks/useDrive', () => ({
  useDriveStore: (selector: (s: unknown) => unknown) =>
    selector({
      drives: [drive],
      isLoading: false,
      fetchDrives: vi.fn(),
      updateDrive: vi.fn(),
    }),
}));

vi.mock('@/hooks/useAuth', () => ({ useAuth: () => ({ user: { id: 'u1', role: 'user' } }) }));

vi.mock('@/components/common/PagePickerPopover', () => ({
  PagePickerPopover: () => <div data-testid="page-picker" />,
}));

import DomainsSettingsPage from '../page';

const INSTRUCTION =
  'Add a TXT record at _fly-ownership.docs.acme.com with the value org-XYZ789 — Fly cannot verify ownership of this domain until it resolves.';

/** One provisioning domain, with or without an outstanding ownership record. */
function domainsPayload(ownershipInstruction: string | null) {
  return {
    domains: [
      {
        id: 'd1',
        driveId: 'drive-1',
        hostname: 'docs.acme.com',
        status: 'provisioning',
        isPrimary: false,
        createdAt: new Date().toISOString(),
        platformOwned: false,
        publishLandingPageId: null,
        publishNotFoundPageId: null,
        ownershipInstruction,
      },
    ],
    limit: 5,
  };
}

function serve(ownershipInstruction: string | null) {
  mockFetchWithAuth.mockImplementation((url: string) =>
    Promise.resolve({
      ok: true,
      json: () =>
        Promise.resolve(
          url.includes('/subdomain') ? { subdomain: null } : domainsPayload(ownershipInstruction),
        ),
    }),
  );
}

/**
 * A FRESH SWR cache per render, not the module-global one.
 *
 * Without this the second test rendered the first test's cached response: SWR
 * keys on the URL, both tests request the same URL, and the stale value is
 * served before the new fetch resolves. That made the "nothing owed" assertion
 * fail against an instruction the test never supplied — a suite lying because of
 * shared state rather than because of the code under test.
 */
const renderPage = () =>
  render(
    <SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0 }}>
      <DomainsSettingsPage />
    </SWRConfig>,
  );

describe('DomainsSettingsPage — a stuck certificate names the record it is waiting on', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('given a provisioning domain blocked on ownership, should show the record and value in the row', async () => {
    serve(INSTRUCTION);

    renderPage();

    // The whole point: visible without pressing "Check SSL" first.
    expect(await screen.findByText(/_fly-ownership\.docs\.acme\.com/)).toBeInTheDocument();
    expect(screen.getByText(/org-XYZ789/)).toBeInTheDocument();
  });

  // The case that would rot: the instruction is recomputed per request, never
  // stored, so a customer who has just fixed their zone must stop seeing it on
  // the very next load rather than being told to re-publish a record they have.
  it('given the same domain with nothing owed, should show no instruction at all', async () => {
    serve(null);

    // Wait for the row itself, so this is not asserting on an unrendered page.
    renderPage();
    expect(await screen.findByText('docs.acme.com')).toBeInTheDocument();

    expect(screen.queryByText(/_fly-ownership/)).not.toBeInTheDocument();
    expect(screen.queryByText(/waiting on a DNS record/i)).not.toBeInTheDocument();
  });
});

import { describe, test, beforeEach, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { assert } from '@/stores/__tests__/riteway';

const mockUseMobile = vi.fn<() => boolean>();
vi.mock('@/hooks/useMobile', () => ({ useMobile: () => mockUseMobile() }));

import TabSidebar from './TabSidebar';

const onDesktop = () => mockUseMobile.mockReturnValue(false);
const onMobile = () => mockUseMobile.mockReturnValue(true);

/** A sidebar body with one row that navigates (and therefore closes) and one that
 * merely expands (and therefore must not). */
function renderSidebar() {
  return render(
    <TabSidebar title="Branches" pane={<div data-testid="pane">pane</div>}>
      {({ close }) => (
        <div>
          <button type="button" onClick={() => close()}>
            pick-branch
          </button>
          <button type="button">expand-row</button>
        </div>
      )}
    </TabSidebar>,
  );
}

describe('TabSidebar', () => {
  beforeEach(() => vi.clearAllMocks());

  test('on a wide viewport the sidebar body sits beside the pane, with no sheet', () => {
    onDesktop();
    renderSidebar();

    assert({
      given: 'a wide viewport',
      should: 'render the sidebar body and the pane together, with no sheet trigger',
      actual: {
        body: screen.queryByText('pick-branch') !== null,
        pane: screen.queryByTestId('pane') !== null,
        sheetTrigger: screen.queryByRole('button', { name: /Branches/ }) !== null,
      },
      expected: { body: true, pane: true, sheetTrigger: false },
    });
  });

  test('on a narrow viewport the sidebar collapses behind a sheet, leaving the pane the full width', () => {
    onMobile();
    renderSidebar();

    assert({
      given: 'a narrow viewport',
      should: 'render the pane plus a sheet trigger, and NOT the sidebar body — a 16rem column beside a pane does not fit a phone',
      actual: {
        pane: screen.queryByTestId('pane') !== null,
        sheetTrigger: screen.queryByRole('button', { name: /Branches/ }) !== null,
        body: screen.queryByText('pick-branch') !== null,
      },
      expected: { pane: true, sheetTrigger: true, body: false },
    });
  });

  test('the sheet opens on tapping the header button and shows the same sidebar body', async () => {
    onMobile();
    renderSidebar();

    await userEvent.click(screen.getByRole('button', { name: /Branches/ }));

    assert({
      given: 'the sheet trigger tapped on a narrow viewport',
      should: 'reveal the sidebar body inside the sheet',
      actual: (await screen.findByText('pick-branch')) !== null,
      expected: true,
    });
  });

  test('a navigating click closes the sheet; an expanding click leaves it open', async () => {
    onMobile();
    renderSidebar();

    await userEvent.click(screen.getByRole('button', { name: /Branches/ }));
    await screen.findByText('expand-row');

    // A row that only expands must NOT dismiss the sheet — the user is still
    // drilling down towards the thing they came here to open.
    await userEvent.click(screen.getByText('expand-row'));
    const openAfterExpand = screen.queryByText('pick-branch') !== null;

    // A row that navigates must, because what it opened is BEHIND the sheet.
    await userEvent.click(screen.getByText('pick-branch'));
    await waitFor(() => {
      if (screen.queryByText('pick-branch') !== null) throw new Error('sheet still open');
    });

    assert({
      given: 'an expanding click and then a navigating click inside the sheet',
      should: 'keep the sheet open through the expand, and close it on the navigation',
      actual: { openAfterExpand, closedAfterNavigate: screen.queryByText('pick-branch') === null },
      expected: { openAfterExpand: true, closedAfterNavigate: true },
    });
  });
});

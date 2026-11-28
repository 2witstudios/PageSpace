// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { CSAM_REPORT_GUIDANCE, REPORT_CATEGORIES } from '@pagespace/lib/content-safety/reports';
import { ReportContentForm, REPORT_CATEGORY_OPTIONS } from '../ReportContentForm';

const fetchMock = vi.fn();

describe('ReportContentForm', () => {
  beforeEach(() => {
    fetchMock.mockReset();
    vi.stubGlobal('fetch', fetchMock);
  });
  afterEach(() => vi.unstubAllGlobals());

  it('offers exactly the categories the server accepts', () => {
    expect(REPORT_CATEGORY_OPTIONS.map((o) => o.value)).toEqual([...REPORT_CATEGORIES]);
  });

  it('shows the CyberTipline and the do-not-download warning as soon as CSAM is chosen', async () => {
    const user = userEvent.setup();
    render(<ReportContentForm />);
    expect(screen.queryByTestId('csam-guidance')).toBeNull();

    await user.selectOptions(screen.getByLabelText('What is wrong with it?'), 'csam');

    const guidance = screen.getByTestId('csam-guidance');
    expect(guidance.textContent).toMatch(/do not download, screenshot/i);
    expect(guidance.textContent).toMatch(/forward/i);
    expect(guidance.querySelector('a')?.getAttribute('href')).toBe(CSAM_REPORT_GUIDANCE.cyberTiplineUrl);
  });

  it('posts the report with an empty honeypot and shows the server answer', async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ message: 'Report received.' }), { status: 201 }));
    const user = userEvent.setup();
    render(<ReportContentForm />);

    await user.type(screen.getByLabelText('Address of the page'), 'https://acme.pagespace.site/x');
    await user.selectOptions(screen.getByLabelText('What is wrong with it?'), 'copyright');
    await user.type(screen.getByLabelText('Details (optional)'), 'my photo');
    await user.click(screen.getByRole('button', { name: 'Send report' }));

    await waitFor(() => expect(screen.getByRole('status').textContent).toContain('Report received.'));
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('/api/report');
    expect(JSON.parse(init.body)).toEqual({
      url: 'https://acme.pagespace.site/x',
      category: 'copyright',
      description: 'my photo',
      contactEmail: '',
      _hp: '',
    });
  });

  it('shows the neutral refusal for a URL that is not ours', async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ error: 'We can only take reports about sites published on PageSpace.' }), { status: 400 }));
    const user = userEvent.setup();
    render(<ReportContentForm />);

    await user.type(screen.getByLabelText('Address of the page'), 'https://evil.example.org/');
    await user.selectOptions(screen.getByLabelText('What is wrong with it?'), 'other');
    await user.click(screen.getByRole('button', { name: 'Send report' }));

    await waitFor(() => expect(screen.getByRole('alert').textContent).toMatch(/sites published on PageSpace/));
  });
});

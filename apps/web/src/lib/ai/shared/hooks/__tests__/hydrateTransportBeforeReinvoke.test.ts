import { describe, it, expect, vi } from 'vitest';
import { hydrateTransportBeforeReinvoke } from '../hydrateTransportBeforeReinvoke';

describe('hydrateTransportBeforeReinvoke', () => {
  it('given the own send is NOT live, should hydrate the transport with the stable snapshot', () => {
    const setMessages = vi.fn();
    const stableMessages = [{ id: 'a1', role: 'assistant', parts: [] }] as never[];
    hydrateTransportBeforeReinvoke(setMessages, stableMessages, false);
    expect(setMessages).toHaveBeenCalledWith(stableMessages);
  });

  it('given the own send IS live, should NOT touch the transport (it is the mirror\'s read source)', () => {
    const setMessages = vi.fn();
    hydrateTransportBeforeReinvoke(setMessages, [], true);
    expect(setMessages).not.toHaveBeenCalled();
  });
});

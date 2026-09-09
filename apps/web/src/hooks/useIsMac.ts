import { useEffect, useState } from 'react';
import { isMacPlatform } from '@/lib/hotkeys/binding';

/**
 * Whether the user is on a Mac, detected after mount.
 *
 * The server has no `navigator`, so detecting during render would make the
 * server and the first client render disagree and trip hydration. This starts
 * false everywhere — matching the server — and settles once mounted.
 */
export function useIsMac(): boolean {
  const [isMac, setIsMac] = useState(false);

  useEffect(() => {
    setIsMac(isMacPlatform());
  }, []);

  return isMac;
}

import { useCallback, useEffect, useState } from 'react';

/**
 * Shell hook for the sheet's screen-reader announcements: a transient live-region
 * message that auto-clears after a delay.
 */
export const useAnnouncements = (clearAfterMs = 3000) => {
  const [announcement, setAnnouncement] = useState('');

  useEffect(() => {
    if (announcement) {
      const timer = setTimeout(() => setAnnouncement(''), clearAfterMs);
      return () => clearTimeout(timer);
    }
  }, [announcement, clearAfterMs]);

  const announce = useCallback((message: string) => setAnnouncement(message), []);

  return { announcement, announce };
};

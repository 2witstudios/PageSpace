'use client';

import { useState } from 'react';
import { signOut } from '@/lib/auth/sign-out';

export function SignOutButton() {
  const [pending, setPending] = useState(false);

  const handleClick = () => {
    setPending(true);
    void signOut({
      fetch: (input, init) => window.fetch(input, init),
      navigate: (url) => window.location.assign(url),
    });
  };

  return (
    <button type="button" onClick={handleClick} disabled={pending}>
      Sign out
    </button>
  );
}

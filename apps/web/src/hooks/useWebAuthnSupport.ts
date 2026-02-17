'use client';

import { useState, useEffect } from 'react';
import { browserSupportsWebAuthn } from '@simplewebauthn/browser';

export function useWebAuthnSupport() {
  const [isSupported, setIsSupported] = useState<boolean | null>(null);

  useEffect(() => {
    setIsSupported(browserSupportsWebAuthn());
  }, []);

  return isSupported;
}

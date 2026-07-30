import { useEffect, useRef } from 'react';

/**
 * A ref that always holds the LATEST value, read at completion time rather
 * than trusted from a closure captured before an async gap. A callback bound
 * to a prop/store value at render time can still fire after that value has
 * changed — e.g. an in-flight request whose completion handler closed over
 * an earlier selection — and reading the closed-over variable then acts on
 * stale state. Read `.current` inside the callback instead.
 */
export function useLatestRef<T>(value: T) {
  const ref = useRef(value);
  useEffect(() => {
    ref.current = value;
  }, [value]);
  return ref;
}

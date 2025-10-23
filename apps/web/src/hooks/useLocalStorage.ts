import { useState, useEffect, useCallback } from 'react';

/**
 * Custom hook for persisting state to localStorage with SSR safety and cross-tab sync
 *
 * @param key - localStorage key
 * @param initialValue - Default value if no stored value exists
 * @param enableSync - Enable cross-tab synchronization (default: false)
 * @returns [storedValue, setValue] tuple like useState
 *
 * @example
 * const [isDark, setIsDark] = useLocalStorage('theme-dark', false);
 * const [user, setUser] = useLocalStorage<User>('user', null, true);
 */
export function useLocalStorage<T>(
  key: string,
  initialValue: T,
  enableSync = false
): [T, (value: T | ((prev: T) => T)) => void] {
  // State to store our value
  // Pass initial state function to useState so logic is only executed once
  const [storedValue, setStoredValue] = useState<T>(() => {
    // SSR safety check
    if (typeof window === 'undefined') {
      return initialValue;
    }

    try {
      const item = window.localStorage.getItem(key);
      // Parse stored json or return initialValue
      return item ? JSON.parse(item) : initialValue;
    } catch (error) {
      console.warn(`Error reading localStorage key "${key}":`, error);
      return initialValue;
    }
  });

  // Return a wrapped version of useState's setter function that persists to localStorage
  const setValue = useCallback((value: T | ((prev: T) => T)) => {
    try {
      // Allow value to be a function so we have same API as useState
      const valueToStore = value instanceof Function ? value(storedValue) : value;

      // Save state
      setStoredValue(valueToStore);

      // Save to local storage
      if (typeof window !== 'undefined') {
        window.localStorage.setItem(key, JSON.stringify(valueToStore));
      }
    } catch (error) {
      console.warn(`Error setting localStorage key "${key}":`, error);
    }
  }, [key, storedValue]);

  // Listen for changes to this localStorage key in other tabs/windows
  useEffect(() => {
    if (!enableSync || typeof window === 'undefined') {
      return;
    }

    const handleStorageChange = (e: StorageEvent) => {
      if (e.key === key && e.newValue !== null) {
        try {
          setStoredValue(JSON.parse(e.newValue));
        } catch (error) {
          console.warn(`Error syncing localStorage key "${key}":`, error);
        }
      }
    };

    window.addEventListener('storage', handleStorageChange);
    return () => window.removeEventListener('storage', handleStorageChange);
  }, [key, enableSync]);

  return [storedValue, setValue];
}

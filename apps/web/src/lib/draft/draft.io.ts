const LS_PREFIX = 'draft:';

export const readLocal = (key: string): string =>
  (typeof window !== 'undefined' && localStorage.getItem(`${LS_PREFIX}${key}`)) || '';

export const writeLocal = (key: string, value: string): void => {
  if (typeof window === 'undefined') return;
  localStorage.setItem(`${LS_PREFIX}${key}`, value);
};

export const removeLocal = (key: string): void => {
  if (typeof window === 'undefined') return;
  localStorage.removeItem(`${LS_PREFIX}${key}`);
};

export const fetchDraft = (key: string): Promise<string | null> =>
  fetch(`/api/drafts?key=${encodeURIComponent(key)}`)
    .then((r) => r.json())
    .then((d: { content?: string | null }) => d.content ?? null)
    .catch(() => null);

export const saveDraft = (key: string, content: string): Promise<void> =>
  fetch('/api/drafts', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ key, content }),
  })
    .then(() => undefined)
    .catch(() => undefined);

export const deleteDraft = (key: string): Promise<void> =>
  fetch(`/api/drafts?key=${encodeURIComponent(key)}`, { method: 'DELETE' })
    .then(() => undefined)
    .catch(() => undefined);

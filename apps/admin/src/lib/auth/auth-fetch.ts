'use client';

const MUTATION_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

let cachedCsrfToken: string | null = null;
let pendingCsrfFetch: Promise<string | null> | null = null;

async function fetchCSRFToken(): Promise<string | null> {
  try {
    const res = await fetch('/api/auth/csrf', { credentials: 'include' });
    if (!res.ok) return null;
    const data = await res.json();
    return data.csrfToken ?? null;
  } catch {
    return null;
  }
}

async function getCSRFToken(refresh = false): Promise<string | null> {
  if (cachedCsrfToken && !refresh) return cachedCsrfToken;
  if (pendingCsrfFetch) return pendingCsrfFetch;
  pendingCsrfFetch = fetchCSRFToken().then(t => {
    cachedCsrfToken = t;
    pendingCsrfFetch = null;
    return t;
  });
  return pendingCsrfFetch;
}

export async function fetchWithAuth(url: string, options: RequestInit = {}): Promise<Response> {
  const method = (options.method ?? 'GET').toUpperCase();
  const headers = new Headers(options.headers);

  if (MUTATION_METHODS.has(method)) {
    const token = await getCSRFToken();
    if (token) headers.set('X-CSRF-Token', token);
  }

  const response = await fetch(url, { ...options, headers, credentials: 'include' });

  if (response.status === 403 && MUTATION_METHODS.has(method)) {
    const body = await response.clone().json().catch(() => ({}));
    if (body.code === 'CSRF_TOKEN_INVALID' || body.code === 'CSRF_TOKEN_MISSING') {
      const freshToken = await getCSRFToken(true);
      if (freshToken) {
        headers.set('X-CSRF-Token', freshToken);
        return fetch(url, { ...options, headers, credentials: 'include' });
      }
    }
  }

  return response;
}

async function fetchJSON<T>(url: string, options: RequestInit = {}): Promise<T> {
  const res = await fetchWithAuth(url, options);
  if (!res.ok) {
    const text = await res.text().catch(() => 'Request failed');
    try {
      const json = JSON.parse(text);
      throw new Error(json.error ?? json.message ?? text);
    } catch (e) {
      if (e instanceof SyntaxError) throw new Error(text);
      throw e;
    }
  }
  if (res.status === 204) return undefined as T;
  return res.json();
}

export async function post<T = unknown>(url: string, body?: unknown): Promise<T> {
  return fetchJSON<T>(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
}

export async function del<T = unknown>(url: string): Promise<T> {
  return fetchJSON<T>(url, { method: 'DELETE' });
}

import { store } from './store';

const storeAny = store as any;

export function getAppUrl(): string {
  const customUrl = storeAny.get('appUrl');
  if (customUrl) {
    let url = customUrl;
    if (!url.includes('localhost') && !url.includes('127.0.0.1')) {
      url = url.replace(/^http:/, 'https:');
    }
    return url;
  }

  let baseUrl: string;
  if (process.env.NODE_ENV === 'development') {
    baseUrl = process.env.PAGESPACE_URL || 'http://localhost:3000';
  } else {
    baseUrl = process.env.PAGESPACE_URL || 'https://pagespace.ai';
  }

  if (!baseUrl.includes('localhost') && !baseUrl.includes('127.0.0.1')) {
    baseUrl = baseUrl.replace(/^http:/, 'https:');
  }

  return baseUrl + '/dashboard';
}

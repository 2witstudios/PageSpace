import { NextRequest } from 'next/server'
import type { RequestInit as NextRequestInit } from 'next/dist/server/web/spec-extension/request'

const sanitizeOptions = (options?: RequestInit): NextRequestInit | undefined => {
  if (!options) return undefined

  const { signal, ...rest } = options
  return {
    ...rest,
    signal: signal ?? undefined,
  } as NextRequestInit
}

export const apiHelpers = {
  createRequest(url: string, options?: RequestInit): NextRequest {
    const sanitized = sanitizeOptions(options)
    return new NextRequest(new URL(url, 'http://localhost:3000'), sanitized)
  },

  createAuthenticatedRequest(url: string, token: string, options?: RequestInit): NextRequest {
    const sanitized: NextRequestInit = sanitizeOptions(options) ?? {}

    return new NextRequest(new URL(url, 'http://localhost:3000'), {
      ...sanitized,
      headers: {
        ...(sanitized.headers ?? {}),
        Authorization: `Bearer ${token}`,
      },
    })
  },

  async createContext<T>(params: T): Promise<{ params: Promise<T> }> {
    // Next.js 15 pattern: params is a Promise
    return { params: Promise.resolve(params) }
  },
}

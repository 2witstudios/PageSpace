import { NextRequest } from 'next/server'

export const apiHelpers = {
  createRequest(url: string, options?: RequestInit): NextRequest {
    return new NextRequest(new URL(url, 'http://localhost:3000'), options)
  },

  createAuthenticatedRequest(url: string, token: string, options?: RequestInit): NextRequest {
    return new NextRequest(new URL(url, 'http://localhost:3000'), {
      ...options,
      headers: {
        ...options?.headers,
        Authorization: `Bearer ${token}`,
      },
    })
  },

  async createContext<T>(params: T): Promise<{ params: Promise<T> }> {
    // Next.js 15 pattern: params is a Promise
    return { params: Promise.resolve(params) }
  },
}
class NextResponseStub extends Response {
  static json(body: unknown, init?: ResponseInit) {
    return new NextResponseStub(JSON.stringify(body), {
      ...init,
      headers: { 'Content-Type': 'application/json', ...(init?.headers ?? {}) },
    });
  }

  static redirect(url: string | URL, init?: number | ResponseInit) {
    const status = typeof init === 'number' ? init : (init?.status ?? 307);
    return new NextResponseStub(null, {
      status,
      headers: { Location: url.toString() },
    });
  }
}

export const NextResponse = NextResponseStub;

export class NextRequest extends Request {
  constructor(input: string | URL | Request, init?: RequestInit) {
    super(input, init);
  }
}

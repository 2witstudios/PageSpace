class NextResponseStub extends Response {
  static json(body: unknown, init?: ResponseInit) {
    const headers = new Headers(init?.headers);
    headers.set('Content-Type', 'application/json');
    return new NextResponseStub(JSON.stringify(body), { ...init, headers });
  }

  static redirect(url: string | URL, init?: number | ResponseInit) {
    const status = typeof init === 'number' ? init : (init?.status ?? 307);
    const headers = new Headers(typeof init === 'number' ? undefined : init?.headers);
    headers.set('Location', url.toString());
    return new NextResponseStub(null, { status, headers });
  }
}

export const NextResponse = NextResponseStub;

export class NextRequest extends Request {
  constructor(input: string | URL | Request, init?: RequestInit) {
    super(input, init);
  }
}

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

  // Models what the edge runtime actually emits for a rewrite: a 200 whose
  // destination travels in the x-middleware-rewrite header, NOT a redirect.
  // The `request` init (used to forward the nonce/CSP request headers) has no
  // observable effect on the response, so the stub accepts and ignores it.
  static rewrite(
    destination: string | URL,
    init?: { request?: { headers?: Headers } },
  ) {
    void init;
    const headers = new Headers({ 'x-middleware-rewrite': destination.toString() });
    return new NextResponseStub(null, { status: 200, headers });
  }
}

export const NextResponse = NextResponseStub;

export class NextRequest extends Request {
  readonly nextUrl: URL;

  constructor(input: string | URL | Request, init?: RequestInit) {
    super(input, init);
    this.nextUrl = new URL(this.url);
  }
}

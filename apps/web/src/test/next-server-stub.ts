class NextResponseStub extends Response {
  static json(body: unknown, init?: ResponseInit) {
    return new NextResponseStub(JSON.stringify(body), {
      ...init,
      headers: { 'Content-Type': 'application/json', ...(init?.headers ?? {}) },
    });
  }
}

export const NextResponse = NextResponseStub;

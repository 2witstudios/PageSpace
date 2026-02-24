import { z } from 'zod';

type ParseSuccess<T> = { success: true; data: T };
type ParseFailure = { success: false; response: Response };
type ParseResult<T> = ParseSuccess<T> | ParseFailure;

/**
 * Safely parse a JSON request body and validate it against a Zod schema.
 * Returns a 400 response for malformed JSON or schema violations instead of throwing.
 */
export async function safeParseBody<T>(
  request: Request,
  schema: z.ZodSchema<T>
): Promise<ParseResult<T>> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return {
      success: false,
      response: Response.json({ error: 'Invalid JSON body' }, { status: 400 }),
    };
  }

  const result = schema.safeParse(body);
  if (!result.success) {
    const message = result.error.issues
      .map((i) => i.message)
      .join('; ');
    return {
      success: false,
      response: Response.json({ error: message }, { status: 400 }),
    };
  }

  return { success: true, data: result.data };
}

/**
 * API Utilities for consistent data serialization
 *
 * These utilities ensure consistent data formatting across all API endpoints,
 * particularly for date serialization to ISO8601 format for mobile clients.
 */

/**
 * Recursively serializes all Date objects in a value to ISO8601 strings
 *
 * This ensures consistent date formatting for all API responses, making them
 * compatible with strict date parsers in mobile clients (iOS, Android).
 *
 * @param value - Any value (object, array, primitive, Date)
 * @returns The same structure with all Date objects converted to ISO8601 strings
 *
 * @example
 * ```typescript
 * const data = {
 *   createdAt: new Date(),
 *   pages: [
 *     { updatedAt: new Date(), title: "Page 1" }
 *   ]
 * };
 *
 * const serialized = serializeDates(data);
 * // All Date objects are now ISO8601 strings like "2025-11-03T12:34:56.789Z"
 * ```
 */
export function serializeDates<T>(value: T): T {
  // Handle null/undefined
  if (value === null || value === undefined) {
    return value;
  }

  // Handle Date objects - convert to ISO8601 string
  if (value instanceof Date) {
    return value.toISOString() as unknown as T;
  }

  // Handle arrays - recursively serialize each element
  if (Array.isArray(value)) {
    return value.map(item => serializeDates(item)) as unknown as T;
  }

  // Handle objects - recursively serialize each property
  if (typeof value === 'object') {
    const serialized: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(value)) {
      serialized[key] = serializeDates(val);
    }
    return serialized as T;
  }

  // Handle primitives (string, number, boolean)
  return value;
}

/**
 * Creates a consistent JSON response with serialized dates
 *
 * This is a convenience wrapper around Response.json() that automatically
 * serializes all Date objects to ISO8601 strings.
 *
 * @param data - The data to return in the response
 * @param init - Optional ResponseInit for status codes, headers, etc.
 * @returns Response object with JSON body
 *
 * @example
 * ```typescript
 * export async function GET(request: Request) {
 *   const pages = await db.select().from(pagesTable);
 *   return jsonResponse(pages); // Dates automatically serialized
 * }
 * ```
 */
export function jsonResponse<T>(data: T, init?: ResponseInit): Response {
  const serialized = serializeDates(data);
  return Response.json(serialized, init);
}

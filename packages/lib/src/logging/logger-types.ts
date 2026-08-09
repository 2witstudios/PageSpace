/** Input metadata accepted by logging functions — widened for caller convenience. */
export type LogInput = Record<string, unknown>;

export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH' | 'HEAD' | 'OPTIONS';

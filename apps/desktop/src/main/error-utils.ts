export function isNodeError(error: unknown): error is Error & { code?: string } {
  return error instanceof Error;
}

export function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function hasErrorCode(error: unknown, code: string): boolean {
  return isNodeError(error) && (error as Error & { code?: string }).code === code;
}

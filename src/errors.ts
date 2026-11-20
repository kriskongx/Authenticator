/**
 * Returns a readable message for anything that can be thrown. DOMException and
 * Error both expose name/message; the plain "Error" name is dropped so callers
 * do not end up with "Error: Error: ..." prefixes.
 */
export function describeError(error: unknown): string {
  if (!(error instanceof Error)) {
    return String(error);
  }
  return error.name && error.name !== "Error"
    ? `${error.name}: ${error.message}`
    : error.message;
}

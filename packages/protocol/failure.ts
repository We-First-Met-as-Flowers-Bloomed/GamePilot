/** Only failures before game actions are submitted may use this code. */
export class ConnectionUnavailableError extends Error {
  readonly code = "connection-unavailable";
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "ConnectionUnavailableError";
  }
}
export function isConnectionUnavailable(error: unknown): boolean {
  return (
    error instanceof Error &&
    (error as Error & { code?: string }).code === "connection-unavailable"
  );
}

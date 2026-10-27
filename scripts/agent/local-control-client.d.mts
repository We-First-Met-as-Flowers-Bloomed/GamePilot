import type {
  LocalControlMethod,
  LocalControlResponse,
  localControlSchemas as schemas,
} from "../../packages/protocol/local-control";

export class LocalControlError extends Error {
  code: string;
  outcomeUnknown: boolean;
  constructor(code: string, message: string, outcomeUnknown?: boolean);
}
export const localControlMethods: LocalControlMethod[];
export const localControlSchemas: typeof schemas;
export function publicError(error: unknown): {
  ok: false;
  error: { code: string; message: string; outcomeUnknown?: true };
};
export function boundedJson(path: string, maximum?: number): Promise<unknown>;
export function parseProfileArgs(
  args: string[],
  allowedFlags?: string[],
): {
  profileDir: string;
  rest: string[];
};
export function requestLocalControl(
  profileDir: string,
  method: LocalControlMethod,
  params?: Record<string, unknown>,
  options?: { requestId?: string; signal?: AbortSignal; timeoutMs?: number },
): Promise<LocalControlResponse>;

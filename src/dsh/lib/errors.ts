// DSH Remote error helpers — ported from apps/android/src/lib/errors.ts (web: English strings;
// UI-level i18n mapping happens in features/connect).

export class RemoteApiError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly status?: number,
    public readonly retryable = false,
  ) {
    super(message)
    this.name = 'RemoteApiError'
  }
}

const friendlyByCode: Record<string, string> = {
  CONNECTION_FAILED: 'Cannot reach the DSH Remote server.',
  INVALID_MESSAGE: 'The server returned an unexpected response.',
  AUTH_REQUIRED: 'Please sign in to the DSH Remote server first.',
  AUTH_INVALID: 'The saved device credentials were rejected. Sign in again.',
  DEVICE_REVOKED: 'This device was revoked on the server. Sign in again.',
  DEVICE_NOT_FOUND: 'The device is no longer registered on the server.',
  RATE_LIMITED: 'Too many requests. Try again later.',
  HOST_OFFLINE: 'The Host is offline.',
  RPC_TIMEOUT: 'The Host took too long to respond.',
  PERMISSION_NOT_PENDING: 'That request was already answered or expired.',
  NO_SESSION: 'Open a session first.',
  ACCOUNT_REQUIRED: 'Please sign in again to continue.',
  serverUnreachable: 'Cannot reach the DSH Remote server.',
  unknown: 'Something went wrong.',
}

export function friendlyError(error: unknown): string {
  if (error instanceof RemoteApiError) return friendlyByCode[error.code] ?? error.message
  if (error instanceof Error) {
    if (/network request failed|failed to fetch|websocket/i.test(error.message)) {
      return friendlyByCode.serverUnreachable!
    }
    if (isRpcTimeoutError(error)) return friendlyByCode.RPC_TIMEOUT!
    return error.message
  }
  return friendlyByCode.unknown!
}

export function isRpcTimeoutError(error: unknown): boolean {
  return error instanceof Error && /timed?\s*out|timeout/i.test(error.message)
}

export class TransferError extends Error {
  constructor(message: string, readonly retryable: boolean, readonly status?: number) { super(message); }
}

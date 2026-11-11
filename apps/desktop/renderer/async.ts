/** Bound read-only IPC waits; the underlying operation may still finish later. */
export function withTimeout<T>(work: Promise<T>, label: string, timeoutMs = 20_000): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} timed out. Please retry.`)), timeoutMs);
    work.then(resolve, reject).finally(() => clearTimeout(timer));
  });
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

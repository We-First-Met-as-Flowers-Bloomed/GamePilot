/** Events refresh committed host state; a slow timer recovers missed deliveries. */
export function watchSnapshot<T>(
  ports: {
    read(): Promise<T>;
    subscribe?(refresh: () => void): () => void;
    accept(value: T): void;
    error(): void;
  },
  recoveryMs = 30000,
) {
  let closed = false,
    pending = false,
    queued = false;
  const refresh = async () => {
    if (closed) return;
    if (pending) {
      queued = true;
      return;
    }
    pending = true;
    try {
      const value = await ports.read();
      if (!closed) ports.accept(value);
    } catch {
      if (!closed) ports.error();
    } finally {
      pending = false;
      if (queued && !closed) {
        queued = false;
        void refresh();
      }
    }
  };
  let unsubscribe: (() => void) | undefined;
  try {
    unsubscribe = ports.subscribe?.(() => void refresh());
  } catch {
    /* Initial read and recovery still work. */
  }
  void refresh();
  const timer = setInterval(() => void refresh(), recoveryMs);
  return () => {
    closed = true;
    clearInterval(timer);
    unsubscribe?.();
  };
}

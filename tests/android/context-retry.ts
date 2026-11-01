type RetryOptions<T> = {
  attempts: number;
  perAttemptTimeoutMs: number;
  label: string;
  log: (line: string) => void;
  create: () => Promise<T>;
};

export async function withBoundedRetry<T>({ attempts, perAttemptTimeoutMs, label, log, create }: RetryOptions<T>): Promise<T> {
  if (!Number.isSafeInteger(attempts) || attempts < 1) throw new Error("attempts must be a positive integer");
  if (!Number.isFinite(perAttemptTimeoutMs) || perAttemptTimeoutMs <= 0) {
    throw new Error("perAttemptTimeoutMs must be a positive number");
  }

  for (let attempt = 1; attempt <= attempts; attempt++) {
    const name = `${label}: attempt ${attempt}/${attempts}`;
    log(`${name} starting`);
    let timer: ReturnType<typeof setTimeout>;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`timed out after ${perAttemptTimeoutMs} ms`)), perAttemptTimeoutMs);
      timer.unref();
    });
    const pending = Promise.resolve().then(create);
    // A timed-out device operation can still reject after its replacement has started.
    void pending.catch(() => {});
    try {
      const result = await Promise.race([pending, timeout]);
      log(`${name} succeeded`);
      return result;
    } catch (error) {
      log(`${name} failed: ${error instanceof Error ? error.message : String(error)}`);
      if (attempt === attempts) throw error;
    } finally {
      clearTimeout(timer!);
    }
  }
  throw new Error("unreachable");
}

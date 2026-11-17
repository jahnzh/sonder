// Answers read for one account. The signed-in account can change while a request is out (a session that ended and
// another account signing in on the same device); an answer that arrives after that belongs to the account that
// asked, so it is neither shown nor kept for the one signed in now.

/**
 * The last answer read for an account, which a page shown again starts from, and the way to read a fresh one.
 * `account` names the account signed in now.
 */
export function accountAnswer<T>(account: () => number) {
  let last: { account: number; value: T } | null = null;
  return {
    /** The answer last read for the account signed in now, if any. */
    kept(): T | undefined {
      return last?.account === account() ? last.value : undefined;
    },
    /**
     * Asks, as the account signed in when it is called. The answer is kept and returned only while that account is
     * still the one signed in; otherwise it, or its failure, comes back as null.
     */
    async read(ask: () => Promise<T>): Promise<{ value: T } | null> {
      const asker = account();
      let value: T;
      try {
        value = await ask();
      } catch (error) {
        if (account() !== asker) return null;
        throw error;
      }
      if (account() !== asker) return null;
      last = { account: asker, value };
      return { value };
    },
  };
}

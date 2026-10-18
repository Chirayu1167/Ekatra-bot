/**
 * Runs async tasks one at a time per key (here: per learner), in arrival order.
 *
 * Why: handling a message is "read progress → send lesson → save progress". Without this, two
 * messages from the same learner arriving together could both read the same progress and send
 * the same lesson twice. In-process only: running several app instances needs a shared lock
 * (or a queue) instead.
 */
export class KeyedMutex {
  private readonly tails = new Map<string, Promise<void>>();

  async run<T>(key: string, task: () => Promise<T>): Promise<T> {
    const previous = this.tails.get(key) ?? Promise.resolve();
    const result = previous.then(task);
    const tail = result.then(
      () => undefined,
      () => undefined,
    );
    this.tails.set(key, tail);
    try {
      return await result;
    } finally {
      // Drop the entry once nobody is queued behind us, so the map doesn't grow forever.
      if (this.tails.get(key) === tail) this.tails.delete(key);
    }
  }
}

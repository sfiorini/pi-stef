/**
 * Async semaphore: limits concurrent in-flight operations to `max`.
 *
 * acquire() resolves immediately if a slot is free (else blocks until one is);
 * release() frees a slot or hands it directly to the next waiter (FIFO, no
 * availability change on hand-off so a racing acquirer can't jump the queue).
 *
 * Used by GuestUpstreamClient to cap concurrent chat.qwen.ai calls — Baxia
 * flags the IP when it sees concurrent upstream connections, so default max=1
 * serializes them (SF_QWEN_MAX_CONCURRENCY).
 */
export class Semaphore {
  private available: number;
  private readonly waiters: Array<() => void> = [];

  constructor(max: number) {
    this.available = max < 1 ? 1 : Math.floor(max);
  }

  async acquire(): Promise<void> {
    if (this.available > 0) {
      this.available -= 1;
      return;
    }
    await new Promise<void>((resolve) => {
      this.waiters.push(resolve);
    });
  }

  release(): void {
    const next = this.waiters.shift();
    if (next) {
      next(); // transfer the slot to the next waiter (available unchanged)
      return;
    }
    this.available += 1;
  }
}

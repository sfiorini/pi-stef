import { describe, it, expect } from "vitest";
import { Semaphore } from "../../src/pool/semaphore";

describe("Semaphore", () => {
  it("max=1 serializes: a second acquire blocks until the first releases", async () => {
    const sem = new Semaphore(1);
    await sem.acquire(); // take the only slot
    let secondResolved = false;
    const p2 = sem.acquire().then(() => {
      secondResolved = true;
      sem.release();
    });
    // Still blocked (microtasks flushed)
    await Promise.resolve();
    expect(secondResolved).toBe(false);
    sem.release(); // hand off to p2
    await p2;
    expect(secondResolved).toBe(true);
  });

  it("max=2 allows two concurrent acquires without blocking", async () => {
    const sem = new Semaphore(2);
    await sem.acquire();
    let secondResolved = false;
    const p2 = sem.acquire().then(() => {
      secondResolved = true;
    });
    await p2;
    expect(secondResolved).toBe(true);
    sem.release();
    sem.release();
  });

  it("clamps a non-positive max to 1 (serialize, never deadlock)", async () => {
    const sem = new Semaphore(0);
    await sem.acquire(); // clamped to 1 → first acquire succeeds
    let secondResolved = false;
    const p2 = sem.acquire().then(() => {
      secondResolved = true;
      sem.release();
    });
    await Promise.resolve();
    expect(secondResolved).toBe(false); // blocked — max is effectively 1, not 0
    sem.release();
    await p2;
    expect(secondResolved).toBe(true);
  });
});

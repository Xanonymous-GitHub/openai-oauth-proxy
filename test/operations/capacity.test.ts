import { describe, expect, it } from "vitest";
import { TurnCapacity } from "../../src/operations/capacity.js";

describe("TurnCapacity", () => {
  it("admits four turns and queues the next 32 in FIFO order", async () => {
    const capacity = new TurnCapacity(4, 32);
    const active = await Promise.all(
      Array.from({ length: 4 }, () => capacity.acquire()),
    );
    const admitted: number[] = [];
    const queued = Array.from({ length: 32 }, (_, index) =>
      capacity.acquire().then((permit) => {
        admitted.push(index);
        return permit;
      }),
    );

    await expect(capacity.acquire()).rejects.toMatchObject({
      status: 429,
      code: "queue_full",
    });
    expect(capacity.active).toBe(4);
    expect(capacity.queued).toBe(32);

    const running = [...active];
    for (let index = 0; index < queued.length; index += 1) {
      running.shift()?.release();
      const queuedPermit = queued[index];
      if (!queuedPermit) throw new Error("Missing queued permit");
      const permit = await queuedPermit;
      expect(admitted).toEqual(Array.from({ length: index + 1 }, (_, i) => i));
      running.push(permit);
    }
    for (const permit of running) permit.release();

    expect(capacity.active).toBe(0);
    expect(capacity.queued).toBe(0);
  });

  it("removes aborted waiters without consuming a permit", async () => {
    const capacity = new TurnCapacity(1, 2);
    const active = await capacity.acquire();
    const controller = new AbortController();
    const aborted = capacity.acquire(controller.signal);
    const next = capacity.acquire();

    controller.abort();
    await expect(aborted).rejects.toMatchObject({
      status: 499,
      code: "request_aborted",
    });
    expect(capacity.queued).toBe(1);

    active.release();
    const nextPermit = await next;
    expect(capacity.active).toBe(1);
    nextPermit.release();
    expect(capacity.active).toBe(0);
  });

  it("makes release idempotent", async () => {
    const capacity = new TurnCapacity(1, 1);
    const first = await capacity.acquire();
    const secondPromise = capacity.acquire();

    first.release();
    first.release();
    const second = await secondPromise;
    expect(capacity.active).toBe(1);

    second.release();
    second.release();
    expect(capacity.active).toBe(0);
  });

  it("rejects queued and new work when draining while active work finishes", async () => {
    const capacity = new TurnCapacity(1, 1);
    const active = await capacity.acquire();
    const queued = capacity.acquire();

    capacity.beginDrain();

    await expect(queued).rejects.toMatchObject({
      status: 503,
      code: "service_unavailable",
    });
    await expect(capacity.acquire()).rejects.toMatchObject({
      status: 503,
      code: "service_unavailable",
    });
    expect(capacity.draining).toBe(true);
    expect(capacity.queued).toBe(0);

    const idle = capacity.whenIdle();
    active.release();
    await idle;
  });

  it("invalidates all active permits idempotently after the drain deadline", async () => {
    const capacity = new TurnCapacity(2, 0);
    const first = await capacity.acquire();
    const second = await capacity.acquire();

    capacity.beginDrain();
    capacity.invalidateActive();
    capacity.invalidateActive();

    expect(capacity.active).toBe(0);
    await expect(capacity.whenIdle()).resolves.toBeUndefined();
    first.release();
    second.release();
    expect(capacity.active).toBe(0);
  });
});

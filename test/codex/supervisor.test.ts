import { EventEmitter } from "node:events";
import { existsSync } from "node:fs";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  type ChildFactory,
  type Clock,
  type CodexSupervisor,
  createSupervisor as createCodexSupervisor,
} from "../../src/codex/supervisor.js";
import { CodexGenerationChangedError } from "../../src/codex/transport.js";

const config = {
  codexBin: "/opt/codex",
  codexHome: "/data/codex",
};

const clock: Clock = {
  now: () => Date.now(),
  setTimeout: (callback, delay) => setTimeout(callback, delay),
  clearTimeout: (timer) => clearTimeout(timer),
};

const supervisors = new Set<CodexSupervisor>();
const children = new Set<FakeChild>();
const workingDirectories = new Set<string>();

class FakeChild extends EventEmitter {
  readonly stdin = new PassThrough();
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly sent: Array<Record<string, unknown>> = [];
  readonly killSignals: Array<NodeJS.Signals | number | undefined> = [];
  autoExitOnKill = true;
  killCount = 0;
  #closed = false;
  #exited = false;

  constructor() {
    super();
    this.stdin.on("data", (chunk: Buffer) => {
      for (const line of chunk.toString().trim().split("\n")) {
        if (line) this.sent.push(JSON.parse(line) as Record<string, unknown>);
      }
    });
  }

  respondTo(index: number, result: unknown): void {
    const request = this.sent[index];
    if (!request) throw new Error(`Missing request ${index}`);
    this.stdout.write(`${JSON.stringify({ id: request.id, result })}\n`);
  }

  crash(): void {
    this.finish(1);
  }

  finish(code: number | null = 0, signal: NodeJS.Signals | null = null): void {
    if (!this.#exited) {
      this.#exited = true;
      this.emit("exit", code, signal);
    }
    this.close(code, signal);
  }

  close(
    code: number | null = null,
    signal: NodeJS.Signals | null = null,
  ): void {
    if (this.#closed) return;
    this.#closed = true;
    this.emit("close", code, signal);
  }

  kill(signal?: NodeJS.Signals | number): boolean {
    this.killCount += 1;
    this.killSignals.push(signal);
    if (this.autoExitOnKill) {
      this.finish(null, typeof signal === "string" ? signal : null);
    }
    return true;
  }
}

function fakeChild(): FakeChild {
  const child = new FakeChild();
  children.add(child);
  return child;
}

function createSupervisor(
  options: Parameters<typeof createCodexSupervisor>[0],
): CodexSupervisor {
  const childFactory = options.childFactory;
  if (!childFactory) throw new Error("Tests require a child factory");
  const supervisor = createCodexSupervisor({
    ...options,
    childFactory: (command, args, spawnOptions) => {
      if (typeof spawnOptions.cwd === "string") {
        workingDirectories.add(spawnOptions.cwd);
      }
      return childFactory(command, args, spawnOptions);
    },
  });
  supervisors.add(supervisor);
  return supervisor;
}

function factoryFor(children: FakeChild[]): ChildFactory {
  return () => {
    const child = children.shift();
    if (!child) throw new Error("No fake child available");
    return child;
  };
}

async function flush(): Promise<void> {
  await vi.advanceTimersByTimeAsync(0);
}

async function makeReady(
  supervisor: CodexSupervisor,
  child: FakeChild,
  started = supervisor.start(),
) {
  expect(child.sent[0]).toMatchObject({
    method: "initialize",
    params: {
      clientInfo: {
        name: "openai_oauth_proxy",
        title: "OpenAI OAuth Proxy",
      },
      capabilities: { experimentalApi: true },
    },
  });
  child.respondTo(0, { userAgent: "fixture" });
  await flush();
  expect(child.sent[1]).toEqual({ method: "initialized", params: {} });
  return started;
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(0);
});

afterEach(async () => {
  for (const child of children) child.autoExitOnKill = true;
  const stops = [...supervisors].map((supervisor) => supervisor.stop());
  for (const child of children) child.finish();
  await vi.runAllTimersAsync();
  await Promise.all(stops);
  expect(vi.getTimerCount()).toBe(0);
  for (const child of children) {
    expect(child.listenerCount("error")).toBe(0);
    expect(child.listenerCount("exit")).toBe(0);
    expect(child.listenerCount("close")).toBe(0);
  }
  for (const directory of workingDirectories) {
    expect(existsSync(directory)).toBe(false);
  }
  supervisors.clear();
  children.clear();
  workingDirectories.clear();
  vi.useRealTimers();
});

describe("CodexSupervisor", () => {
  it("handshakes with experimental API enabled", async () => {
    const child = fakeChild();
    const childFactory = vi.fn(factoryFor([child]));
    const supervisor = createSupervisor({
      config,
      childFactory,
      clock,
      random: () => 0,
    });

    const host = await makeReady(supervisor, child);

    expect(host).toBeDefined();
    expect(supervisor.ready()).toBe(true);
    expect(supervisor.health()).toBe(true);
    expect(supervisor.generation()).toBe(1);
    expect(childFactory).toHaveBeenCalledWith(
      "/opt/codex",
      ["app-server"],
      expect.objectContaining({
        cwd: expect.any(String),
        env: expect.objectContaining({ CODEX_HOME: "/data/codex" }),
        stdio: ["pipe", "pipe", "pipe"],
      }),
    );
    expect(Object.keys(host)).not.toContain("request");
  });

  it("removes readiness, invalidates active requests, and routes later calls to the replacement host", async () => {
    const first = fakeChild();
    const second = fakeChild();
    const supervisor = createSupervisor({
      config,
      childFactory: factoryFor([first, second]),
      clock,
      random: () => 0,
    });
    const facade = await makeReady(supervisor, first);
    const pending = facade.accountRead(false);
    expect(first.sent[2]).toMatchObject({ method: "account/read" });

    first.crash();

    expect(supervisor.ready()).toBe(false);
    await expect(pending).rejects.toBeInstanceOf(CodexGenerationChangedError);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(second.sent[0]).toMatchObject({ method: "initialize" });
    second.respondTo(0, { userAgent: "replacement" });
    await flush();
    expect(supervisor.ready()).toBe(true);
    expect(supervisor.generation()).toBe(2);

    const later = facade.accountRead(true);
    expect(second.sent[2]).toMatchObject({
      method: "account/read",
      params: { refreshToken: true },
    });
    second.respondTo(2, { account: null, requiresOpenaiAuth: true });
    await expect(later).resolves.toMatchObject({ requiresOpenaiAuth: true });
    await expect(supervisor.start()).resolves.toBe(facade);
  });

  it("uses five deterministic recovery delays before becoming unhealthy", async () => {
    const first = fakeChild();
    const spawnTimes: number[] = [];
    const childFactory: ChildFactory = () => {
      spawnTimes.push(Date.now());
      if (spawnTimes.length === 1) return first;
      throw new Error("spawn failed with secret-token");
    };
    const supervisor = createSupervisor({
      config,
      childFactory,
      clock,
      random: () => 0,
    });
    await makeReady(supervisor, first);

    first.crash();
    for (const delay of [1_000, 2_000, 4_000, 8_000, 16_000]) {
      expect(supervisor.health()).toBe(true);
      await vi.advanceTimersByTimeAsync(delay);
    }

    expect(spawnTimes).toEqual([0, 1_000, 3_000, 7_000, 15_000, 31_000]);
    expect(supervisor.ready()).toBe(false);
    expect(supervisor.health()).toBe(false);
  });

  it("adds up to 25 percent jitter to a recovery delay", async () => {
    const first = fakeChild();
    const second = fakeChild();
    const supervisor = createSupervisor({
      config,
      childFactory: factoryFor([first, second]),
      clock,
      random: () => 1,
    });
    await makeReady(supervisor, first);

    first.crash();
    await vi.advanceTimersByTimeAsync(1_249);
    expect(second.sent).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(second.sent[0]).toMatchObject({ method: "initialize" });
  });

  it("terminates an uninitialized child after 30 seconds", async () => {
    const first = fakeChild();
    const second = fakeChild();
    const supervisor = createSupervisor({
      config,
      childFactory: factoryFor([first, second]),
      clock,
      random: () => 0,
    });
    const started = supervisor.start();

    await vi.advanceTimersByTimeAsync(29_999);
    expect(first.killCount).toBe(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(first.killCount).toBe(1);
    expect(supervisor.ready()).toBe(false);
    await vi.advanceTimersByTimeAsync(1_000);
    await makeReady(supervisor, second, started);
    await expect(started).resolves.toBeDefined();
  });

  it("recovers from malformed protocol output", async () => {
    const first = fakeChild();
    const second = fakeChild();
    const supervisor = createSupervisor({
      config,
      childFactory: factoryFor([first, second]),
      clock,
      random: () => 0,
    });
    await makeReady(supervisor, first);

    first.stdout.write('{"access_token":"secret-token"\n');
    await flush();

    expect(supervisor.ready()).toBe(false);
    expect(first.killCount).toBe(1);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(second.sent[0]).toMatchObject({ method: "initialize" });
  });

  it("waits for child exit before recovery and escalates termination", async () => {
    const first = fakeChild();
    first.autoExitOnKill = false;
    const second = fakeChild();
    const supervisor = createSupervisor({
      config,
      childFactory: factoryFor([first, second]),
      clock,
      random: () => 0,
    });
    await makeReady(supervisor, first);

    first.stdout.write("malformed\n");
    await flush();
    expect(first.killSignals).toEqual(["SIGTERM"]);
    await vi.advanceTimersByTimeAsync(4_999);
    expect(first.killSignals).toEqual(["SIGTERM"]);
    expect(second.sent).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(first.killSignals).toEqual(["SIGTERM", "SIGKILL"]);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(second.sent).toHaveLength(0);

    first.finish(null, "SIGKILL");
    await flush();
    await vi.advanceTimersByTimeAsync(999);
    expect(second.sent).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(second.sent[0]).toMatchObject({ method: "initialize" });
  });

  it("recovers when a child errors and closes without exiting", async () => {
    const first = fakeChild();
    first.autoExitOnKill = false;
    const second = fakeChild();
    const supervisor = createSupervisor({
      config,
      childFactory: factoryFor([first, second]),
      clock,
      random: () => 0,
    });
    const started = supervisor.start();
    void started.catch(() => undefined);

    first.emit("error", new Error("spawn failed"));
    await vi.advanceTimersByTimeAsync(5_000);
    expect(first.killSignals).toEqual(["SIGTERM", "SIGKILL"]);
    expect(second.sent).toHaveLength(0);
    first.close();
    await flush();
    await vi.advanceTimersByTimeAsync(1_000);
    await makeReady(supervisor, second, started);

    await expect(started).resolves.toBeDefined();
  });

  it("settles stop for a failed spawn that closes without exiting", async () => {
    const child = fakeChild();
    child.autoExitOnKill = false;
    const supervisor = createSupervisor({
      config,
      childFactory: factoryFor([child]),
      clock,
      random: () => 0,
    });
    const started = supervisor.start();
    void started.catch(() => undefined);
    child.emit("error", new Error("spawn failed"));
    let stopped = false;

    const stopping = supervisor.stop().then(() => {
      stopped = true;
    });
    await vi.advanceTimersByTimeAsync(5_000);
    expect(stopped).toBe(false);
    child.close();
    await flush();
    const settledAfterClose = stopped;
    if (!settledAfterClose) {
      child.finish();
      await stopping;
    }

    expect(settledAfterClose).toBe(true);
    await expect(started).rejects.toBeInstanceOf(CodexGenerationChangedError);
  });

  it("handles late child errors without overlapping recovery generations", async () => {
    const first = fakeChild();
    first.autoExitOnKill = false;
    const second = fakeChild();
    const childFactory = vi.fn(factoryFor([first, second]));
    const supervisor = createSupervisor({
      config,
      childFactory,
      clock,
      random: () => 0,
    });
    const started = supervisor.start();
    void started.catch(() => undefined);

    first.emit("error", new Error("spawn failed"));
    await flush();
    expect(() =>
      first.emit("error", new Error("late kill error")),
    ).not.toThrow();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(childFactory).toHaveBeenCalledOnce();
    first.close();
    await flush();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(childFactory).toHaveBeenCalledTimes(2);
    await makeReady(supervisor, second, started);

    await expect(started).resolves.toBeDefined();
  });

  it("does not consume host notifications while monitoring protocol health", async () => {
    const child = fakeChild();
    const supervisor = createSupervisor({
      config,
      childFactory: factoryFor([child]),
      clock,
      random: () => 0,
    });
    const facade = await makeReady(supervisor, child);
    let delivered: unknown;
    void facade
      .events()
      [Symbol.asyncIterator]()
      .next()
      .then((event) => {
        delivered = event.value;
      });

    child.stdout.write(
      `${JSON.stringify({ method: "thread/started", params: {} })}\n`,
    );
    await flush();

    expect(delivered).toMatchObject({
      generation: 1,
      method: "thread/started",
    });
  });

  it("resets the recovery budget after ten stable minutes", async () => {
    const first = fakeChild();
    const second = fakeChild();
    const third = fakeChild();
    const supervisor = createSupervisor({
      config,
      childFactory: factoryFor([first, second, third]),
      clock,
      random: () => 0,
    });
    await makeReady(supervisor, first);
    first.crash();
    await vi.advanceTimersByTimeAsync(1_000);
    await makeReady(supervisor, second);

    await vi.advanceTimersByTimeAsync(600_000);
    second.crash();
    await vi.advanceTimersByTimeAsync(999);
    expect(third.sent).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(third.sent[0]).toMatchObject({ method: "initialize" });
  });

  it("stops idempotently after giving the drain hook up to 30 seconds", async () => {
    const child = fakeChild();
    const drain = vi.fn(() => new Promise<void>(() => undefined));
    const childFactory = vi.fn(factoryFor([child]));
    const supervisor = createSupervisor({
      config,
      childFactory,
      clock,
      random: () => 0,
      drain,
    });
    await makeReady(supervisor, child);

    const firstStop = supervisor.stop();
    const secondStop = supervisor.stop();
    expect(firstStop).toBe(secondStop);
    expect(supervisor.ready()).toBe(false);
    expect(child.killCount).toBe(0);
    await vi.advanceTimersByTimeAsync(29_999);
    expect(child.killCount).toBe(0);
    await vi.advanceTimersByTimeAsync(1);
    await firstStop;

    expect(drain).toHaveBeenCalledOnce();
    expect(child.killCount).toBe(1);
    child.crash();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(childFactory).toHaveBeenCalledOnce();
    expect(supervisor.health()).toBe(true);
    expect(child.listenerCount("error")).toBe(0);
    expect(child.listenerCount("exit")).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("invalidates the generation after the drain hook completes", async () => {
    const child = fakeChild();
    let finishDrain: (() => void) | undefined;
    const drain = () =>
      new Promise<void>((resolve) => {
        finishDrain = resolve;
      });
    const supervisor = createSupervisor({
      config,
      childFactory: factoryFor([child]),
      clock,
      random: () => 0,
      drain,
    });
    const facade = await makeReady(supervisor, child);
    const pending = facade.modelList({});
    let invalidated = false;
    void pending.catch(() => {
      invalidated = true;
    });

    const stopping = supervisor.stop();
    await flush();
    expect(invalidated).toBe(false);
    finishDrain?.();
    await stopping;

    await expect(pending).rejects.toBeInstanceOf(CodexGenerationChangedError);
    expect(child.killCount).toBe(1);
  });

  it("does not finish stop until the child exits after escalation", async () => {
    const child = fakeChild();
    child.autoExitOnKill = false;
    const supervisor = createSupervisor({
      config,
      childFactory: factoryFor([child]),
      clock,
      random: () => 0,
    });
    await makeReady(supervisor, child);
    let stopped = false;

    const stopping = supervisor.stop().then(() => {
      stopped = true;
    });
    await flush();
    expect(child.killSignals).toEqual(["SIGTERM"]);
    expect(stopped).toBe(false);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(child.killSignals).toEqual(["SIGTERM", "SIGKILL"]);
    expect(stopped).toBe(false);

    child.finish(null, "SIGKILL");
    await stopping;
    expect(stopped).toBe(true);
  });

  it("terminates the child when the drain hook throws", async () => {
    const child = fakeChild();
    const supervisor = createSupervisor({
      config,
      childFactory: factoryFor([child]),
      clock,
      random: () => 0,
      drain: () => {
        throw new Error("drain failed with secret-token");
      },
    });
    await makeReady(supervisor, child);

    await expect(supervisor.stop()).resolves.toBeUndefined();
    expect(child.killCount).toBe(1);
  });

  it("lets the drain hook interrupt through the current facade", async () => {
    const child = fakeChild();
    let facade: Awaited<ReturnType<CodexSupervisor["start"]>> | undefined;
    const drain = async () => {
      const interrupted = facade?.turnInterrupt({
        threadId: "thread-1",
        turnId: "turn-1",
      });
      child.respondTo(2, {});
      await interrupted;
    };
    const supervisor = createSupervisor({
      config,
      childFactory: factoryFor([child]),
      clock,
      random: () => 0,
      drain,
    });
    facade = await makeReady(supervisor, child);

    const stopping = supervisor.stop();
    expect(supervisor.ready()).toBe(false);
    await stopping;

    expect(child.sent[2]).toMatchObject({ method: "turn/interrupt" });
    expect(child.killCount).toBe(1);
  });
});

import {
  type ChildProcessWithoutNullStreams,
  type SpawnOptionsWithoutStdio,
  spawn,
} from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CodexHost } from "./host.js";
import {
  CodexGenerationChangedError,
  type CodexTransport,
  createJsonlTransport,
} from "./transport.js";

const INITIALIZATION_TIMEOUT_MS = 30_000;
const STABLE_RESET_MS = 600_000;
const DRAIN_TIMEOUT_MS = 30_000;
const TERMINATION_GRACE_MS = 5_000;
const RECOVERY_DELAYS_MS = [1_000, 2_000, 4_000, 8_000, 16_000] as const;

type Timer = ReturnType<typeof setTimeout>;

export interface Clock {
  now(): number;
  setTimeout(callback: () => void, delay: number): Timer;
  clearTimeout(timer: Timer): void;
}

export interface SupervisorChild {
  stdin: ChildProcessWithoutNullStreams["stdin"];
  stdout: ChildProcessWithoutNullStreams["stdout"];
  stderr: ChildProcessWithoutNullStreams["stderr"];
  on(event: "error", listener: (error: Error) => void): unknown;
  once(
    event: "exit",
    listener: (code: number | null, signal: NodeJS.Signals | null) => void,
  ): unknown;
  once(
    event: "close",
    listener: (code: number | null, signal: NodeJS.Signals | null) => void,
  ): unknown;
  off(event: "error", listener: (error: Error) => void): unknown;
  off(
    event: "exit",
    listener: (code: number | null, signal: NodeJS.Signals | null) => void,
  ): unknown;
  off(
    event: "close",
    listener: (code: number | null, signal: NodeJS.Signals | null) => void,
  ): unknown;
  kill(signal?: NodeJS.Signals | number): boolean;
}

export type ChildFactory = (
  command: string,
  args: string[],
  options: SpawnOptionsWithoutStdio & {
    stdio: ["pipe", "pipe", "pipe"];
  },
) => SupervisorChild;

interface SupervisorConfig {
  codexBin: string;
  codexHome: string;
}

interface SupervisorOptions {
  config: SupervisorConfig;
  childFactory?: ChildFactory;
  clock?: Clock;
  random?: () => number;
  drain?: () => Promise<void>;
}

type SupervisorState =
  | { type: "stopped" }
  | { type: "starting"; attempt: number }
  | { type: "ready"; since: number }
  | { type: "recovering"; attempt: number }
  | { type: "unhealthy"; failures: 5 };

interface Generation {
  number: number;
  attempt: number;
  child: SupervisorChild;
  transport: CodexTransport;
  closed: boolean;
  close: Promise<void>;
  termination: Promise<void> | undefined;
  onError: (error: Error) => void;
  onExit: (code: number | null, signal: NodeJS.Signals | null) => void;
  onClose: (code: number | null, signal: NodeJS.Signals | null) => void;
}

const systemClock: Clock = {
  now: () => Date.now(),
  setTimeout: (callback, delay) => setTimeout(callback, delay),
  clearTimeout: (timer) => clearTimeout(timer),
};

const spawnChild: ChildFactory = (command, args, options) =>
  spawn(command, args, options);

export class CodexSupervisor {
  readonly #config: SupervisorConfig;
  readonly #childFactory: ChildFactory;
  readonly #clock: Clock;
  readonly #random: () => number;
  readonly #drain: (() => Promise<void>) | undefined;
  readonly #workingDirectory: string;
  readonly #facade: CodexHost;
  #state: SupervisorState = { type: "stopped" };
  #current: Generation | undefined;
  #retiring: Generation | undefined;
  #generation = 0;
  #startPromise: Promise<CodexHost> | undefined;
  #resolveStart: ((host: CodexHost) => void) | undefined;
  #rejectStart: ((error: Error) => void) | undefined;
  #startSettled = false;
  #stopPromise: Promise<void> | undefined;
  #stopping = false;
  #initializationTimer: Timer | undefined;
  #recoveryTimer: Timer | undefined;
  #stableTimer: Timer | undefined;

  constructor(options: SupervisorOptions) {
    this.#config = options.config;
    this.#childFactory = options.childFactory ?? spawnChild;
    this.#clock = options.clock ?? systemClock;
    this.#random = options.random ?? Math.random;
    this.#drain = options.drain;
    this.#workingDirectory = mkdtempSync(
      join(tmpdir(), "openai-oauth-proxy-codex-"),
    );
    this.#facade = this.createFacade();
  }

  start(): Promise<CodexHost> {
    if (this.#startPromise) return this.#startPromise;
    if (this.#stopping) {
      return Promise.reject(new Error("Codex supervisor is stopped"));
    }

    this.#startPromise = new Promise((resolve, reject) => {
      this.#resolveStart = resolve;
      this.#rejectStart = reject;
    });
    this.launch(0);
    return this.#startPromise;
  }

  health(): boolean {
    return this.#state.type !== "unhealthy";
  }

  ready(): boolean {
    return !this.#stopping && this.#state.type === "ready";
  }

  generation(): number {
    return this.#generation;
  }

  stop(): Promise<void> {
    if (!this.#stopPromise) this.#stopPromise = this.performStop();
    return this.#stopPromise;
  }

  private launch(attempt: number): void {
    if (this.#stopping) return;
    this.clearTimer("recovery");
    this.#state = { type: "starting", attempt };
    const generation = ++this.#generation;

    let child: SupervisorChild;
    try {
      child = this.#childFactory(this.#config.codexBin, ["app-server"], {
        cwd: this.#workingDirectory,
        env: { ...process.env, CODEX_HOME: this.#config.codexHome },
        stdio: ["pipe", "pipe", "pipe"],
      });
    } catch {
      this.recoverAfter(attempt);
      return;
    }

    child.stderr.resume();
    const transport = createJsonlTransport({
      input: child.stdout,
      output: child.stdin,
      generation,
    });
    let resolveClose: (() => void) | undefined;
    const close = new Promise<void>((resolve) => {
      resolveClose = resolve;
    });
    let current: Generation;
    const onError = (): void => this.failGeneration(generation, true);
    const onExit = (): void => this.failGeneration(generation, false);
    const onClose = (): void => {
      current.closed = true;
      resolveClose?.();
      resolveClose = undefined;
      child.off("error", onError);
      child.off("exit", onExit);
      this.failGeneration(generation, false);
    };
    current = {
      number: generation,
      attempt,
      child,
      transport,
      closed: false,
      close,
      termination: undefined,
      onError,
      onExit,
      onClose,
    };
    this.#current = current;
    child.on("error", onError);
    child.once("exit", onExit);
    child.once("close", onClose);

    const controller = new AbortController();
    this.#initializationTimer = this.#clock.setTimeout(() => {
      controller.abort();
      this.failGeneration(generation, true);
    }, INITIALIZATION_TIMEOUT_MS);

    void transport
      .initialize(
        {
          clientInfo: {
            name: "openai_oauth_proxy",
            title: "OpenAI OAuth Proxy",
            version: "0.1.0",
          },
          capabilities: {
            experimentalApi: true,
            requestAttestation: false,
          },
        },
        controller.signal,
      )
      .then(() => {
        if (this.#stopping || this.#current?.number !== generation) return;
        this.clearTimer("initialization");
        transport.initialized();
        this.#state = { type: "ready", since: this.#clock.now() };
        this.#stableTimer = this.#clock.setTimeout(() => {
          if (this.#current?.number === generation) this.#current.attempt = 0;
        }, STABLE_RESET_MS);
        void transport.failure.then(() =>
          this.failGeneration(generation, true),
        );
        if (!this.#startSettled) {
          this.#startSettled = true;
          this.#resolveStart?.(this.#facade);
        }
      })
      .catch(() => this.failGeneration(generation, true));
  }

  private failGeneration(number: number, terminate: boolean): void {
    if (this.#stopping || this.#current?.number !== number) return;
    const failed = this.#current;
    this.#current = undefined;
    this.#state = { type: "recovering", attempt: failed.attempt + 1 };
    this.clearTimer("initialization");
    this.clearTimer("stable");
    failed.transport.invalidateGeneration();
    this.#retiring = failed;
    const retirement = terminate ? this.terminateChild(failed) : failed.close;
    void retirement.then(() => {
      if (this.#retiring !== failed) return;
      this.#retiring = undefined;
      if (!this.#stopping) this.recoverAfter(failed.attempt);
    });
  }

  private recoverAfter(failedAttempt: number): void {
    if (this.#stopping) return;
    const baseDelay = RECOVERY_DELAYS_MS[failedAttempt];
    if (baseDelay === undefined) {
      this.#state = { type: "unhealthy", failures: 5 };
      if (!this.#startSettled) {
        this.#startSettled = true;
        this.#rejectStart?.(new Error("Codex supervisor is unhealthy"));
      }
      return;
    }

    const attempt = failedAttempt + 1;
    this.#state = { type: "recovering", attempt };
    const jitter = Math.max(0, Math.min(1, this.#random()));
    this.#recoveryTimer = this.#clock.setTimeout(
      () => this.launch(attempt),
      baseDelay * (1 + 0.25 * jitter),
    );
  }

  private createFacade(): CodexHost {
    const supervisor = this;
    return {
      get generation() {
        return supervisor.generation();
      },
      accountRead: (refreshToken, signal) =>
        this.readyHost().accountRead(refreshToken, signal),
      loginStart: (params, signal) =>
        this.readyHost().loginStart(params, signal),
      loginCancel: (params, signal) =>
        this.readyHost().loginCancel(params, signal),
      logout: (signal) => this.readyHost().logout(signal),
      modelList: (params, signal) => this.readyHost().modelList(params, signal),
      threadStart: (params, signal) =>
        this.readyHost().threadStart(params, signal),
      threadResume: (params, signal) =>
        this.readyHost().threadResume(params, signal),
      threadFork: (params, signal) =>
        this.readyHost().threadFork(params, signal),
      threadInjectItems: (params, signal) =>
        this.readyHost().threadInjectItems(params, signal),
      threadDelete: (params, signal) =>
        this.readyHost().threadDelete(params, signal),
      turnStart: (params, signal) => this.readyHost().turnStart(params, signal),
      turnInterrupt: (params, signal) =>
        this.readyHost().turnInterrupt(params, signal),
      events: () => this.readyHost().events(),
      toolCalls: () => this.readyHost().toolCalls(),
    };
  }

  private readyHost(): CodexHost {
    if (this.#state.type !== "ready" || !this.#current) {
      throw new CodexGenerationChangedError();
    }
    return this.#current.transport.host;
  }

  private async performStop(): Promise<void> {
    this.#stopping = true;
    this.clearTimer("initialization");
    this.clearTimer("recovery");
    this.clearTimer("stable");
    const generation = this.#current ?? this.#retiring;
    if (!this.#startSettled && this.#startPromise) {
      this.#startSettled = true;
      this.#rejectStart?.(new CodexGenerationChangedError());
    }

    await this.waitForDrain();
    generation?.transport.invalidateGeneration();
    if (generation) await this.terminateChild(generation);
    this.#current = undefined;
    this.#retiring = undefined;
    this.#state = { type: "stopped" };
    rmSync(this.#workingDirectory, { recursive: true, force: true });
  }

  private terminateChild(generation: Generation): Promise<void> {
    if (generation.termination) return generation.termination;
    generation.termination = (async () => {
      if (generation.closed) return;
      generation.child.kill("SIGTERM");
      if (generation.closed) return;
      const closedGracefully = await this.waitForClose(
        generation,
        TERMINATION_GRACE_MS,
      );
      if (closedGracefully) return;
      generation.child.kill("SIGKILL");
      await generation.close;
    })();
    return generation.termination;
  }

  private waitForClose(
    generation: Generation,
    timeout: number,
  ): Promise<boolean> {
    return new Promise((resolve) => {
      let settled = false;
      const finish = (exited: boolean): void => {
        if (settled) return;
        settled = true;
        this.#clock.clearTimeout(timer);
        resolve(exited);
      };
      const timer = this.#clock.setTimeout(() => finish(false), timeout);
      void generation.close.then(() => finish(true));
    });
  }

  private waitForDrain(): Promise<void> {
    const drain = this.#drain;
    if (!drain) return Promise.resolve();
    return new Promise((resolve) => {
      const timer = this.#clock.setTimeout(resolve, DRAIN_TIMEOUT_MS);
      void Promise.resolve()
        .then(drain)
        .then(
          () => {
            this.#clock.clearTimeout(timer);
            resolve();
          },
          () => {
            this.#clock.clearTimeout(timer);
            resolve();
          },
        );
    });
  }

  private clearTimer(timer: "initialization" | "recovery" | "stable"): void {
    const field =
      timer === "initialization"
        ? this.#initializationTimer
        : timer === "recovery"
          ? this.#recoveryTimer
          : this.#stableTimer;
    if (field) this.#clock.clearTimeout(field);
    if (timer === "initialization") this.#initializationTimer = undefined;
    else if (timer === "recovery") this.#recoveryTimer = undefined;
    else this.#stableTimer = undefined;
  }
}

export function createSupervisor(options: SupervisorOptions): CodexSupervisor {
  return new CodexSupervisor(options);
}

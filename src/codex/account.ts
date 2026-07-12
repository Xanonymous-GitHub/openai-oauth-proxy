import {
  type AccountHostNotification,
  eventDispatcherFor,
  type HostEventDispatcher,
} from "../turns/events.js";
import type { PlanType } from "./generated/PlanType.js";
import type { CodexHost } from "./host.js";
import { CodexGenerationChangedError } from "./transport.js";

export type AccountState =
  | { type: "checking" }
  | { type: "signed_out" }
  | { type: "ready"; email: string | null; planType: PlanType }
  | {
      type: "login_pending";
      loginId: string;
      verificationUrl: string;
      userCode: string;
    }
  | { type: "error"; code: "authentication_required" };

export interface AccountController {
  state(): AccountState;
  login(): Promise<AccountState>;
  cancel(): Promise<void>;
  refresh(): Promise<void>;
  logout(): Promise<void>;
}

const AUTHENTICATION_ERROR: AccountState = {
  type: "error",
  code: "authentication_required",
};

export class AccountManager implements AccountController {
  readonly #host: CodexHost;
  readonly #dispatcher: HostEventDispatcher;
  #state: AccountState = { type: "checking" };
  #generation: number | undefined;
  #readingGeneration: number | undefined;
  #loginId: string | undefined;
  #operationEpoch = 0;
  #logoutEpoch: number | undefined;
  #started = false;
  #startPromise: Promise<void> | undefined;
  #unsubscribe: (() => void) | undefined;

  constructor(
    host: CodexHost,
    dispatcher: HostEventDispatcher = eventDispatcherFor(host),
  ) {
    this.#host = host;
    this.#dispatcher = dispatcher;
  }

  start(): Promise<void> {
    if (this.#startPromise) return this.#startPromise;
    this.#started = true;
    this.subscribe();
    this.#startPromise = this.readCurrentGeneration();
    return this.#startPromise;
  }

  state(): AccountState {
    this.ensureGeneration();
    return this.#state;
  }

  ready(): boolean {
    this.ensureGeneration();
    const generation = this.currentGeneration();
    return (
      generation !== undefined &&
      generation === this.#generation &&
      this.#state.type === "ready"
    );
  }

  async login(): Promise<AccountState> {
    if (this.#logoutEpoch !== undefined) {
      throw new Error("Device login unavailable");
    }
    const generation = this.currentGeneration();
    const epoch = ++this.#operationEpoch;
    this.#state = { type: "checking" };
    try {
      const response = await this.#host.loginStart({
        type: "chatgptDeviceCode",
      });
      if (
        response.type !== "chatgptDeviceCode" ||
        generation === undefined ||
        epoch !== this.#operationEpoch ||
        this.currentGeneration() !== generation
      ) {
        throw new Error("Device login unavailable");
      }
      this.#generation = generation;
      this.#loginId = response.loginId;
      this.#state = {
        type: "login_pending",
        loginId: response.loginId,
        verificationUrl: response.verificationUrl,
        userCode: response.userCode,
      };
      return this.#state;
    } catch {
      if (epoch === this.#operationEpoch) {
        this.#state = AUTHENTICATION_ERROR;
      }
      throw new Error("Device login unavailable");
    }
  }

  async cancel(): Promise<void> {
    if (this.#logoutEpoch !== undefined) return;
    const epoch = ++this.#operationEpoch;
    const loginId = this.#loginId;
    this.#loginId = undefined;
    this.#state = { type: "signed_out" };
    if (!loginId) return;
    try {
      await this.#host.loginCancel({ loginId });
    } catch {
      if (epoch === this.#operationEpoch) this.#state = AUTHENTICATION_ERROR;
      throw new Error("Authentication unavailable");
    }
  }

  refresh(): Promise<void> {
    if (this.#logoutEpoch !== undefined) return Promise.resolve();
    return this.readCurrentGeneration();
  }

  async logout(): Promise<void> {
    const epoch = ++this.#operationEpoch;
    this.#logoutEpoch = epoch;
    this.#loginId = undefined;
    this.#state = { type: "signed_out" };
    try {
      await this.#host.logout();
      if (this.#logoutEpoch !== epoch) return;
      this.#operationEpoch += 1;
      this.#logoutEpoch = undefined;
      this.#readingGeneration = undefined;
      this.#generation = this.currentGeneration();
      this.#state = { type: "signed_out" };
    } catch {
      if (this.#logoutEpoch === epoch) {
        this.#operationEpoch += 1;
        this.#logoutEpoch = undefined;
        this.#readingGeneration = undefined;
        this.#state = AUTHENTICATION_ERROR;
      }
      throw new Error("Authentication unavailable");
    }
  }

  private subscribe(): void {
    this.#unsubscribe?.();
    this.#unsubscribe = this.#dispatcher.subscribeAccount((event) =>
      this.handleNotification(event),
    );
  }

  private handleNotification(event: AccountHostNotification): void {
    if (this.#logoutEpoch !== undefined) return;
    const generation = this.currentGeneration();
    if (generation === undefined || event.generation !== generation) return;
    if (event.method === "account/updated") {
      void this.readCurrentGeneration();
      return;
    }
    if (!this.#loginId || event.params.loginId !== this.#loginId) return;
    this.#loginId = undefined;
    if (!event.params.success) {
      this.#operationEpoch += 1;
      this.#generation = generation;
      this.#state = AUTHENTICATION_ERROR;
      return;
    }
    void this.readCurrentGeneration();
  }

  private ensureGeneration(): void {
    if (!this.#started || this.#logoutEpoch !== undefined) return;
    const generation = this.currentGeneration();
    if (generation === undefined || generation === this.#generation) return;
    if (generation === this.#readingGeneration) return;
    this.#state = { type: "checking" };
    this.subscribe();
    void this.readGeneration(generation);
  }

  private readCurrentGeneration(): Promise<void> {
    if (this.#logoutEpoch !== undefined) return Promise.resolve();
    const generation = this.currentGeneration();
    if (generation === undefined) {
      this.#state = AUTHENTICATION_ERROR;
      return Promise.resolve();
    }
    return this.readGeneration(generation);
  }

  private async readGeneration(generation: number): Promise<void> {
    if (this.#logoutEpoch !== undefined) return;
    const epoch = ++this.#operationEpoch;
    this.#readingGeneration = generation;
    this.#state = { type: "checking" };
    try {
      const response = await this.#host.accountRead(true);
      if (
        epoch !== this.#operationEpoch ||
        this.currentGeneration() !== generation
      ) {
        return;
      }
      this.#generation = generation;
      this.#state =
        response.account?.type === "chatgpt"
          ? {
              type: "ready",
              email: response.account.email,
              planType: response.account.planType,
            }
          : { type: "signed_out" };
    } catch (error) {
      if (
        epoch !== this.#operationEpoch ||
        this.currentGeneration() !== generation
      ) {
        return;
      }
      if (!(error instanceof CodexGenerationChangedError)) {
        this.#generation = generation;
      }
      this.#state = AUTHENTICATION_ERROR;
    } finally {
      if (epoch === this.#operationEpoch) this.#readingGeneration = undefined;
    }
  }

  private currentGeneration(): number | undefined {
    try {
      return this.#host.generation;
    } catch {
      return undefined;
    }
  }
}

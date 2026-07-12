import type { CodexHost } from "../codex/host.js";

const CACHE_TTL_MS = 60_000;

export interface OpenAIModelList {
  object: "list";
  data: Array<{
    id: string;
    object: "model";
    created: 0;
    owned_by: "openai";
  }>;
}

export interface ModelCapabilities {
  readonly id: string;
  readonly supportsImage: boolean;
  readonly supportedReasoningEfforts: readonly string[];
}

interface CatalogSnapshot {
  generation: number;
  expiresAt: number;
  models: Map<string, ModelCapabilities>;
}

interface PendingLoad {
  generation: number;
  promise: Promise<Map<string, ModelCapabilities>>;
}

type ModelHost = Pick<CodexHost, "generation" | "modelList">;

export class ModelCatalog {
  readonly #host: ModelHost;
  #snapshot: CatalogSnapshot | undefined;
  #pending: PendingLoad | undefined;

  constructor(host: ModelHost) {
    this.#host = host;
  }

  async list(signal?: AbortSignal): Promise<OpenAIModelList> {
    const models = await this.load(signal);
    return {
      object: "list",
      data: [...models.values()].map(({ id }) => ({
        id,
        object: "model",
        created: 0,
        owned_by: "openai",
      })),
    };
  }

  async lookup(
    modelId: string,
    signal?: AbortSignal,
  ): Promise<ModelCapabilities | undefined> {
    return (await this.load(signal)).get(modelId);
  }

  private async load(
    signal?: AbortSignal,
  ): Promise<Map<string, ModelCapabilities>> {
    while (true) {
      const generation = this.#host.generation;
      const snapshot = this.#snapshot;
      if (
        snapshot?.generation === generation &&
        snapshot.expiresAt > Date.now()
      ) {
        return snapshot.models;
      }

      let pending = this.#pending;
      if (pending?.generation !== generation) {
        pending = {
          generation,
          promise: this.fetchAll(signal),
        };
        this.#pending = pending;
      }

      let models: Map<string, ModelCapabilities>;
      try {
        models = await pending.promise;
      } finally {
        if (this.#pending === pending) this.#pending = undefined;
      }

      if (this.#host.generation !== generation) continue;
      this.#snapshot = {
        generation,
        expiresAt: Date.now() + CACHE_TTL_MS,
        models,
      };
      return models;
    }
  }

  private async fetchAll(
    signal?: AbortSignal,
  ): Promise<Map<string, ModelCapabilities>> {
    const models = new Map<string, ModelCapabilities>();
    const seenCursors = new Set<string>();
    let cursor: string | undefined;

    while (true) {
      const page = await this.#host.modelList(
        cursor === undefined
          ? { includeHidden: false }
          : { cursor, includeHidden: false },
        signal,
      );
      for (const model of page.data) {
        const inputModalities = model.inputModalities ?? ["text", "image"];
        if (model.hidden || !inputModalities.includes("text")) continue;
        models.set(model.id, {
          id: model.id,
          supportsImage: inputModalities.includes("image"),
          supportedReasoningEfforts: model.supportedReasoningEfforts.map(
            ({ reasoningEffort }) => reasoningEffort,
          ),
        });
      }

      if (page.nextCursor === null) return models;
      if (seenCursors.has(page.nextCursor)) {
        throw new Error("Codex model pagination cursor cycle");
      }
      seenCursors.add(page.nextCursor);
      cursor = page.nextCursor;
    }
  }
}

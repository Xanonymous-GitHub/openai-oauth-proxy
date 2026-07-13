import { mkdtempSync, rmSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type ServerType, serve } from "@hono/node-server";
import type OpenAI from "openai";
import { createDataApp } from "../../src/app.js";
import { fakeModel, fakeModelListResponse } from "../../src/codex/fake.js";
import type { CodexHost } from "../../src/codex/host.js";
import { ConversationStore } from "../../src/conversations/store.js";
import type { JsonValue } from "../../src/openai/types.js";
import type { ExternalToolCall } from "../../src/tools/bridge.js";
import type {
  ProxyStreamEvent,
  TurnCommand,
  TurnResult,
} from "../../src/turns/events.js";
import type {
  TurnLifecycleCallbacks,
  TurnRunner,
} from "../../src/turns/runner.js";

const token = "b".repeat(32);
const signatures = {
  png: Buffer.from("89504e470d0a1a0a", "hex"),
  jpeg: Buffer.from("ffd8ff", "hex"),
  webp: Buffer.from("524946460000000057454250", "hex"),
};

interface PendingTools {
  calls: ExternalToolCall[];
  fingerprint: string;
}

class FixtureTools {
  pending: PendingTools | undefined;

  constructor(private readonly completed: string[]) {}

  toDynamicTools(tools: Array<Record<string, unknown>>) {
    return tools.map((tool) => {
      const definition =
        typeof tool.function === "object" && tool.function !== null
          ? (tool.function as Record<string, unknown>)
          : tool;
      return {
        type: "function" as const,
        name: String(definition.name ?? "unknown"),
        description: String(definition.description ?? ""),
        inputSchema: (definition.parameters ?? {}) as Record<string, JsonValue>,
      };
    });
  }

  fingerprintDefinitions(tools: unknown): string {
    return JSON.stringify(tools);
  }

  async continue(request: {
    toolFingerprint: string;
    results: Array<{ callId: string; output: string }>;
  }) {
    const pending = this.pending;
    if (!pending || pending.fingerprint !== request.toolFingerprint) {
      return { type: "lost" as const };
    }
    const supplied = new Set(request.results.map((result) => result.callId));
    const missingCallIds = pending.calls
      .map((call) => call.id)
      .filter((id) => !supplied.has(id));
    if (missingCallIds.length > 0) {
      return { type: "incomplete" as const, missingCallIds };
    }
    for (const call of pending.calls) {
      const name =
        typeof call.arguments === "object" &&
        call.arguments !== null &&
        !Array.isArray(call.arguments) &&
        typeof call.arguments.name === "string"
          ? call.arguments.name
          : call.name;
      this.completed.push(name);
    }
    this.pending = undefined;
    return {
      type: "continued" as const,
      threadId: "thread-tools",
      turnId: "turn-tools",
      result: Promise.resolve({
        threadId: "thread-tools",
        turnId: "turn-tools",
        text: "tool loop complete",
        finishReason: "stop" as const,
        usage: { inputTokens: 2, outputTokens: 2, totalTokens: 4 },
      }),
    };
  }

  invalidateResponse(): Promise<void> {
    this.pending = undefined;
    return Promise.resolve();
  }

  invalidateCalls(): void {
    this.pending = undefined;
  }
}

function closeServer(server: ServerType): Promise<void> {
  return new Promise((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
}

export interface ListeningProxyFixture {
  readonly token: string;
  readonly baseURL: string;
  readonly commands: TurnCommand[];
  readonly images: { png: string; jpeg: string; webp: string };
  readonly completedToolCalls: string[];
  readonly internalToolEvents: number;
  readonly abortedTurns: number;
  readonly requestedPaths: string[];
  runToolLoop(client: OpenAI, names: string[]): Promise<void>;
  waitForBlockedTurn(): Promise<void>;
  waitForAbortedTurn(): Promise<void>;
  armAgentTool(name: string, arguments_: Record<string, JsonValue>): void;
  close(): Promise<void>;
}

export async function startListeningProxyFixture(): Promise<ListeningProxyFixture> {
  const directory = mkdtempSync(join(tmpdir(), "proxy-compat-"));
  const operationWorkingDirectory = join(directory, "operations");
  const store = ConversationStore.open(
    join(directory, "proxy.sqlite"),
    { now: () => Date.now() },
    {
      responseTtlMs: 60_000,
      turnLeaseMs: 30_000,
      toolLeaseMs: 30_000,
    },
  );
  const commands: TurnCommand[] = [];
  const completedToolCalls: string[] = [];
  const requestedPaths: string[] = [];
  const tools = new FixtureTools(completedToolCalls);
  let sequence = 0;
  let nextToolCalls: Array<{
    name: string;
    arguments: Record<string, JsonValue>;
  }> = [];
  let abortedTurns = 0;
  let blockedStarted = Promise.withResolvers<void>();

  const execute = async (
    command: TurnCommand,
    signal?: AbortSignal,
    lifecycle?: TurnLifecycleCallbacks,
  ): Promise<TurnResult> => {
    commands.push(command);
    sequence += 1;
    const threadId =
      command.action.type === "start"
        ? `thread-${sequence}`
        : command.action.type === "resume"
          ? command.action.threadId
          : `thread-fork-${sequence}`;
    const turnId = `turn-${sequence}`;
    await lifecycle?.opened?.(threadId);
    await lifecycle?.started?.(threadId, turnId);
    if (
      command.input.some(
        (item) =>
          item.type === "text" && item.text.includes("block until cancelled"),
      )
    ) {
      blockedStarted.resolve();
      await new Promise<never>((_resolve, reject) => {
        signal?.addEventListener(
          "abort",
          () => {
            abortedTurns += 1;
            reject(new DOMException("The operation was aborted", "AbortError"));
          },
          { once: true },
        );
      });
    }
    if (
      nextToolCalls.length > 0 &&
      nextToolCalls.every((call) =>
        command.dynamicTools?.some(
          (tool) => tool.type === "function" && tool.name === call.name,
        ),
      )
    ) {
      const calls = nextToolCalls.map((call, index) => ({
        id: `call_fixture_${sequence}_${index}`,
        name: call.name,
        arguments: call.arguments,
      }));
      nextToolCalls = [];
      tools.pending = {
        calls,
        fingerprint: lifecycle?.tool?.toolFingerprint ?? "",
      };
      await lifecycle?.tool?.suspended?.(threadId, turnId);
      await lifecycle?.release?.();
      return {
        threadId,
        turnId,
        text: "",
        finishReason: "tool_calls",
        toolCalls: calls,
      };
    }
    await lifecycle?.release?.();
    return {
      threadId,
      turnId,
      text: command.outputSchema ? '{"answer":"fixture"}' : "fixture answer",
      finishReason: "stop",
      usage: { inputTokens: 7, outputTokens: 5, totalTokens: 12 },
    };
  };
  const runner = {
    tools,
    run: execute,
    async *stream(
      command: TurnCommand,
      signal?: AbortSignal,
      lifecycle?: TurnLifecycleCallbacks,
    ): AsyncIterable<ProxyStreamEvent> {
      const result = await execute(command, signal, lifecycle);
      if (result.text !== "") yield { type: "text.delta", delta: result.text };
      for (const call of result.toolCalls ?? [])
        yield { type: "tool.call", call };
      if (result.usage) yield { type: "usage", usage: result.usage };
      yield { type: "completed", result };
    },
  } as unknown as TurnRunner;
  const host = {
    generation: 1,
    modelList: async () =>
      fakeModelListResponse({
        data: [
          fakeModel({
            id: "gpt-5.4",
            model: "gpt-5.4",
            inputModalities: ["text", "image"],
            supportedReasoningEfforts: [
              { reasoningEffort: "low", description: "Low" },
              { reasoningEffort: "medium", description: "Medium" },
              { reasoningEffort: "high", description: "High" },
            ],
          }),
        ],
      }),
  } as unknown as CodexHost;
  const app = createDataApp({
    health: () => true,
    ready: () => true,
    accountReady: () => true,
    draining: () => false,
    bifrostToken: token,
    metricsToken: "m".repeat(32),
    host,
    chat: { runner, deleteThread: async () => undefined },
    responses: {
      runner,
      store,
      clock: { now: () => Date.now() },
      processGeneration: () => 1,
      operationWorkingDirectory,
      deleteThread: async () => undefined,
    },
  });
  const server = serve({
    fetch(request) {
      requestedPaths.push(new URL(request.url).pathname);
      return app.fetch(request);
    },
    hostname: "127.0.0.1",
    port: 0,
  });
  await new Promise<void>((resolve, reject) => {
    if (server.listening) resolve();
    else {
      server.once("listening", resolve);
      server.once("error", reject);
    }
  });
  const port = (server.address() as AddressInfo).port;

  return {
    token,
    baseURL: `http://127.0.0.1:${port}/v1`,
    commands,
    requestedPaths,
    images: {
      png: `data:image/png;base64,${signatures.png.toString("base64")}`,
      jpeg: `data:image/jpeg;base64,${signatures.jpeg.toString("base64")}`,
      webp: `data:image/webp;base64,${signatures.webp.toString("base64")}`,
    },
    completedToolCalls,
    internalToolEvents: 0,
    get abortedTurns() {
      return abortedTurns;
    },
    async runToolLoop(client, names) {
      nextToolCalls = names.map((name) => ({
        name: "fixture_tool",
        arguments: { name },
      }));
      const toolsDefinition = [
        {
          type: "function" as const,
          name: "fixture_tool",
          description: "Return the supplied fixture name",
          parameters: {
            type: "object",
            properties: { name: { type: "string" } },
            required: ["name"],
            additionalProperties: false,
          },
          strict: true,
        },
      ];
      const first = await client.responses.create({
        model: "gpt-5.4",
        input: "call tools",
        tools: toolsDefinition,
        parallel_tool_calls: true,
        store: true,
      });
      const calls = first.output.filter(
        (item) => item.type === "function_call",
      );
      const final = await client.responses.create({
        model: "gpt-5.4",
        previous_response_id: first.id,
        tools: toolsDefinition,
        input: calls.map((call) => ({
          type: "function_call_output" as const,
          call_id: call.call_id,
          output: `result:${call.arguments}`,
        })),
        store: true,
      });
      if (final.output_text !== "tool loop complete") {
        throw new Error("Tool loop did not complete");
      }
    },
    armAgentTool(name, arguments_) {
      nextToolCalls = [{ name, arguments: arguments_ }];
    },
    async waitForBlockedTurn() {
      await blockedStarted.promise;
      blockedStarted = Promise.withResolvers<void>();
    },
    async waitForAbortedTurn() {
      const deadline = Date.now() + 1_000;
      while (abortedTurns === 0 && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
    },
    async close() {
      await closeServer(server);
      store.close();
      rmSync(directory, { recursive: true, force: true });
    },
  };
}

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

  constructor(
    private readonly completed: string[],
    private readonly completedRoundWidths: number[],
    private readonly nextRound: (fingerprint: string) => TurnResult | undefined,
  ) {}

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
    this.completedRoundWidths.push(pending.calls.length);
    this.pending = undefined;
    const next = this.nextRound(request.toolFingerprint);
    return {
      type: "continued" as const,
      threadId: "thread-tools",
      turnId: "turn-tools",
      result: Promise.resolve(
        next ?? {
          threadId: "thread-tools",
          turnId: "turn-tools",
          text: "tool loop complete",
          finishReason: "stop" as const,
          usage: { inputTokens: 2, outputTokens: 2, totalTokens: 4 },
        },
      ),
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
  readonly listenHost: "0.0.0.0";
  readonly baseURL: string;
  readonly dockerBaseURL: string;
  readonly commands: TurnCommand[];
  readonly images: { png: string; jpeg: string; webp: string };
  readonly completedToolCalls: string[];
  readonly completedToolRoundWidths: number[];
  readonly internalToolEvents: number;
  readonly abortedTurns: number;
  readonly requestedPaths: string[];
  readonly requestErrors: Array<{
    status: number;
    code?: string;
    param?: string;
  }>;
  runChatToolRounds(client: OpenAI, rounds: string[][]): Promise<void>;
  runResponsesToolRounds(client: OpenAI, rounds: string[][]): Promise<void>;
  waitForBlockedTurn(): Promise<void>;
  waitForAbortedTurn(): Promise<void>;
  armAgentToolRounds(
    name: string,
    arguments_: Record<string, JsonValue>,
    widths: number[],
  ): void;
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
  const completedToolRoundWidths: number[] = [];
  const requestedPaths: string[] = [];
  const requestErrors: Array<{
    status: number;
    code?: string;
    param?: string;
  }> = [];
  let sequence = 0;
  let toolSequence = 0;
  let nextToolRounds: Array<
    Array<{
      name: string;
      arguments: Record<string, JsonValue>;
    }>
  > = [];
  const nextToolResult = (fingerprint: string): TurnResult | undefined => {
    const round = nextToolRounds.shift();
    if (!round) return undefined;
    toolSequence += 1;
    const calls = round.map((call, index) => ({
      id: `call_fixture_${toolSequence}_${index}`,
      name: call.name,
      arguments: call.arguments,
    }));
    tools.pending = { calls, fingerprint };
    return {
      threadId: "thread-tools",
      turnId: `turn-tools-${toolSequence}`,
      text: "",
      finishReason: "tool_calls",
      toolCalls: calls,
    };
  };
  const tools = new FixtureTools(
    completedToolCalls,
    completedToolRoundWidths,
    nextToolResult,
  );
  const armRounds = (name: string, rounds: string[][]) => {
    nextToolRounds = rounds.map((round) =>
      round.map((label) => ({ name, arguments: { name: label } })),
    );
  };
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
      nextToolRounds.length > 0 &&
      (nextToolRounds[0] ?? []).every((call) =>
        command.dynamicTools?.some(
          (tool) => tool.type === "function" && tool.name === call.name,
        ),
      )
    ) {
      const result = nextToolResult(lifecycle?.tool?.toolFingerprint ?? "");
      if (!result) throw new Error("Fixture tool round missing");
      await lifecycle?.tool?.suspended?.(threadId, turnId);
      await lifecycle?.release?.();
      return { ...result, threadId, turnId };
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
    async fetch(request) {
      requestedPaths.push(new URL(request.url).pathname);
      const response = await app.fetch(request);
      if (!response.ok) {
        const body = (await response
          .clone()
          .json()
          .catch(() => ({}))) as {
          error?: { code?: string; param?: string };
        };
        requestErrors.push({
          status: response.status,
          ...(body.error?.code === undefined ? {} : { code: body.error.code }),
          ...(body.error?.param === undefined
            ? {}
            : { param: body.error.param }),
        });
      }
      return response;
    },
    hostname: "0.0.0.0",
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
    listenHost: "0.0.0.0",
    baseURL: `http://127.0.0.1:${port}/v1`,
    dockerBaseURL: `http://host.docker.internal:${port}/v1`,
    commands,
    requestedPaths,
    requestErrors,
    images: {
      png: `data:image/png;base64,${signatures.png.toString("base64")}`,
      jpeg: `data:image/jpeg;base64,${signatures.jpeg.toString("base64")}`,
      webp: `data:image/webp;base64,${signatures.webp.toString("base64")}`,
    },
    completedToolCalls,
    completedToolRoundWidths,
    internalToolEvents: 0,
    get abortedTurns() {
      return abortedTurns;
    },
    async runChatToolRounds(client, rounds) {
      armRounds("fixture_tool", rounds);
      const toolsDefinition = [
        {
          type: "function" as const,
          function: {
            name: "fixture_tool",
            description: "Return the supplied fixture name",
            parameters: {
              type: "object" as const,
              properties: { name: { type: "string" } },
              required: ["name"],
              additionalProperties: false,
            },
          },
        },
      ];
      const messages: OpenAI.Chat.Completions.ChatCompletionMessageParam[] = [
        { role: "user", content: "call tools across rounds" },
      ];
      for (;;) {
        const response = await client.chat.completions.create({
          model: "gpt-5.4",
          messages,
          tools: toolsDefinition,
          parallel_tool_calls: true,
        });
        const message = response.choices[0]?.message;
        if (!message) throw new Error("Chat fixture returned no message");
        messages.push(message);
        if (!message.tool_calls || message.tool_calls.length === 0) {
          if (message.content !== "tool loop complete") {
            throw new Error("Chat tool loop did not complete");
          }
          return;
        }
        for (const call of message.tool_calls) {
          if (call.type !== "function") {
            throw new Error("Chat fixture returned a non-function tool");
          }
          messages.push({
            role: "tool",
            tool_call_id: call.id,
            content: `result:${call.function.arguments}`,
          });
        }
      }
    },
    async runResponsesToolRounds(client, rounds) {
      armRounds("fixture_tool", rounds);
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
      let response = await client.responses.create({
        model: "gpt-5.4",
        input: "call tools",
        tools: toolsDefinition,
        parallel_tool_calls: true,
        store: true,
      });
      for (;;) {
        const calls = response.output.filter(
          (item) => item.type === "function_call",
        );
        if (calls.length === 0) {
          if (response.output_text !== "tool loop complete") {
            throw new Error("Responses tool loop did not complete");
          }
          return;
        }
        response = await client.responses.create({
          model: "gpt-5.4",
          previous_response_id: response.id,
          tools: toolsDefinition,
          input: calls.map((call) => ({
            type: "function_call_output" as const,
            call_id: call.call_id,
            output: `result:${call.arguments}`,
          })),
          store: true,
        });
      }
    },
    armAgentToolRounds(name, arguments_, widths) {
      nextToolRounds = widths.map((width, round) =>
        Array.from({ length: width }, (_, index) => ({
          name,
          arguments: {
            ...arguments_,
            name: `${round}:${index}`,
          },
        })),
      );
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

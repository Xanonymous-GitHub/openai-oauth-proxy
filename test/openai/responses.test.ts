import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDataApp } from "../../src/app.js";
import { fakeModel, fakeModelListResponse } from "../../src/codex/fake.js";
import type { CodexHost } from "../../src/codex/host.js";
import {
  type ConversationClock,
  ConversationStore,
} from "../../src/conversations/store.js";
import {
  startResponseSweeper,
  sweepExpiredResponses,
} from "../../src/openai/responses.js";
import type {
  ProxyStreamEvent,
  TurnCommand,
  TurnResult,
} from "../../src/turns/events.js";
import type {
  TurnLifecycleCallbacks,
  TurnRunner,
} from "../../src/turns/runner.js";

const DAY_MS = 24 * 60 * 60 * 1_000;
const bifrostToken = "b".repeat(32);
const authorization = { authorization: `Bearer ${bifrostToken}` };

let now = 1_700_000_000_000;
const clock: ConversationClock = { now: () => now };
const directories = new Set<string>();
const stores = new Set<ConversationStore>();

interface RunnerInvocation {
  command: TurnCommand;
  threadId: string;
  turnId: string;
}

function openStore(): ConversationStore {
  const directory = mkdtempSync(join(tmpdir(), "responses-route-"));
  directories.add(directory);
  const store = ConversationStore.open(join(directory, "proxy.sqlite"), clock, {
    responseTtlMs: 7 * DAY_MS,
    turnLeaseMs: 10 * 60 * 1_000,
    toolLeaseMs: 15 * 60 * 1_000,
  });
  stores.add(store);
  return store;
}

afterEach(() => {
  for (const store of stores) store.close();
  for (const directory of directories) {
    rmSync(directory, { recursive: true, force: true });
  }
  stores.clear();
  directories.clear();
  now = 1_700_000_000_000;
});

function createFixture(
  options: {
    failAt?: number;
    supportsImage?: boolean;
    streamWriteFailureAt?: number;
    iteratorFails?: boolean;
  } = {},
) {
  const store = openStore();
  const invocations: RunnerInvocation[] = [];
  const deleteThread = vi.fn(async () => undefined);
  let call = 0;

  const execute = async (
    command: TurnCommand,
    lifecycle?: TurnLifecycleCallbacks,
  ): Promise<TurnResult> => {
    call += 1;
    const threadId =
      command.action.type === "start"
        ? `thread-${call}`
        : command.action.type === "resume"
          ? command.action.threadId
          : `thread-fork-${call}`;
    const turnId = `turn-${call}`;
    await lifecycle?.opened?.(threadId);
    await lifecycle?.started?.(threadId, turnId);
    invocations.push({ command, threadId, turnId });
    try {
      if (options.failAt === call) throw new Error("interrupted fixture turn");
      return {
        threadId,
        turnId,
        text: `answer-${call}`,
        finishReason: "stop",
        usage: { inputTokens: 7, outputTokens: 5, totalTokens: 12 },
      };
    } finally {
      await Promise.all([
        lifecycle?.release?.(),
        lifecycle?.cleanup?.(threadId),
      ]);
    }
  };
  const runner = {
    run: vi.fn(
      async (
        command: TurnCommand,
        _signal?: AbortSignal,
        lifecycle?: TurnLifecycleCallbacks,
      ) => execute(command, lifecycle),
    ),
    stream: vi.fn(async function* (
      command: TurnCommand,
      _signal?: AbortSignal,
      lifecycle?: TurnLifecycleCallbacks,
    ): AsyncIterable<ProxyStreamEvent> {
      let result: TurnResult;
      try {
        result = await execute(command, lifecycle);
      } catch {
        yield {
          type: "failed",
          error: new Error("fixture failure") as never,
        };
        return;
      }
      yield { type: "text.delta", delta: result.text };
      if (options.iteratorFails) throw new Error("iterator transport failed");
      if (result.usage) yield { type: "usage", usage: result.usage };
      yield { type: "completed", result };
    }),
  } as unknown as TurnRunner;
  const host = {
    generation: 1,
    modelList: vi.fn(async () =>
      fakeModelListResponse({
        data: [
          fakeModel({
            id: "gpt-5.4",
            model: "gpt-5.4",
            inputModalities: options.supportsImage
              ? ["text", "image"]
              : ["text"],
            supportedReasoningEfforts: [
              { reasoningEffort: "low", description: "Low" },
              { reasoningEffort: "high", description: "High" },
            ],
          }),
        ],
      }),
    ),
  } as unknown as CodexHost;
  const app = createDataApp({
    health: () => true,
    ready: () => true,
    draining: () => false,
    bifrostToken,
    metricsToken: "m".repeat(32),
    host,
    responses: {
      runner,
      store,
      clock,
      processGeneration: () => host.generation,
      deleteThread,
      ...(options.streamWriteFailureAt === undefined
        ? {}
        : {
            streamSSE: ((
              _context: unknown,
              callback: (stream: unknown) => Promise<void>,
            ) => {
              let writes = 0;
              let payload = "";
              const body = new ReadableStream({
                start(controller) {
                  const stream = {
                    onAbort() {},
                    async writeSSE(event: { event?: string; data: string }) {
                      writes += 1;
                      if (writes === options.streamWriteFailureAt) {
                        throw new Error(`stream write ${writes} failed`);
                      }
                      payload += `${event.event ? `event: ${event.event}\n` : ""}data: ${event.data}\n\n`;
                    },
                  };
                  void callback(stream).then(
                    () => {
                      controller.enqueue(new TextEncoder().encode(payload));
                      controller.close();
                    },
                    (error) => controller.error(error),
                  );
                },
              });
              return new Response(body, {
                headers: { "content-type": "text/event-stream" },
              });
            }) as never,
          }),
    },
  });

  return { app, deleteThread, host, invocations, runner, store };
}

async function postResponse(
  app: ReturnType<typeof createFixture>["app"],
  body: unknown,
): Promise<Response> {
  return app.request("/v1/responses", {
    method: "POST",
    headers: { ...authorization, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

async function postJson(
  app: ReturnType<typeof createFixture>["app"],
  body: unknown,
): Promise<Record<string, unknown>> {
  const response = await postResponse(app, body);
  expect(response.status).toBe(200);
  return (await response.json()) as Record<string, unknown>;
}

describe("POST /v1/responses", () => {
  it("starts, resumes the latest response, and forks inclusively from an older response", async () => {
    const { app, invocations } = createFixture();

    const first = await postJson(app, { model: "gpt-5.4", input: "first" });
    const latest = await postJson(app, {
      model: "gpt-5.4",
      input: "latest",
      previous_response_id: first.id,
    });
    await postJson(app, {
      model: "gpt-5.4",
      input: "branch",
      previous_response_id: first.id,
    });

    expect(first.id).toMatch(/^resp_[A-Za-z0-9_-]{32}$/);
    expect(latest.id).toMatch(/^resp_[A-Za-z0-9_-]{32}$/);
    expect(invocations.map(({ command }) => command.action)).toEqual([
      { type: "start" },
      { type: "resume", threadId: "thread-1" },
      { type: "fork", threadId: "thread-1", lastTurnId: "turn-1" },
    ]);
  });

  it("returns stable not-found and busy errors without calling upstream", async () => {
    const { app, invocations, store } = createFixture();
    const missing = await postResponse(app, {
      model: "gpt-5.4",
      input: "missing",
      previous_response_id: "resp_missing",
    });
    const first = await postJson(app, { model: "gpt-5.4", input: "first" });
    expect(store.acquireLease("thread-1", "competing", "turn", 1)).toBe(true);
    const busy = await postResponse(app, {
      model: "gpt-5.4",
      input: "busy",
      previous_response_id: first.id,
    });

    expect(missing.status).toBe(404);
    expect(await missing.json()).toMatchObject({
      error: { code: "response_not_found", param: "previous_response_id" },
    });
    expect(busy.status).toBe(409);
    expect(await busy.json()).toMatchObject({ error: { code: "thread_busy" } });
    expect(invocations).toHaveLength(1);
  });

  it("returns response_not_found after a stored response expires", async () => {
    const { app, invocations } = createFixture();
    const first = await postJson(app, { model: "gpt-5.4", input: "first" });
    now += 7 * DAY_MS;

    const response = await postResponse(app, {
      model: "gpt-5.4",
      input: "too late",
      previous_response_id: first.id,
    });

    expect(response.status).toBe(404);
    expect(await response.json()).toMatchObject({
      error: { code: "response_not_found" },
    });
    expect(invocations).toHaveLength(1);
  });

  it("stores only completed turns and slides successful continuation expiry", async () => {
    const { app, store } = createFixture({ failAt: 2 });
    const first = await postJson(app, { model: "gpt-5.4", input: "first" });
    const original = store.lookup(first.id as string);
    now += DAY_MS;

    const interrupted = await postResponse(app, {
      model: "gpt-5.4",
      input: "interrupted",
      previous_response_id: first.id,
    });

    expect(interrupted.status).toBe(500);
    expect(store.lookup(first.id as string)).toMatchObject({
      state: "complete",
      expiresAt: now + 7 * DAY_MS,
    });
    expect(store.lookup(first.id as string)?.expiresAt).toBeGreaterThan(
      original?.expiresAt ?? 0,
    );
    const retry = await postResponse(app, {
      model: "gpt-5.4",
      input: "retry",
      previous_response_id: first.id,
    });
    expect(retry.status).toBe(200);
  });

  it("projects ordinary output, instructions, structured output, and usage", async () => {
    const { app, invocations } = createFixture();
    const response = await postResponse(app, {
      model: "gpt-5.4",
      input: [
        { role: "system", content: "history" },
        { role: "user", content: "question" },
      ],
      instructions: "newest developer instruction",
      reasoning: { effort: "high" },
      text: {
        format: {
          type: "json_schema",
          name: "answer",
          schema: {
            type: "object",
            properties: { answer: { type: "string" } },
          },
        },
      },
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      id: expect.stringMatching(/^resp_/),
      object: "response",
      status: "completed",
      model: "gpt-5.4",
      output: [
        {
          type: "message",
          status: "completed",
          role: "assistant",
          content: [{ type: "output_text", text: "answer-1", annotations: [] }],
        },
      ],
      usage: { input_tokens: 7, output_tokens: 5, total_tokens: 12 },
    });
    expect(invocations[0]?.command).toMatchObject({
      instructions: "newest developer instruction",
      effort: "high",
      outputSchema: {
        type: "object",
        properties: { answer: { type: "string" } },
      },
    });
  });

  it("returns an opaque store=false ID without creating a resumable mapping", async () => {
    const { app, deleteThread, store } = createFixture();
    const body = await postJson(app, {
      model: "gpt-5.4",
      input: "disposable",
      store: false,
    });
    const continuation = await postResponse(app, {
      model: "gpt-5.4",
      input: "cannot resume",
      previous_response_id: body.id,
    });

    expect(body.id).toMatch(/^resp_[A-Za-z0-9_-]{32}$/);
    expect(store.lookup(body.id as string)).toBeUndefined();
    expect(continuation.status).toBe(404);
    expect(deleteThread).toHaveBeenCalledOnce();
    expect(deleteThread).toHaveBeenCalledWith("thread-1");
  });

  it("deletes a store=false thread when the turn fails", async () => {
    const { app, deleteThread } = createFixture({ failAt: 1 });
    const response = await postResponse(app, {
      model: "gpt-5.4",
      input: "fails",
      store: false,
    });

    expect(response.status).toBe(500);
    expect(deleteThread).toHaveBeenCalledOnce();
  });

  it("forks store=false continuations without deleting the stored source or its live branches", async () => {
    const { app, deleteThread, invocations } = createFixture();
    const first = await postJson(app, { model: "gpt-5.4", input: "first" });
    const latest = await postJson(app, {
      model: "gpt-5.4",
      input: "latest",
      previous_response_id: first.id,
    });
    const branch = await postJson(app, {
      model: "gpt-5.4",
      input: "branch",
      previous_response_id: first.id,
    });

    await postJson(app, {
      model: "gpt-5.4",
      input: "disposable continuation",
      previous_response_id: latest.id,
      store: false,
    });
    await postJson(app, {
      model: "gpt-5.4",
      input: "source survives",
      previous_response_id: latest.id,
    });
    await postJson(app, {
      model: "gpt-5.4",
      input: "branch survives",
      previous_response_id: branch.id,
    });

    expect(invocations.map(({ command }) => command.action)).toEqual([
      { type: "start" },
      { type: "resume", threadId: "thread-1" },
      { type: "fork", threadId: "thread-1", lastTurnId: "turn-1" },
      { type: "fork", threadId: "thread-1", lastTurnId: "turn-2" },
      { type: "resume", threadId: "thread-1" },
      { type: "resume", threadId: "thread-fork-3" },
    ]);
    expect(deleteThread).toHaveBeenCalledOnce();
    expect(deleteThread).toHaveBeenCalledWith("thread-fork-4");
  });

  it("durably reserves start, resume, and fork identities before invoking the runner", async () => {
    const start = createFixture();
    const startReserve = vi.spyOn(start.store, "reserveOperation");
    vi.mocked(start.runner.run).mockImplementationOnce(async () => {
      const responseId = startReserve.mock.calls[0]?.[0].responseId;
      expect(
        start.store.lookupOperation(responseId ?? "missing"),
      ).toMatchObject({
        action: "start",
        state: "active",
      });
      throw new Error("start crash window");
    });
    expect(
      (await postResponse(start.app, { model: "gpt-5.4", input: "start" }))
        .status,
    ).toBe(500);
    expect(startReserve).toHaveBeenCalledOnce();
    expect(startReserve.mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(start.runner.run).mock.invocationCallOrder[0] ?? Infinity,
    );
    const startId = startReserve.mock.calls[0]?.[0].responseId;
    expect(start.store.lookupOperation(startId ?? "missing")).toBeUndefined();

    const resume = createFixture();
    const resumeSource = await postJson(resume.app, {
      model: "gpt-5.4",
      input: "source",
    });
    const resumeReserve = vi.spyOn(resume.store, "reserveOperation");
    vi.mocked(resume.runner.run).mockImplementationOnce(async () => {
      const responseId = resumeReserve.mock.calls[0]?.[0].responseId;
      expect(
        resume.store.lookupOperation(responseId ?? "missing"),
      ).toMatchObject({
        action: "resume",
        sourceThreadId: "thread-1",
        state: "active",
      });
      throw new Error("resume crash window");
    });
    expect(
      (
        await postResponse(resume.app, {
          model: "gpt-5.4",
          input: "resume",
          previous_response_id: resumeSource.id,
        })
      ).status,
    ).toBe(500);
    expect(resumeReserve).toHaveBeenCalledOnce();
    expect(resumeReserve.mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(resume.runner.run).mock.invocationCallOrder.at(-1) ?? Infinity,
    );
    const resumeId = resumeReserve.mock.calls[0]?.[0].responseId;
    expect(resume.store.lookupOperation(resumeId ?? "missing")).toBeUndefined();

    const fork = createFixture();
    const forkSource = await postJson(fork.app, {
      model: "gpt-5.4",
      input: "source",
    });
    await postJson(fork.app, {
      model: "gpt-5.4",
      input: "descendant",
      previous_response_id: forkSource.id,
    });
    const forkReserve = vi.spyOn(fork.store, "reserveOperation");
    vi.mocked(fork.runner.run).mockImplementationOnce(async () => {
      const responseId = forkReserve.mock.calls[0]?.[0].responseId;
      expect(fork.store.lookupOperation(responseId ?? "missing")).toMatchObject(
        {
          action: "fork",
          sourceThreadId: "thread-1",
          sourceTurnId: "turn-1",
          state: "active",
        },
      );
      throw new Error("fork crash window");
    });
    expect(
      (
        await postResponse(fork.app, {
          model: "gpt-5.4",
          input: "fork",
          previous_response_id: forkSource.id,
        })
      ).status,
    ).toBe(500);
    expect(forkReserve).toHaveBeenCalledOnce();
    expect(forkReserve.mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(fork.runner.run).mock.invocationCallOrder.at(-1) ?? Infinity,
    );
    const forkId = forkReserve.mock.calls[0]?.[0].responseId;
    expect(fork.store.lookupOperation(forkId ?? "missing")).toBeUndefined();
  });

  it("deletes a returned new thread once when durable thread attachment fails", async () => {
    const fixture = createFixture();
    const reserve = vi.spyOn(fixture.store, "reserveOperation");
    vi.spyOn(fixture.store, "attachOperation").mockImplementationOnce(() => {
      throw new Error("SQLite attachment failed");
    });

    const response = await postResponse(fixture.app, {
      model: "gpt-5.4",
      input: "start",
    });

    expect(response.status).toBe(500);
    const responseId = reserve.mock.calls[0]?.[0].responseId;
    expect(
      fixture.store.lookupOperation(responseId ?? "missing"),
    ).toBeUndefined();
    expect(fixture.deleteThread).toHaveBeenCalledOnce();
    expect(fixture.deleteThread).toHaveBeenCalledWith("thread-1");
  });

  it("retains a returned thread for sweep retry when attachment and deletion fail", async () => {
    const fixture = createFixture();
    const reserve = vi.spyOn(fixture.store, "reserveOperation");
    vi.spyOn(fixture.store, "attachOperation").mockImplementationOnce(() => {
      throw new Error("SQLite attachment failed");
    });
    fixture.deleteThread.mockRejectedValueOnce(new Error("delete failed"));

    const response = await postResponse(fixture.app, {
      model: "gpt-5.4",
      input: "start",
    });

    expect(response.status).toBe(500);
    const responseId = reserve.mock.calls[0]?.[0].responseId;
    expect(
      fixture.store.lookupOperation(responseId ?? "missing"),
    ).toMatchObject({
      state: "abandoned",
      threadId: "thread-1",
    });
    expect(fixture.deleteThread).toHaveBeenCalledOnce();

    await sweepExpiredResponses({
      store: fixture.store,
      deleteThread: fixture.deleteThread,
    });
    expect(fixture.deleteThread).toHaveBeenCalledTimes(2);
    expect(
      fixture.store.lookupOperation(responseId ?? "missing"),
    ).toBeUndefined();
  });

  it.each([
    [
      "stored tools",
      {
        model: "gpt-5.4",
        input: "tool",
        tools: [{ type: "function", name: "lookup", parameters: {} }],
      },
      "unsupported_tool_semantics",
    ],
    [
      "disposable tools",
      {
        model: "gpt-5.4",
        input: "tool",
        store: false,
        tools: [{ type: "function", name: "lookup", parameters: {} }],
      },
      "store_required_for_tools",
    ],
    [
      "function call input",
      {
        model: "gpt-5.4",
        input: [
          {
            type: "function_call",
            call_id: "call-1",
            name: "lookup",
            arguments: "{}",
          },
        ],
      },
      "unsupported_tool_semantics",
    ],
  ])("rejects %s before model lookup or thread start", async (_name, request, code) => {
    const { app, host, invocations } = createFixture();
    const response = await postResponse(app, request);

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: { code } });
    expect(host.modelList).not.toHaveBeenCalled();
    expect(invocations).toEqual([]);
  });

  it("validates reasoning before acquiring a continuation lease", async () => {
    const { app, invocations } = createFixture();
    const first = await postJson(app, { model: "gpt-5.4", input: "first" });
    const invalid = await postResponse(app, {
      model: "gpt-5.4",
      input: "invalid",
      previous_response_id: first.id,
      reasoning: { effort: "medium" },
    });
    const valid = await postResponse(app, {
      model: "gpt-5.4",
      input: "valid",
      previous_response_id: first.id,
      reasoning: { effort: "low" },
    });

    expect(invalid.status).toBe(400);
    expect(await invalid.json()).toMatchObject({
      error: { code: "unsupported_reasoning_effort" },
    });
    expect(valid.status).toBe(200);
    expect(invocations).toHaveLength(2);
  });

  it("validates model and image support before acquiring a continuation lease", async () => {
    const png = Buffer.from("89504e470d0a1a0a", "hex").toString("base64");
    const { app, invocations } = createFixture();
    const first = await postJson(app, { model: "gpt-5.4", input: "first" });
    const unknownModel = await postResponse(app, {
      model: "missing",
      input: "invalid",
      previous_response_id: first.id,
    });
    const invalidImage = await postResponse(app, {
      model: "gpt-5.4",
      input: [
        {
          role: "user",
          content: [
            { type: "input_image", image_url: `data:image/png;base64,${png}` },
          ],
        },
      ],
      previous_response_id: first.id,
    });
    const valid = await postResponse(app, {
      model: "gpt-5.4",
      input: "valid",
      previous_response_id: first.id,
    });

    expect(unknownModel.status).toBe(404);
    expect(invalidImage.status).toBe(400);
    expect(await invalidImage.json()).toMatchObject({
      error: { code: "unsupported_image_model" },
    });
    expect(valid.status).toBe(200);
    expect(invocations).toHaveLength(2);
  });

  it("translates inline image input for an image-capable model", async () => {
    const png = Buffer.from("89504e470d0a1a0a", "hex").toString("base64");
    const { app, invocations } = createFixture({ supportsImage: true });
    const response = await postResponse(app, {
      model: "gpt-5.4",
      input: [
        {
          role: "user",
          content: [
            { type: "input_text", text: "describe" },
            {
              type: "input_image",
              image_url: `data:image/png;base64,${png}`,
              detail: "high",
            },
          ],
        },
      ],
    });

    expect(response.status).toBe(200);
    expect(invocations[0]?.command.input).toEqual([
      { type: "text", text: "describe", text_elements: [] },
      {
        type: "image",
        url: `data:image/png;base64,${png}`,
        detail: "high",
      },
    ]);
  });

  it("streams only supported named events with one reserved response ID", async () => {
    const { app, store } = createFixture();
    const response = await postResponse(app, {
      model: "gpt-5.4",
      input: "stream",
      stream: true,
    });
    const frames = (await response.text()).trim().split("\n\n");
    const events = frames.map((frame) => {
      const lines = frame.split("\n");
      return {
        event: lines[0]?.replace("event: ", ""),
        data: JSON.parse(lines[1]?.replace("data: ", "") ?? "null"),
      };
    });
    const responseId = events[0]?.data.response.id as string;

    expect(events.map(({ event }) => event)).toEqual([
      "response.created",
      "response.output_text.delta",
      "response.output_text.done",
      "response.completed",
    ]);
    expect(events.map(({ data }) => data.sequence_number)).toEqual([
      0, 1, 2, 3,
    ]);
    expect(events[1]?.data).toMatchObject({
      item_id: expect.stringMatching(/^msg_/),
      logprobs: [],
    });
    expect(events[1]?.data).not.toHaveProperty("response_id");
    expect(events[2]?.data).toMatchObject({
      item_id: events[1]?.data.item_id,
      logprobs: [],
    });
    expect(events[2]?.data).not.toHaveProperty("response_id");
    expect(events[3]?.data.response.id).toBe(responseId);
    expect(events[3]?.data.response.output[0].id).toBe(events[1]?.data.item_id);
    expect(store.lookup(responseId)).toMatchObject({
      state: "complete",
      turnId: "turn-1",
    });
  });

  it("emits an error and no success completion after streaming lifecycle failure", async () => {
    const fixture = createFixture();
    fixture.deleteThread.mockRejectedValueOnce(
      new Error("sensitive delete failure"),
    );
    const response = await postResponse(fixture.app, {
      model: "gpt-5.4",
      input: "stream",
      stream: true,
      store: false,
    });
    const payload = await response.text();
    const errorFrame = payload
      .trim()
      .split("\n\n")
      .find((frame) => frame.startsWith("event: error"));
    const error = JSON.parse(
      errorFrame?.split("\n")[1]?.replace("data: ", "") ?? "null",
    );

    expect(payload).toContain("event: response.created");
    expect(payload).toContain("event: error");
    expect(payload).not.toContain("event: response.completed");
    expect(payload).not.toContain("sensitive delete failure");
    expect(error).toMatchObject({
      type: "error",
      code: "internal_error",
      message: "Internal server error",
      param: null,
      sequence_number: 2,
    });
    expect(error).not.toHaveProperty("error");
  });

  it("abandons and releases a continuation lease when the initial SSE write fails", async () => {
    const fixture = createFixture({ streamWriteFailureAt: 1 });
    const first = await postJson(fixture.app, {
      model: "gpt-5.4",
      input: "first",
    });
    const reserve = vi.spyOn(fixture.store, "reserveOperation");
    const response = await postResponse(fixture.app, {
      model: "gpt-5.4",
      input: "stream",
      previous_response_id: first.id,
      stream: true,
    });

    await expect(response.text()).rejects.toThrow("stream write 1 failed");
    const responseId = reserve.mock.calls[0]?.[0].responseId;
    expect(
      fixture.store.lookupOperation(responseId ?? "missing"),
    ).toBeUndefined();
    expect(fixture.deleteThread).not.toHaveBeenCalled();

    const retry = await postResponse(fixture.app, {
      model: "gpt-5.4",
      input: "retry",
      previous_response_id: first.id,
    });
    expect(retry.status).toBe(200);
  });

  it("abandons and deletes a newly opened thread once when a midstream write fails", async () => {
    const fixture = createFixture({ streamWriteFailureAt: 2 });
    const reserve = vi.spyOn(fixture.store, "reserveOperation");
    const response = await postResponse(fixture.app, {
      model: "gpt-5.4",
      input: "stream",
      stream: true,
    });

    await expect(response.text()).rejects.toThrow("stream write 2 failed");
    const responseId = reserve.mock.calls[0]?.[0].responseId;
    expect(
      fixture.store.lookupOperation(responseId ?? "missing"),
    ).toBeUndefined();
    expect(fixture.deleteThread).toHaveBeenCalledOnce();
    expect(fixture.deleteThread).toHaveBeenCalledWith("thread-1");
  });

  it("abandons and deletes a newly opened thread once when stream iteration throws", async () => {
    const fixture = createFixture({
      iteratorFails: true,
      streamWriteFailureAt: Number.MAX_SAFE_INTEGER,
    });
    const reserve = vi.spyOn(fixture.store, "reserveOperation");
    const response = await postResponse(fixture.app, {
      model: "gpt-5.4",
      input: "stream",
      stream: true,
    });

    await expect(response.text()).rejects.toThrow("iterator transport failed");
    const responseId = reserve.mock.calls[0]?.[0].responseId;
    expect(
      fixture.store.lookupOperation(responseId ?? "missing"),
    ).toBeUndefined();
    expect(fixture.deleteThread).toHaveBeenCalledOnce();
    expect(fixture.deleteThread).toHaveBeenCalledWith("thread-1");
  });
});

describe("Responses expiry cleanup", () => {
  function complete(
    store: ConversationStore,
    threadId: string,
    turnId: string,
    parent?: { responseId: string; threadId: string; turnId: string },
  ): string {
    const responseId = store.createPending({
      threadId,
      ...(parent === undefined
        ? {}
        : {
            parentResponseId: parent.responseId,
            parentThreadId: parent.threadId,
            forkedAtTurnId: parent.turnId,
          }),
      stored: true,
      processGeneration: 1,
    });
    store.complete(responseId, turnId);
    return responseId;
  }

  it("marks expiry first and retries a failed leaf before deleting its ancestor", async () => {
    const store = openStore();
    const rootId = complete(store, "thread-root", "turn-root");
    complete(store, "thread-child", "turn-child", {
      responseId: rootId,
      threadId: "thread-root",
      turnId: "turn-root",
    });
    now += 7 * DAY_MS;
    const deleteThread = vi
      .fn<(threadId: string) => Promise<void>>()
      .mockRejectedValueOnce(new Error("App Server unavailable"))
      .mockResolvedValue(undefined);

    await sweepExpiredResponses({ store, deleteThread });

    expect(store.lookup(rootId)).toBeUndefined();
    expect(deleteThread).toHaveBeenCalledTimes(1);
    expect(deleteThread).toHaveBeenLastCalledWith("thread-child");
    expect(store.deletableLeafThreads()).toEqual([
      "thread-child",
      "thread-root",
    ]);

    await sweepExpiredResponses({ store, deleteThread });

    expect(deleteThread.mock.calls.map(([threadId]) => threadId)).toEqual([
      "thread-child",
      "thread-child",
      "thread-root",
    ]);
    expect(store.deletableLeafThreads()).toEqual([]);
  });

  it("deletes and finalizes an abandoned attached operation during startup cleanup", async () => {
    const store = openStore();
    store.reserveOperation({
      responseId: "resp_crashed_start",
      ownerRequestId: "req-crashed-start",
      stored: true,
      processGeneration: 1,
    });
    store.attachOperation("resp_crashed_start", "thread-crashed-start");
    store.markContinuationLost(2);
    const deleteThread = vi.fn(async () => undefined);

    await sweepExpiredResponses({ store, deleteThread });

    expect(deleteThread).toHaveBeenCalledWith("thread-crashed-start");
    expect(store.lookupOperation("resp_crashed_start")).toBeUndefined();
  });

  it("runs startup and hourly cleanup and stops its injected timer cleanly", async () => {
    const store = openStore();
    complete(store, "thread-timed", "turn-timed");
    let tick: (() => void) | undefined;
    const timer = { id: 1 };
    const setInterval = vi.fn((callback: () => void, milliseconds: number) => {
      tick = callback;
      expect(milliseconds).toBe(60 * 60 * 1_000);
      return timer;
    });
    const clearInterval = vi.fn();
    let finishDelete!: () => void;
    const deleteThread = vi.fn(
      async () =>
        new Promise<void>((resolve) => {
          finishDelete = resolve;
        }),
    );
    const sweeper = startResponseSweeper({
      store,
      deleteThread,
      timers: { setInterval, clearInterval },
    });
    await sweeper.startup;
    now += 7 * DAY_MS;

    tick?.();
    await vi.waitFor(() => expect(deleteThread).toHaveBeenCalledOnce());
    const stopping = sweeper.stop();
    expect(clearInterval).toHaveBeenCalledWith(timer);
    finishDelete();
    await stopping;

    expect(store.deletableLeafThreads()).toEqual([]);
  });

  it("retries on the next timer tick after a sweep rejects", async () => {
    const store = openStore();
    complete(store, "thread-retry", "turn-retry");
    now += 7 * DAY_MS;
    const removeThread = vi
      .spyOn(store, "removeThread")
      .mockImplementationOnce(() => {
        throw new Error("transaction failed");
      });
    let tick: (() => void) | undefined;
    const sweeper = startResponseSweeper({
      store,
      deleteThread: vi.fn(async () => undefined),
      timers: {
        setInterval: (callback) => {
          tick = callback;
          return 1;
        },
        clearInterval: vi.fn(),
      },
    });
    await expect(sweeper.startup).rejects.toThrow("transaction failed");

    tick?.();
    await vi.waitFor(() => expect(removeThread).toHaveBeenCalledTimes(2));
    await sweeper.stop();

    expect(store.deletableLeafThreads()).toEqual([]);
  });
});

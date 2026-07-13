import OpenAI from "openai";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  type ListeningProxyFixture,
  startListeningProxyFixture,
} from "../integration/proxy-fixture.js";

describe("official OpenAI JavaScript client compatibility", () => {
  let fixture: ListeningProxyFixture;
  let client: OpenAI;

  beforeAll(async () => {
    fixture = await startListeningProxyFixture();
    expect(fixture.listenHost).toBe("0.0.0.0");
    expect(fixture.baseURL).toMatch(/^http:\/\/127\.0\.0\.1:/);
    expect(fixture.dockerBaseURL).toMatch(/^http:\/\/host\.docker\.internal:/);
    client = new OpenAI({ apiKey: fixture.token, baseURL: fixture.baseURL });
  });

  afterAll(async () => fixture.close());

  it("parses models, Chat Completions, role history, images, and JSON Schema", async () => {
    expect((await client.models.list()).data.map((model) => model.id)).toEqual([
      "gpt-5.4",
    ]);

    const chat = await client.chat.completions.create({
      model: "gpt-5.4",
      messages: [
        { role: "system", content: "system contract" },
        { role: "developer", content: "developer contract" },
        { role: "assistant", content: "prior answer" },
        {
          role: "user",
          content: [
            { type: "text", text: "inspect images" },
            {
              type: "image_url",
              image_url: { url: fixture.images.png },
            },
            {
              type: "image_url",
              image_url: { url: fixture.images.jpeg },
            },
            {
              type: "image_url",
              image_url: { url: fixture.images.webp },
            },
          ],
        },
      ],
      response_format: {
        type: "json_schema",
        json_schema: {
          name: "answer",
          strict: true,
          schema: {
            type: "object",
            properties: { answer: { type: "string" } },
            required: ["answer"],
            additionalProperties: false,
          },
        },
      },
    });

    expect(chat.choices[0]?.message.content).toBe('{"answer":"fixture"}');
    expect(fixture.commands.at(-1)).toMatchObject({
      action: { type: "start" },
      outputSchema: { type: "object" },
      history: expect.arrayContaining([
        expect.objectContaining({ role: "system" }),
        expect.objectContaining({ role: "developer" }),
        expect.objectContaining({ role: "assistant" }),
      ]),
      input: [
        expect.objectContaining({ type: "text" }),
        expect.objectContaining({ type: "image" }),
        expect.objectContaining({ type: "image" }),
        expect.objectContaining({ type: "image" }),
      ],
    });
  });

  it("parses Responses images and JSON Schema", async () => {
    const response = await client.responses.create({
      model: "gpt-5.4",
      input: [
        {
          role: "user",
          content: [
            { type: "input_text", text: "inspect response images" },
            {
              type: "input_image",
              detail: "auto",
              image_url: fixture.images.png,
            },
            {
              type: "input_image",
              detail: "auto",
              image_url: fixture.images.jpeg,
            },
            {
              type: "input_image",
              detail: "auto",
              image_url: fixture.images.webp,
            },
          ],
        },
      ],
      text: {
        format: {
          type: "json_schema",
          name: "answer",
          strict: true,
          schema: {
            type: "object",
            properties: { answer: { type: "string" } },
            required: ["answer"],
            additionalProperties: false,
          },
        },
      },
    });

    expect(response.output_text).toBe('{"answer":"fixture"}');
    expect(fixture.commands.at(-1)).toMatchObject({
      outputSchema: { type: "object" },
      input: [
        expect.objectContaining({ type: "text" }),
        expect.objectContaining({ type: "image" }),
        expect.objectContaining({ type: "image" }),
        expect.objectContaining({ type: "image" }),
      ],
    });
  });

  it("parses Chat and Responses SSE without response adapters", async () => {
    const chat = await client.chat.completions.create({
      model: "gpt-5.4",
      messages: [{ role: "user", content: "stream chat" }],
      stream: true,
    });
    let chatText = "";
    for await (const chunk of chat) {
      chatText += chunk.choices[0]?.delta.content ?? "";
    }

    const response = await client.responses.create({
      model: "gpt-5.4",
      input: "stream response",
      stream: true,
    });
    let responseText = "";
    for await (const event of response) {
      if (event.type === "response.output_text.delta") {
        responseText += event.delta;
      }
    }

    expect(chatText).toBe("fixture answer");
    expect(responseText).toBe("fixture answer");
  });

  it("emits the official separate Chat streaming usage chunk", async () => {
    const stream = await client.chat.completions.create({
      model: "gpt-5.4",
      messages: [{ role: "user", content: "stream usage" }],
      stream: true,
      stream_options: { include_usage: true },
    });
    const chunks = [];
    for await (const chunk of stream) chunks.push(chunk);

    expect(chunks.filter((chunk) => chunk.choices.length === 0)).toEqual([
      expect.objectContaining({
        choices: [],
        usage: { prompt_tokens: 7, completion_tokens: 5, total_tokens: 12 },
      }),
    ]);
    expect(
      chunks
        .filter((chunk) => chunk.choices.length > 0)
        .every((chunk) => chunk.usage === null),
    ).toBe(true);
  });

  it("stores, resumes, and branches Responses", async () => {
    const first = await client.responses.create({
      model: "gpt-5.4",
      input: "first",
      store: true,
    });
    const resumed = await client.responses.create({
      model: "gpt-5.4",
      input: "resume",
      previous_response_id: first.id,
      store: true,
    });
    const branched = await client.responses.create({
      model: "gpt-5.4",
      input: "branch",
      previous_response_id: first.id,
      store: true,
    });

    expect(first.output_text).toBe("fixture answer");
    expect(resumed.output_text).toBe("fixture answer");
    expect(branched.output_text).toBe("fixture answer");
    expect(
      fixture.commands.slice(-2).map((command) => command.action.type),
    ).toEqual(["resume", "fork"]);
  });

  it("supports Chat tool history through single, parallel, and repeated rounds", async () => {
    await fixture.runChatToolRounds(client, [
      ["single"],
      ["parallel-a", "parallel-b"],
      ["repeat"],
      ["repeat"],
    ]);

    expect(fixture.completedToolCalls).toEqual([
      "single",
      "parallel-a",
      "parallel-b",
      "repeat",
      "repeat",
    ]);
    expect(fixture.completedToolRoundWidths).toEqual([1, 2, 1, 1]);
    expect(fixture.internalToolEvents).toBe(0);
  });

  it("supports Responses tool history through single, parallel, and repeated rounds", async () => {
    fixture.completedToolCalls.length = 0;
    fixture.completedToolRoundWidths.length = 0;
    await fixture.runResponsesToolRounds(client, [
      ["single"],
      ["parallel-a", "parallel-b"],
      ["repeat"],
      ["repeat"],
    ]);

    expect(fixture.completedToolCalls).toEqual([
      "single",
      "parallel-a",
      "parallel-b",
      "repeat",
      "repeat",
    ]);
    expect(fixture.completedToolRoundWidths).toEqual([1, 2, 1, 1]);
    expect(fixture.internalToolEvents).toBe(0);
  });

  it("rejects every unsupported Chat field through the official client", async () => {
    for (const [field, value] of [
      ["max_completion_tokens", 128],
      ["verbosity", "low"],
      ["unknown_fixture_field", true],
    ] as const) {
      await expect(
        client.chat.completions.create({
          model: "gpt-5.4",
          messages: [{ role: "user", content: "reject unsupported field" }],
          [field]: value,
        }),
      ).rejects.toMatchObject({
        status: 400,
        code: "unsupported_field",
        param: field,
      });
    }
  });

  it("propagates cancellation and stable OpenAI errors", async () => {
    const controller = new AbortController();
    const pending = client.responses.create(
      { model: "gpt-5.4", input: "block until cancelled" },
      { signal: controller.signal },
    );
    await fixture.waitForBlockedTurn();
    controller.abort();
    await expect(pending).rejects.toBeInstanceOf(OpenAI.APIUserAbortError);
    await fixture.waitForAbortedTurn();
    expect(fixture.abortedTurns).toBe(1);

    await expect(
      client.responses.create({ model: "missing", input: "fail" }),
    ).rejects.toMatchObject({ status: 404, code: "model_not_found" });
    await expect(
      client.embeddings.create({ model: "gpt-5.4", input: "x" }),
    ).rejects.toMatchObject({
      status: 404,
      code: "unsupported_endpoint",
    });
  });
});

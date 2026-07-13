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

  it("supports single, parallel, and repeated client function loops", async () => {
    await fixture.runToolLoop(client, ["first"]);
    await fixture.runToolLoop(client, ["parallel-a", "parallel-b"]);
    await fixture.runToolLoop(client, ["repeat", "repeat"]);

    expect(fixture.completedToolCalls).toEqual([
      "first",
      "parallel-a",
      "parallel-b",
      "repeat",
      "repeat",
    ]);
    expect(fixture.internalToolEvents).toBe(0);
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

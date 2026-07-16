import OpenAI from "openai";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  type ListeningProxyFixture,
  startListeningProxyFixture,
} from "../integration/proxy-fixture.js";

const chatTool = {
  type: "function" as const,
  function: {
    name: "fixture_tool",
    description: "Return fixture data",
    parameters: {
      type: "object" as const,
      properties: { name: { type: "string" } },
      additionalProperties: false,
    },
  },
};

const responseTool = {
  type: "function" as const,
  name: "fixture_tool",
  description: "Return fixture data",
  parameters: {
    type: "object" as const,
    properties: { name: { type: "string" } },
    additionalProperties: false,
  },
  strict: true,
};

interface RejectionCase {
  concept: string;
  endpoint: "chat" | "responses";
  body(fixture: ListeningProxyFixture): unknown;
  code: string;
  param: string;
}

const rejectionCases: RejectionCase[] = [
  {
    concept: "Chat sampling",
    endpoint: "chat",
    body: () => ({
      model: "gpt-5.4",
      messages: [{ role: "user", content: "reject" }],
      temperature: 0.2,
    }),
    code: "unsupported_field",
    param: "temperature",
  },
  {
    concept: "Chat log probabilities",
    endpoint: "chat",
    body: () => ({
      model: "gpt-5.4",
      messages: [{ role: "user", content: "reject" }],
      logprobs: true,
    }),
    code: "unsupported_field",
    param: "logprobs",
  },
  {
    concept: "Chat audio",
    endpoint: "chat",
    body: () => ({
      model: "gpt-5.4",
      messages: [{ role: "user", content: "reject" }],
      modalities: ["text", "audio"],
    }),
    code: "unsupported_field",
    param: "modalities",
  },
  {
    concept: "Chat remote image",
    endpoint: "chat",
    body: () => ({
      model: "gpt-5.4",
      messages: [
        {
          role: "user",
          content: [
            {
              type: "image_url",
              image_url: { url: "https://example.test/private.png" },
            },
          ],
        },
      ],
    }),
    code: "invalid_request",
    param: "messages.0.content.0.image_url.url",
  },
  {
    concept: "Chat file image",
    endpoint: "chat",
    body: () => ({
      model: "gpt-5.4",
      messages: [
        {
          role: "user",
          content: [{ type: "image_url", image_url: { url: "file_fixture" } }],
        },
      ],
    }),
    code: "invalid_request",
    param: "messages.0.content.0.image_url.url",
  },
  {
    concept: "Chat hosted tool",
    endpoint: "chat",
    body: () => ({
      model: "gpt-5.4",
      messages: [{ role: "user", content: "reject" }],
      tools: [{ type: "web_search_preview" }],
    }),
    code: "invalid_request",
    param: "tools.0.type",
  },
  {
    concept: "Chat forced tool choice",
    endpoint: "chat",
    body: () => ({
      model: "gpt-5.4",
      messages: [{ role: "user", content: "reject" }],
      tool_choice: { type: "function", function: { name: "fixture_tool" } },
    }),
    code: "invalid_request",
    param: "tool_choice",
  },
  {
    concept: "Chat disabled parallel tools",
    endpoint: "chat",
    body: () => ({
      model: "gpt-5.4",
      messages: [{ role: "user", content: "reject" }],
      parallel_tool_calls: false,
    }),
    code: "invalid_request",
    param: "parallel_tool_calls",
  },
  {
    concept: "Chat exact token limit",
    endpoint: "chat",
    body: () => ({
      model: "gpt-5.4",
      messages: [{ role: "user", content: "reject" }],
      max_completion_tokens: 128,
    }),
    code: "unsupported_field",
    param: "max_completion_tokens",
  },
  {
    concept: "Chat verbosity",
    endpoint: "chat",
    body: () => ({
      model: "gpt-5.4",
      messages: [{ role: "user", content: "reject" }],
      verbosity: "low",
    }),
    code: "unsupported_field",
    param: "verbosity",
  },
  {
    concept: "Chat non-streaming stream options",
    endpoint: "chat",
    body: () => ({
      model: "gpt-5.4",
      messages: [{ role: "user", content: "reject" }],
      stream_options: { include_usage: true },
    }),
    code: "invalid_request",
    param: "stream_options",
  },
  {
    concept: "Chat unknown stream option",
    endpoint: "chat",
    body: () => ({
      model: "gpt-5.4",
      messages: [{ role: "user", content: "reject" }],
      stream: true,
      stream_options: { include_usage: true, unknown_fixture_member: true },
    }),
    code: "unsupported_field",
    param: "stream_options.unknown_fixture_member",
  },
  {
    concept: "Chat unknown field",
    endpoint: "chat",
    body: () => ({
      model: "gpt-5.4",
      messages: [{ role: "user", content: "reject" }],
      unknown_fixture_field: true,
    }),
    code: "unsupported_field",
    param: "unknown_fixture_field",
  },
  {
    concept: "Responses sampling",
    endpoint: "responses",
    body: () => ({ model: "gpt-5.4", input: "reject", temperature: 0.2 }),
    code: "unsupported_field",
    param: "temperature",
  },
  {
    concept: "Responses log probabilities",
    endpoint: "responses",
    body: () => ({ model: "gpt-5.4", input: "reject", top_logprobs: 2 }),
    code: "unsupported_field",
    param: "top_logprobs",
  },
  {
    concept: "Responses remote image",
    endpoint: "responses",
    body: () => ({
      model: "gpt-5.4",
      input: [
        {
          role: "user",
          content: [
            {
              type: "input_image",
              image_url: "https://example.test/private.png",
            },
          ],
        },
      ],
    }),
    code: "invalid_request",
    param: "input.0.content.0.image_url",
  },
  {
    concept: "Responses file image",
    endpoint: "responses",
    body: () => ({
      model: "gpt-5.4",
      input: [
        {
          role: "user",
          content: [{ type: "input_image", file_id: "file_fixture" }],
        },
      ],
    }),
    code: "invalid_request",
    param: "input.0.content.0.file_id",
  },
  {
    concept: "Responses remote file input",
    endpoint: "responses",
    body: () => ({
      model: "gpt-5.4",
      input: [
        {
          role: "user",
          content: [
            {
              type: "input_file",
              file_url: "https://example.test/private.txt",
            },
          ],
        },
      ],
    }),
    code: "invalid_request",
    param: "input.0.content.0.type",
  },
  {
    concept: "Responses built-in tool",
    endpoint: "responses",
    body: () => ({
      model: "gpt-5.4",
      input: "reject",
      tools: [{ type: "file_search", vector_store_ids: ["vs_fixture"] }],
    }),
    code: "invalid_request",
    param: "tools.0.type",
  },
  {
    concept: "Responses forced tool choice",
    endpoint: "responses",
    body: () => ({
      model: "gpt-5.4",
      input: "reject",
      tool_choice: { type: "function", name: "fixture_tool" },
    }),
    code: "invalid_request",
    param: "tool_choice",
  },
  {
    concept: "Responses disabled parallel tools",
    endpoint: "responses",
    body: () => ({
      model: "gpt-5.4",
      input: "reject",
      parallel_tool_calls: false,
    }),
    code: "invalid_request",
    param: "parallel_tool_calls",
  },
  {
    concept: "Responses exact token limit",
    endpoint: "responses",
    body: () => ({ model: "gpt-5.4", input: "reject", max_output_tokens: 128 }),
    code: "unsupported_field",
    param: "max_output_tokens",
  },
  {
    concept: "Responses background mode",
    endpoint: "responses",
    body: () => ({ model: "gpt-5.4", input: "reject", background: true }),
    code: "unsupported_field",
    param: "background",
  },
  {
    concept: "Responses conversation resource",
    endpoint: "responses",
    body: () => ({
      model: "gpt-5.4",
      input: "reject",
      conversation: "conv_fixture",
    }),
    code: "unsupported_field",
    param: "conversation",
  },
  {
    concept: "Responses audio",
    endpoint: "responses",
    body: () => ({ model: "gpt-5.4", input: "reject", modalities: ["audio"] }),
    code: "unsupported_field",
    param: "modalities",
  },
  {
    concept: "Responses include controls",
    endpoint: "responses",
    body: () => ({
      model: "gpt-5.4",
      input: "reject",
      include: ["message.output_text.logprobs"],
    }),
    code: "unsupported_field",
    param: "include",
  },
  {
    concept: "Responses metadata",
    endpoint: "responses",
    body: () => ({
      model: "gpt-5.4",
      input: "reject",
      metadata: { fixture: "private" },
    }),
    code: "unsupported_field",
    param: "metadata",
  },
  {
    concept: "Responses unknown field",
    endpoint: "responses",
    body: () => ({
      model: "gpt-5.4",
      input: "reject",
      unknown_fixture_field: true,
    }),
    code: "unsupported_field",
    param: "unknown_fixture_field",
  },
];

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

  it.each([
    {
      concept: "roles and text",
      run: async () => {
        const result = await client.chat.completions.create({
          model: "gpt-5.4",
          messages: [
            { role: "system", content: "system" },
            { role: "developer", content: "developer" },
            { role: "user", content: "question" },
            { role: "assistant", content: "answer" },
            { role: "user", content: "continue" },
          ],
        });
        expect(result.choices[0]?.message.content).toBe("fixture answer");
      },
    },
    {
      concept: "inline images",
      run: async () => {
        await client.chat.completions.create({
          model: "gpt-5.4",
          messages: [
            {
              role: "user",
              content: [
                { type: "text", text: "image" },
                { type: "image_url", image_url: { url: fixture.images.png } },
              ],
            },
          ],
        });
        expect(fixture.commands.at(-1)?.input).toEqual(
          expect.arrayContaining([expect.objectContaining({ type: "image" })]),
        );
      },
    },
    {
      concept: "streaming",
      run: async () => {
        const stream = await client.chat.completions.create({
          model: "gpt-5.4",
          messages: [{ role: "user", content: "stream" }],
          stream: true,
        });
        let text = "";
        for await (const chunk of stream)
          text += chunk.choices[0]?.delta.content ?? "";
        expect(text).toBe("fixture answer");
      },
    },
    {
      concept: "stream usage",
      run: async () => {
        const stream = await client.chat.completions.create({
          model: "gpt-5.4",
          messages: [{ role: "user", content: "usage" }],
          stream: true,
          stream_options: { include_usage: true },
        });
        const chunks = [];
        for await (const chunk of stream) chunks.push(chunk);
        expect(
          chunks.some((chunk) => chunk.choices.length === 0 && chunk.usage),
        ).toBe(true);
      },
    },
    ...(["auto", "none"] as const).map((tool_choice) => ({
      concept: `tool choice ${tool_choice}`,
      run: async () => {
        await client.chat.completions.create({
          model: "gpt-5.4",
          messages: [{ role: "user", content: "tools" }],
          tools: [chatTool],
          tool_choice,
        });
        expect(fixture.commands.at(-1)?.dynamicTools?.length ?? 0).toBe(
          tool_choice === "auto" ? 1 : 0,
        );
      },
    })),
    {
      concept: "parallel function tools",
      run: async () => {
        await client.chat.completions.create({
          model: "gpt-5.4",
          messages: [{ role: "user", content: "parallel" }],
          tools: [chatTool],
          parallel_tool_calls: true,
        });
        expect(fixture.commands.at(-1)?.dynamicTools).toHaveLength(1);
      },
    },
    {
      concept: "reasoning effort",
      run: async () => {
        await client.chat.completions.create({
          model: "gpt-5.4",
          messages: [{ role: "user", content: "reason" }],
          reasoning_effort: "low",
        });
        expect(fixture.commands.at(-1)?.effort).toBe("low");
      },
    },
    {
      concept: "JSON Schema",
      run: async () => {
        const result = await client.chat.completions.create({
          model: "gpt-5.4",
          messages: [{ role: "user", content: "schema" }],
          response_format: {
            type: "json_schema",
            json_schema: {
              name: "answer",
              schema: { type: "object", properties: {} },
            },
          },
        });
        expect(result.choices[0]?.message.content).toBe('{"answer":"fixture"}');
      },
    },
  ])("accepts documented Chat concept: $concept", async ({ run }) => run());

  it.each([
    {
      concept: "text input",
      run: async () => {
        const result = await client.responses.create({
          model: "gpt-5.4",
          input: "text",
        });
        expect(result.output_text).toBe("fixture answer");
      },
    },
    {
      concept: "structured roles",
      run: async () => {
        await client.responses.create({
          model: "gpt-5.4",
          input: [
            { role: "system", content: "system" },
            { role: "developer", content: "developer" },
            { role: "assistant", content: "answer" },
            { role: "user", content: "continue" },
          ],
        });
        expect(fixture.commands.at(-1)?.history).toEqual(
          expect.arrayContaining([
            expect.objectContaining({ role: "assistant" }),
          ]),
        );
      },
    },
    {
      concept: "inline images",
      run: async () => {
        await client.responses.create({
          model: "gpt-5.4",
          input: [
            {
              role: "user",
              content: [
                { type: "input_text", text: "image" },
                {
                  type: "input_image",
                  detail: "auto",
                  image_url: fixture.images.png,
                },
              ],
            },
          ],
        });
        expect(fixture.commands.at(-1)?.input).toEqual(
          expect.arrayContaining([expect.objectContaining({ type: "image" })]),
        );
      },
    },
    {
      concept: "instructions",
      run: async () => {
        await client.responses.create({
          model: "gpt-5.4",
          input: "instructions",
          instructions: "Answer exactly",
        });
        expect(fixture.commands.at(-1)?.instructions).toBe("Answer exactly");
      },
    },
    {
      concept: "streaming",
      run: async () => {
        const stream = await client.responses.create({
          model: "gpt-5.4",
          input: "stream",
          stream: true,
        });
        let text = "";
        for await (const event of stream) {
          if (event.type === "response.output_text.delta") text += event.delta;
        }
        expect(text).toBe("fixture answer");
      },
    },
    {
      concept: "previous response",
      run: async () => {
        const first = await client.responses.create({
          model: "gpt-5.4",
          input: "first",
          store: true,
        });
        await client.responses.create({
          model: "gpt-5.4",
          input: "resume",
          previous_response_id: first.id,
          store: true,
        });
        expect(fixture.commands.at(-1)?.action.type).toBe("resume");
      },
    },
    {
      concept: "stored response",
      run: async () => {
        const result = await client.responses.create({
          model: "gpt-5.4",
          input: "store",
          store: true,
        });
        expect(result.id).toMatch(/^resp_/);
      },
    },
    ...(["auto", "none"] as const).map((tool_choice) => ({
      concept: `tool choice ${tool_choice}`,
      run: async () => {
        await client.responses.create({
          model: "gpt-5.4",
          input: "tools",
          store: true,
          tools: [responseTool],
          tool_choice,
        });
        expect(fixture.commands.at(-1)?.dynamicTools?.length ?? 0).toBe(
          tool_choice === "auto" ? 1 : 0,
        );
      },
    })),
    {
      concept: "parallel function tools",
      run: async () => {
        await client.responses.create({
          model: "gpt-5.4",
          input: "parallel",
          store: true,
          tools: [responseTool],
          parallel_tool_calls: true,
        });
        expect(fixture.commands.at(-1)?.dynamicTools).toHaveLength(1);
      },
    },
    {
      concept: "reasoning effort",
      run: async () => {
        await client.responses.create({
          model: "gpt-5.4",
          input: "reason",
          reasoning: { effort: "low" },
        });
        expect(fixture.commands.at(-1)?.effort).toBe("low");
      },
    },
    {
      concept: "JSON Schema",
      run: async () => {
        const result = await client.responses.create({
          model: "gpt-5.4",
          input: "schema",
          text: {
            format: {
              type: "json_schema",
              name: "answer",
              schema: { type: "object", properties: {} },
            },
          },
        });
        expect(result.output_text).toBe('{"answer":"fixture"}');
      },
    },
  ])("accepts documented Responses concept: $concept", async ({ run }) =>
    run(),
  );

  it.each(rejectionCases)(
    "rejects documented concept: $concept",
    async ({ endpoint, body, code, param }) => {
      const commandCount = fixture.commands.length;
      const request =
        endpoint === "chat"
          ? client.chat.completions.create(
              body(
                fixture,
              ) as OpenAI.Chat.Completions.ChatCompletionCreateParamsNonStreaming,
            )
          : client.responses.create(
              body(
                fixture,
              ) as OpenAI.Responses.ResponseCreateParamsNonStreaming,
            );
      await expect(request).rejects.toMatchObject({ status: 400, code, param });
      expect(fixture.commands).toHaveLength(commandCount);
    },
  );

  it("supports non-resumable Responses with store false", async () => {
    const transient = await client.responses.create({
      model: "gpt-5.4",
      input: "transient response",
      store: false,
    });
    expect(transient.output_text).toBe("fixture answer");

    const commandCount = fixture.commands.length;
    await expect(
      client.responses.create({
        model: "gpt-5.4",
        input: "must not resume",
        previous_response_id: transient.id,
        store: true,
      }),
    ).rejects.toMatchObject({
      status: 404,
      code: "response_not_found",
      param: "previous_response_id",
    });
    expect(fixture.commands).toHaveLength(commandCount);
  });

  it("rejects store false with function tools before thread work", async () => {
    const commandCount = fixture.commands.length;
    await expect(
      client.responses.create({
        model: "gpt-5.4",
        input: "invalid transient tools",
        store: false,
        tools: [responseTool],
      }),
    ).rejects.toMatchObject({
      status: 400,
      code: "store_required_for_tools",
      param: "store",
    });
    expect(fixture.commands).toHaveLength(commandCount);
  });

  it("honors Chat stream_options include_usage false", async () => {
    const stream = await client.chat.completions.create({
      model: "gpt-5.4",
      messages: [{ role: "user", content: "no streaming usage" }],
      stream: true,
      stream_options: { include_usage: false },
    });
    const chunks = [];
    for await (const chunk of stream) chunks.push(chunk);

    expect(chunks.some((chunk) => chunk.choices.length === 0)).toBe(false);
    expect(chunks.every((chunk) => chunk.usage === undefined)).toBe(true);
  });

  it.each([
    {
      family: "embeddings",
      request: () =>
        client.embeddings.create({ model: "gpt-5.4", input: "fixture" }),
    },
    {
      family: "images",
      request: () =>
        client.images.generate({ model: "gpt-image-1", prompt: "fixture" }),
    },
    {
      family: "audio",
      request: () =>
        client.audio.speech.create({
          model: "tts-1",
          voice: "alloy",
          input: "fixture",
        }),
    },
    { family: "files", request: () => client.files.list() },
    { family: "batches", request: () => client.batches.list() },
    {
      family: "fine-tuning",
      request: () => client.fineTuning.jobs.list(),
    },
    { family: "vector stores", request: () => client.vectorStores.list() },
  ])(
    "rejects unsupported SDK endpoint family: $family",
    async ({ request }) => {
      const commandCount = fixture.commands.length;
      await expect(request()).rejects.toMatchObject({
        status: 404,
        code: "unsupported_endpoint",
        param: null,
      });
      expect(fixture.commands).toHaveLength(commandCount);
    },
  );

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

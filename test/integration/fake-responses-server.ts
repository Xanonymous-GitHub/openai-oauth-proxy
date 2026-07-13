import {
  createServer as createHttpServer,
  type IncomingMessage,
} from "node:http";
import { type AddressInfo, createServer, type Server } from "node:net";

export interface FakeResponsesServer {
  readonly baseURL: string;
  readonly requests: Array<Record<string, unknown>>;
  waitForRequests(count: number): Promise<void>;
  close(): Promise<void>;
}

function readBody(request: IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.once("end", () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      } catch (error) {
        reject(error);
      }
    });
    request.once("error", reject);
  });
}

function responseEvents(id: string, text: string): string {
  const message = {
    id: `msg_${id}`,
    type: "message",
    status: "completed",
    role: "assistant",
    content: [
      {
        type: "output_text",
        text,
        annotations: [],
        logprobs: [],
      },
    ],
  };
  const response = {
    id,
    object: "response",
    created_at: 1,
    status: "completed",
    model: "gpt-5.4",
    output: [message],
    usage: {
      input_tokens: 3,
      input_tokens_details: { cached_tokens: 0 },
      output_tokens: 2,
      output_tokens_details: { reasoning_tokens: 0 },
      total_tokens: 5,
    },
  };
  const events = [
    {
      type: "response.created",
      response: { ...response, status: "in_progress", output: [] },
    },
    {
      type: "response.output_item.added",
      output_index: 0,
      item: { ...message, status: "in_progress", content: [] },
    },
    {
      type: "response.content_part.added",
      item_id: message.id,
      output_index: 0,
      content_index: 0,
      part: { type: "output_text", text: "", annotations: [], logprobs: [] },
    },
    {
      type: "response.output_text.delta",
      item_id: message.id,
      output_index: 0,
      content_index: 0,
      delta: text,
      logprobs: [],
    },
    {
      type: "response.output_text.done",
      item_id: message.id,
      output_index: 0,
      content_index: 0,
      text,
      logprobs: [],
    },
    {
      type: "response.content_part.done",
      item_id: message.id,
      output_index: 0,
      content_index: 0,
      part: message.content[0],
    },
    { type: "response.output_item.done", output_index: 0, item: message },
    { type: "response.completed", response },
  ];
  return `${events.map((event, index) => `event: ${event.type}\ndata: ${JSON.stringify({ ...event, sequence_number: index })}\n\n`).join("")}data: [DONE]\n\n`;
}

function partialResponseEvents(id: string, text: string): string {
  const itemId = `msg_${id}`;
  const events = [
    {
      type: "response.created",
      response: {
        id,
        object: "response",
        created_at: 1,
        status: "in_progress",
        model: "gpt-5.4",
        output: [],
      },
    },
    {
      type: "response.output_item.added",
      output_index: 0,
      item: {
        id: itemId,
        type: "message",
        status: "in_progress",
        role: "assistant",
        content: [],
      },
    },
    {
      type: "response.content_part.added",
      item_id: itemId,
      output_index: 0,
      content_index: 0,
      part: { type: "output_text", text: "", annotations: [], logprobs: [] },
    },
    {
      type: "response.output_text.delta",
      item_id: itemId,
      output_index: 0,
      content_index: 0,
      delta: text,
      logprobs: [],
    },
  ];
  return events
    .map(
      (event, index) =>
        `event: ${event.type}\ndata: ${JSON.stringify({ ...event, sequence_number: index })}\n\n`,
    )
    .join("");
}

function toolEvents(id: string): string {
  const item = {
    id: `fc_${id}`,
    type: "function_call",
    status: "completed",
    call_id: `call_${id}`,
    name: "fixture_tool",
    arguments: '{"value":"fixture"}',
  };
  const response = {
    id,
    object: "response",
    created_at: 1,
    status: "completed",
    model: "gpt-5.4",
    output: [item],
    usage: {
      input_tokens: 3,
      input_tokens_details: { cached_tokens: 0 },
      output_tokens: 2,
      output_tokens_details: { reasoning_tokens: 0 },
      total_tokens: 5,
    },
  };
  const events = [
    {
      type: "response.created",
      response: { ...response, status: "in_progress", output: [] },
    },
    {
      type: "response.output_item.added",
      output_index: 0,
      item: { ...item, status: "in_progress", arguments: "" },
    },
    {
      type: "response.function_call_arguments.delta",
      item_id: item.id,
      output_index: 0,
      delta: item.arguments,
    },
    {
      type: "response.function_call_arguments.done",
      item_id: item.id,
      output_index: 0,
      arguments: item.arguments,
    },
    { type: "response.output_item.done", output_index: 0, item },
    { type: "response.completed", response },
  ];
  return `${events.map((event, index) => `event: ${event.type}\ndata: ${JSON.stringify({ ...event, sequence_number: index })}\n\n`).join("")}data: [DONE]\n\n`;
}

async function availablePort(): Promise<number> {
  const probe = createServer();
  await new Promise<void>((resolve) => probe.listen(0, "127.0.0.1", resolve));
  const port = (probe.address() as AddressInfo).port;
  await new Promise<void>((resolve) => probe.close(() => resolve()));
  return port;
}

function close(server: Server): Promise<void> {
  return new Promise((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
}

export async function startFakeResponsesServer(): Promise<FakeResponsesServer> {
  const requests: Array<Record<string, unknown>> = [];
  const port = await availablePort();
  const server = createHttpServer(async (request, response) => {
    if (request.url !== "/v1/responses" || request.method !== "POST") {
      response.writeHead(404).end();
      return;
    }
    const body = await readBody(request);
    requests.push(body);
    if (requests.length === 2) {
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.write(
        partialResponseEvents("resp_fixture_pending", "stream-before-crash"),
      );
      request.once("close", () => response.end());
      return;
    }
    if (requests.length === 3) {
      response.writeHead(200, {
        "content-type": "text/event-stream",
        connection: "keep-alive",
        "cache-control": "no-cache",
      });
      response.end(toolEvents("resp_fixture_tool"));
      return;
    }
    response.writeHead(200, {
      "content-type": "text/event-stream",
      connection: "keep-alive",
      "cache-control": "no-cache",
    });
    response.end(
      responseEvents(
        `resp_fixture_${requests.length}`,
        requests.length === 4 ? "fixture tool result" : "fixture response",
      ),
    );
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", resolve);
  });
  return {
    baseURL: `http://127.0.0.1:${port}/v1`,
    requests,
    async waitForRequests(count) {
      const deadline = Date.now() + 5_000;
      while (requests.length < count && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      if (requests.length < count) {
        throw new Error(`Expected ${count} fixture Responses requests`);
      }
    },
    close: () => close(server),
  };
}

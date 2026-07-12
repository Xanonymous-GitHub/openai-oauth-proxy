import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import type { ThreadStartParams } from "../../src/codex/generated/v2/ThreadStartParams.js";
import { assertAllowedClientMethod } from "../../src/codex/transport.js";

// biome-ignore lint/suspicious/noExportsInTest: The protocol contract requires exported test allowlists.
export const ALLOWED_CLIENT_METHODS = new Set([
  "initialize",
  "account/read",
  "account/login/start",
  "account/login/cancel",
  "account/logout",
  "model/list",
  "thread/start",
  "thread/resume",
  "thread/fork",
  "thread/list",
  "thread/inject_items",
  "thread/delete",
  "turn/start",
  "turn/interrupt",
]);

// biome-ignore lint/suspicious/noExportsInTest: The protocol contract requires exported test allowlists.
export const ALLOWED_SERVER_METHODS = new Set(["item/tool/call"]);

interface ProtocolSchema {
  oneOf: Array<{
    properties: { method: { enum: string[] } };
  }>;
}

async function readSchema(name: string): Promise<ProtocolSchema> {
  return JSON.parse(
    await readFile(
      new URL(`../../src/codex/generated/${name}`, import.meta.url),
      "utf8",
    ),
  ) as ProtocolSchema;
}

function methods(schema: ProtocolSchema): string[] {
  return schema.oneOf.flatMap((variant) => variant.properties.method.enum);
}

describe("generated Codex protocol", () => {
  it("includes experimental dynamic function tools", () => {
    const params: ThreadStartParams = {
      dynamicTools: [
        {
          type: "function",
          name: "lookup",
          description: "Look up a record",
          inputSchema: { type: "object" },
        },
      ],
    };

    expect(params.dynamicTools?.[0]).toMatchObject({
      type: "function",
      name: "lookup",
    });
  });

  it("contains every allowed client method and rejects every generated method outside it", async () => {
    const generatedMethods = methods(await readSchema("ClientRequest.json"));

    expect(generatedMethods).toEqual(
      expect.arrayContaining([...ALLOWED_CLIENT_METHODS]),
    );
    for (const method of generatedMethods) {
      if (ALLOWED_CLIENT_METHODS.has(method))
        expect(() => assertAllowedClientMethod(method)).not.toThrow();
      else expect(() => assertAllowedClientMethod(method)).toThrow();
    }
  });

  it("contains the dynamic tool server request", async () => {
    const generatedMethods = methods(await readSchema("ServerRequest.json"));

    expect(generatedMethods).toEqual(
      expect.arrayContaining([...ALLOWED_SERVER_METHODS]),
    );
  });

  it("allows initialized as the only outgoing client notification", async () => {
    expect(methods(await readSchema("ClientNotification.json"))).toEqual([
      "initialized",
    ]);
  });
});

import { z } from "zod";
import { ProxyError } from "../http/errors.js";
import type { JsonValue } from "./types.js";

const nonEmptyString = z.string().min(1);
const imageDetailSchema = z.enum(["auto", "low", "high"]);
const dataImageUrlSchema = z
  .string()
  .regex(/^data:image\/(?:png|jpeg|webp);base64,/);
const reasoningEffortSchema = z.enum([
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
]);

const jsonValueSchema: z.ZodType<JsonValue> = z.lazy(() =>
  z.union([
    z.string(),
    z.number(),
    z.boolean(),
    z.null(),
    z.array(jsonValueSchema),
    z.record(z.string(), jsonValueSchema),
  ]),
);

const chatTextPartSchema = z.strictObject({
  type: z.literal("text"),
  text: z.string(),
});

const chatImagePartSchema = z.strictObject({
  type: z.literal("image_url"),
  image_url: z.strictObject({
    url: dataImageUrlSchema,
    detail: imageDetailSchema.optional(),
  }),
});

const chatTextContentSchema = z.union([
  z.string(),
  z.array(chatTextPartSchema),
]);
const chatUserContentSchema = z.union([
  z.string(),
  z.array(
    z.discriminatedUnion("type", [chatTextPartSchema, chatImagePartSchema]),
  ),
]);

const assistantToolCallSchema = z.strictObject({
  id: nonEmptyString,
  type: z.literal("function"),
  function: z.strictObject({
    name: nonEmptyString,
    arguments: z.string(),
  }),
});

const systemMessageSchema = z.strictObject({
  role: z.literal("system"),
  content: chatTextContentSchema,
});
const developerMessageSchema = z.strictObject({
  role: z.literal("developer"),
  content: chatTextContentSchema,
});
const userMessageSchema = z.strictObject({
  role: z.literal("user"),
  content: chatUserContentSchema,
});
const assistantMessageSchema = z
  .strictObject({
    role: z.literal("assistant"),
    content: z.string().nullable().optional(),
    tool_calls: z.array(assistantToolCallSchema).min(1).optional(),
  })
  .superRefine((message, context) => {
    if (message.content == null && message.tool_calls === undefined) {
      context.addIssue({
        code: "custom",
        message: "Assistant message requires content or tool calls",
        path: ["content"],
      });
    }
  });
const toolMessageSchema = z.strictObject({
  role: z.literal("tool"),
  tool_call_id: nonEmptyString,
  content: z.string(),
});

export const chatMessageSchema = z.discriminatedUnion("role", [
  systemMessageSchema,
  developerMessageSchema,
  userMessageSchema,
  assistantMessageSchema,
  toolMessageSchema,
]);

const functionToolSchema = z.strictObject({
  type: z.literal("function"),
  function: z.strictObject({
    name: nonEmptyString,
    description: z.string().optional(),
    parameters: jsonValueSchema,
  }),
});

const jsonSchemaDefinition = z.strictObject({
  name: nonEmptyString,
  description: z.string().optional(),
  schema: jsonValueSchema,
  strict: z.boolean().optional(),
});

const chatResponseFormatSchema = z.strictObject({
  type: z.literal("json_schema"),
  json_schema: jsonSchemaDefinition,
});

const chatRequestSchema = z.strictObject({
  model: nonEmptyString,
  messages: z.array(chatMessageSchema).min(1),
  stream: z.boolean().optional(),
  tools: z.array(functionToolSchema).optional(),
  tool_choice: z.enum(["auto", "none"]).optional(),
  parallel_tool_calls: z.literal(true).optional(),
  reasoning_effort: reasoningEffortSchema.optional(),
  response_format: chatResponseFormatSchema.optional(),
});

const responseInputTextSchema = z.strictObject({
  type: z.literal("input_text"),
  text: z.string(),
});
const responseOutputTextSchema = z.strictObject({
  type: z.literal("output_text"),
  text: z.string(),
});
const responseInputImageSchema = z.strictObject({
  type: z.literal("input_image"),
  file_id: z.never().optional(),
  image_url: dataImageUrlSchema,
  detail: imageDetailSchema.optional(),
});
const responseContentPartSchema = z.discriminatedUnion("type", [
  responseInputTextSchema,
  responseOutputTextSchema,
  responseInputImageSchema,
]);

const responseMessageSchema = z.strictObject({
  type: z.literal("message").optional(),
  role: z.enum(["system", "developer", "user", "assistant"]),
  content: z.union([z.string(), z.array(responseContentPartSchema)]),
});
const responseFunctionCallSchema = z.strictObject({
  type: z.literal("function_call"),
  id: nonEmptyString.optional(),
  call_id: nonEmptyString,
  name: nonEmptyString,
  arguments: z.string(),
});
const responseFunctionCallOutputSchema = z.strictObject({
  type: z.literal("function_call_output"),
  id: nonEmptyString.optional(),
  call_id: nonEmptyString,
  output: z.string(),
});

export const responseInputItemSchema = z.union([
  responseMessageSchema,
  responseFunctionCallSchema,
  responseFunctionCallOutputSchema,
]);

const responsesRequestSchema = z
  .strictObject({
    model: nonEmptyString,
    input: z.union([z.string(), z.array(responseInputItemSchema)]),
    instructions: z.string().optional(),
    stream: z.boolean().optional(),
    previous_response_id: nonEmptyString.optional(),
    store: z.boolean().optional(),
    tools: z.array(functionToolSchema).optional(),
    tool_choice: z.enum(["auto", "none"]).optional(),
    parallel_tool_calls: z.literal(true).optional(),
    reasoning: z
      .strictObject({ effort: reasoningEffortSchema.optional() })
      .optional(),
    text: z
      .strictObject({
        format: z.strictObject({
          type: z.literal("json_schema"),
          name: nonEmptyString,
          description: z.string().optional(),
          schema: jsonValueSchema,
          strict: z.boolean().optional(),
        }),
      })
      .optional(),
  })
  .superRefine((request, context) => {
    if (request.store === false && request.tools && request.tools.length > 0) {
      context.addIssue({
        code: "custom",
        message: "Function tools require stored Responses",
        path: ["store"],
        params: { proxyCode: "store_required_for_tools" },
      });
    }
  });

export type ChatMessage = z.infer<typeof chatMessageSchema>;
export type ChatRequest = z.infer<typeof chatRequestSchema>;
export type ResponsesInputItem = z.infer<typeof responseInputItemSchema>;
export type ResponsesRequest = z.infer<typeof responsesRequestSchema>;
export type ChatUserContent = z.infer<typeof chatUserContentSchema>;
export type ResponsesMessageContent = z.infer<
  typeof responseMessageSchema
>["content"];

type ZodIssue = z.core.$ZodIssue;

function nestedIssues(
  issue: ZodIssue,
  parentPath: PropertyKey[] = [],
): ZodIssue[] {
  const path = [...parentPath, ...issue.path];
  if (issue.code !== "invalid_union") {
    return [{ ...issue, path } as ZodIssue];
  }
  return issue.errors.flatMap((issues) =>
    issues.flatMap((nested) => nestedIssues(nested, path)),
  );
}

function issueParam(issue: ZodIssue): string | null {
  const path = [...issue.path];
  if (issue.code === "unrecognized_keys") path.push(issue.keys[0] ?? "");
  return path.length > 0 ? path.join(".") : null;
}

function issueDepth(issue: ZodIssue): number {
  return issue.path.length + (issue.code === "unrecognized_keys" ? 1 : 0);
}

function parseWithSchema<T>(schema: z.ZodType<T>, value: unknown): T {
  const parsed = schema.safeParse(value);
  if (parsed.success) return parsed.data;

  const issues = parsed.error.issues.flatMap((issue) => nestedIssues(issue));
  const issue = issues.reduce((deepest, current) =>
    issueDepth(current) > issueDepth(deepest) ? current : deepest,
  );
  const param = issueParam(issue);
  const customCode =
    issue.code === "custom" && "params" in issue
      ? (issue.params as { proxyCode?: unknown }).proxyCode
      : undefined;
  const code =
    typeof customCode === "string"
      ? customCode
      : issue.code === "unrecognized_keys"
        ? "unsupported_field"
        : "invalid_request";
  const message =
    code === "unsupported_field"
      ? `Unsupported field: ${param ?? "unknown"}`
      : issue.message;

  throw new ProxyError(400, code, message, param);
}

export function parseChatRequest(value: unknown): ChatRequest {
  return parseWithSchema(chatRequestSchema, value);
}

export function parseResponsesRequest(value: unknown): ResponsesRequest {
  return parseWithSchema(responsesRequestSchema, value);
}

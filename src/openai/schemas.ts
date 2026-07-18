import { z } from "zod";
import { ProxyError } from "../http/errors.js";
import type { JsonObject, JsonValue } from "./types.js";

const nonEmptyString = z.string().min(1);
const imageDetailSchema = z.enum(["auto", "low", "high"]);
const dataImageUrlSchema = z
  .string()
  .regex(/^data:image\/(?:png|jpeg|webp);base64,/);
const reasoningEffortSchema = z.enum([
  "none",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
]);
const reasoningSummarySchema = z.enum(["auto", "concise", "detailed"]);
const ignoredOutputTokenLimitSchema = z.number().int().positive().nullable();
const ignoredTemperatureSchema = z.number().min(0).max(2).nullable();
const ignoredTopPSchema = z.number().min(0).max(1).nullable();
const ignoredPenaltySchema = z.number().min(-2).max(2).nullable();
const ignoredTopLogprobsSchema = z.number().int().min(0).max(20).nullable();
const serviceTierSchema = z
  .enum(["auto", "default", "flex", "scale", "priority"])
  .nullable();
const promptCacheOptionsSchema = z.strictObject({
  mode: z.enum(["implicit", "explicit"]).optional(),
  ttl: z.literal("30m").optional(),
});
const promptCacheRetentionSchema = z.enum(["in_memory", "24h"]).nullable();

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
const jsonObjectSchema: z.ZodType<JsonObject> = z.record(
  z.string(),
  jsonValueSchema,
);
const metadataSchema = z
  .record(z.string().max(64), z.string().max(512))
  .refine((metadata) => Object.keys(metadata).length <= 16, {
    message: "Metadata may contain at most 16 entries",
  })
  .nullable();
const moderationTargetSchema = z.strictObject({
  mode: z.enum(["score", "block"]),
});
const moderationSchema = z
  .strictObject({
    model: nonEmptyString,
    policy: z
      .strictObject({
        input: moderationTargetSchema.nullable().optional(),
        output: moderationTargetSchema.nullable().optional(),
      })
      .nullable()
      .optional(),
  })
  .nullable();

const chatTextPartSchema = z.strictObject({
  type: z.literal("text"),
  text: z.string(),
});
const predictedTextPartSchema = z.strictObject({
  type: z.literal("text"),
  text: z.string(),
  prompt_cache_breakpoint: z
    .strictObject({ mode: z.literal("explicit") })
    .optional(),
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
  index: z.number().int().nonnegative().optional(),
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
  name: nonEmptyString.optional(),
});

export const chatMessageSchema = z.discriminatedUnion("role", [
  systemMessageSchema,
  developerMessageSchema,
  userMessageSchema,
  assistantMessageSchema,
  toolMessageSchema,
]);

const chatFunctionToolSchema = z.strictObject({
  type: z.literal("function"),
  function: z.strictObject({
    name: nonEmptyString,
    description: z.string().optional(),
    parameters: jsonObjectSchema.optional(),
  }),
});
const legacyChatFunctionSchema = z.strictObject({
  name: nonEmptyString,
  description: z.string().optional(),
  parameters: jsonObjectSchema.optional(),
});
const chatToolChoiceSchema = z.union([
  z.enum(["none", "auto", "required"]),
  z.strictObject({
    type: z.literal("function"),
    function: z.strictObject({ name: nonEmptyString }),
  }),
  z.strictObject({
    type: z.literal("allowed_tools"),
    allowed_tools: z.strictObject({
      mode: z.enum(["auto", "required"]),
      tools: z.array(jsonObjectSchema),
    }),
  }),
]);
const legacyFunctionChoiceSchema = z.union([
  z.enum(["none", "auto"]),
  z.strictObject({ name: nonEmptyString }),
]);
const chatAudioSchema = z
  .strictObject({
    format: z.enum(["wav", "aac", "mp3", "flac", "opus", "pcm16"]),
    voice: z.union([nonEmptyString, z.strictObject({ id: nonEmptyString })]),
  })
  .nullable();
const chatWebSearchOptionsSchema = z.strictObject({
  search_context_size: z.enum(["low", "medium", "high"]).optional(),
  user_location: z
    .strictObject({
      type: z.literal("approximate"),
      approximate: z.strictObject({
        city: z.string().optional(),
        country: z.string().optional(),
        region: z.string().optional(),
        timezone: z.string().optional(),
      }),
    })
    .nullable()
    .optional(),
});

const responsesFunctionToolSchema = z.strictObject({
  type: z.literal("function"),
  name: nonEmptyString,
  description: z.string().optional(),
  parameters: jsonObjectSchema,
  strict: z.boolean().optional(),
});
const responsesToolChoiceSchema = z.union([
  z.enum(["auto", "none", "required"]),
  z.strictObject({ type: z.literal("function"), name: nonEmptyString }),
  z.strictObject({
    type: z.literal("allowed_tools"),
    mode: z.enum(["auto", "required"]),
    tools: z.array(jsonObjectSchema),
  }),
]);

const jsonSchemaDefinition = z.strictObject({
  name: nonEmptyString,
  description: z.string().optional(),
  schema: jsonObjectSchema,
  strict: z.boolean().optional(),
});

const chatResponseFormatSchema = z.discriminatedUnion("type", [
  z.strictObject({ type: z.literal("text") }),
  z.strictObject({ type: z.literal("json_object") }),
  z.strictObject({
    type: z.literal("json_schema"),
    json_schema: jsonSchemaDefinition,
  }),
]);

const chatRequestSchema = z
  .strictObject({
    model: nonEmptyString,
    messages: z.array(chatMessageSchema).min(1),
    stream: z.boolean().nullable().optional(),
    stream_options: z
      .strictObject({
        include_usage: z.boolean().optional(),
        // Compatibility no-op: this proxy does not emit stream payload obfuscation.
        include_obfuscation: z.boolean().optional(),
      })
      .nullable()
      .optional(),
    tools: z.array(chatFunctionToolSchema).optional(),
    tool_choice: chatToolChoiceSchema.optional(),
    functions: z.array(legacyChatFunctionSchema).optional(),
    function_call: legacyFunctionChoiceSchema.optional(),
    parallel_tool_calls: z.boolean().optional(),
    reasoning_effort: reasoningEffortSchema.nullable().optional(),
    // Compatibility no-ops: Codex App Server has no equivalent sampling controls.
    frequency_penalty: ignoredPenaltySchema.optional(),
    presence_penalty: ignoredPenaltySchema.optional(),
    // Compatibility no-op: Codex App Server has no per-turn sampling temperature override.
    temperature: ignoredTemperatureSchema.optional(),
    top_p: ignoredTopPSchema.optional(),
    logit_bias: z
      .record(z.string(), z.number().min(-100).max(100))
      .nullable()
      .optional(),
    logprobs: z.boolean().nullable().optional(),
    top_logprobs: ignoredTopLogprobsSchema.optional(),
    seed: z.number().int().nullable().optional(),
    stop: z
      .union([z.string(), z.array(z.string()).max(4), z.null()])
      .optional(),
    n: z.number().int().min(1).max(128).nullable().optional(),
    modalities: z
      .array(z.enum(["text", "audio"]))
      .nullable()
      .optional(),
    audio: chatAudioSchema.optional(),
    prediction: z
      .strictObject({
        type: z.literal("content"),
        content: z.union([z.string(), z.array(predictedTextPartSchema)]),
      })
      .nullable()
      .optional(),
    verbosity: z.enum(["low", "medium", "high"]).nullable().optional(),
    web_search_options: chatWebSearchOptionsSchema.optional(),
    metadata: metadataSchema.optional(),
    moderation: moderationSchema.optional(),
    store: z.boolean().nullable().optional(),
    // Compatibility no-ops: Codex owns cache routing and this proxy does not persist client identifiers.
    prompt_cache_key: nonEmptyString.optional(),
    prompt_cache_options: promptCacheOptionsSchema.optional(),
    prompt_cache_retention: promptCacheRetentionSchema.optional(),
    safety_identifier: z.string().max(64).optional(),
    user: z.string().optional(),
    service_tier: serviceTierSchema.optional(),
    // Compatibility no-op: Codex App Server cannot enforce this limit, but agent clients send it by default.
    max_completion_tokens: ignoredOutputTokenLimitSchema.optional(),
    max_tokens: ignoredOutputTokenLimitSchema.optional(),
    response_format: chatResponseFormatSchema.optional(),
  })
  .superRefine((request, context) => {
    if (request.stream_options != null && request.stream !== true) {
      context.addIssue({
        code: "custom",
        message: "Stream options require streaming",
        path: ["stream_options"],
      });
    }
  });

const responseInputTextSchema = z.strictObject({
  type: z.literal("input_text"),
  text: z.string(),
});
const responseOutputTextSchema = z.strictObject({
  type: z.literal("output_text"),
  text: z.string(),
  annotations: z.array(z.never()).optional(),
  logprobs: z.array(z.never()).optional(),
});
const responseInputImageSchema = z.strictObject({
  type: z.literal("input_image"),
  file_id: z.never().optional(),
  image_url: dataImageUrlSchema,
  detail: imageDetailSchema.optional(),
});
const promptCacheBreakpointSchema = z.strictObject({
  mode: z.literal("explicit"),
});
const responsePromptValueSchema = z.union([
  z.string(),
  z.strictObject({
    type: z.literal("input_text"),
    text: z.string(),
    prompt_cache_breakpoint: promptCacheBreakpointSchema.optional(),
  }),
  z.strictObject({
    type: z.literal("input_image"),
    detail: z.enum(["auto", "low", "high", "original"]),
    file_id: z.string().nullable().optional(),
    image_url: z.string().nullable().optional(),
    prompt_cache_breakpoint: promptCacheBreakpointSchema.optional(),
  }),
  z.strictObject({
    type: z.literal("input_file"),
    detail: imageDetailSchema.optional(),
    file_data: z.string().optional(),
    file_id: z.string().nullable().optional(),
    file_url: z.string().optional(),
    filename: z.string().optional(),
    prompt_cache_breakpoint: promptCacheBreakpointSchema.optional(),
  }),
]);
const responseUserContentPartSchema = z.discriminatedUnion("type", [
  responseInputTextSchema,
  responseInputImageSchema,
]);

const responseTextContentSchema = z.union([
  z.string(),
  z.array(responseInputTextSchema),
]);
const responseUserContentSchema = z.union([
  z.string(),
  z.array(responseUserContentPartSchema),
]);
const responseSystemMessageSchema = z.strictObject({
  type: z.literal("message").optional(),
  role: z.literal("system"),
  content: responseTextContentSchema,
});
const responseDeveloperMessageSchema = z.strictObject({
  type: z.literal("message").optional(),
  role: z.literal("developer"),
  content: responseTextContentSchema,
});
const responseUserMessageSchema = z.strictObject({
  type: z.literal("message").optional(),
  role: z.literal("user"),
  content: responseUserContentSchema,
});
const responseAssistantMessageSchema = z.strictObject({
  id: nonEmptyString.optional(),
  type: z.literal("message").optional(),
  role: z.literal("assistant"),
  // Output-item metadata accepted for replay; status is validated but is not model-visible history.
  status: z.enum(["in_progress", "completed", "incomplete"]).optional(),
  phase: z.enum(["commentary", "final_answer"]).optional(),
  content: z.union([
    z.string(),
    z.array(
      z.discriminatedUnion("type", [
        responseInputTextSchema,
        responseOutputTextSchema,
      ]),
    ),
  ]),
});
const responseMessageSchema = z.discriminatedUnion("role", [
  responseSystemMessageSchema,
  responseDeveloperMessageSchema,
  responseUserMessageSchema,
  responseAssistantMessageSchema,
]);
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
    instructions: z.string().nullable().optional(),
    stream: z.boolean().nullable().optional(),
    previous_response_id: nonEmptyString.nullable().optional(),
    store: z.boolean().nullable().optional(),
    tools: z.array(responsesFunctionToolSchema).optional(),
    tool_choice: responsesToolChoiceSchema.optional(),
    parallel_tool_calls: z.boolean().nullable().optional(),
    // Compatibility no-ops for OpenAI resource, lifecycle, and moderation features not exposed by Codex.
    background: z.boolean().nullable().optional(),
    conversation: z
      .union([nonEmptyString, z.strictObject({ id: nonEmptyString }), z.null()])
      .optional(),
    context_management: z
      .array(
        z.strictObject({
          type: z.literal("compaction"),
          compact_threshold: z.number().nullable().optional(),
        }),
      )
      .nullable()
      .optional(),
    max_tool_calls: z.number().int().positive().nullable().optional(),
    metadata: metadataSchema.optional(),
    moderation: moderationSchema.optional(),
    prompt: z
      .strictObject({
        id: nonEmptyString,
        version: z.string().nullable().optional(),
        variables: z
          .record(z.string(), responsePromptValueSchema)
          .nullable()
          .optional(),
      })
      .nullable()
      .optional(),
    stream_options: z
      .strictObject({ include_obfuscation: z.boolean().optional() })
      .nullable()
      .optional(),
    truncation: z.enum(["auto", "disabled"]).nullable().optional(),
    top_logprobs: ignoredTopLogprobsSchema.optional(),
    top_p: ignoredTopPSchema.optional(),
    service_tier: serviceTierSchema.optional(),
    prompt_cache_options: promptCacheOptionsSchema.optional(),
    prompt_cache_retention: promptCacheRetentionSchema.optional(),
    safety_identifier: z.string().max(64).optional(),
    user: z.string().optional(),
    // Compatibility no-op: Codex App Server has no per-turn sampling temperature override.
    temperature: ignoredTemperatureSchema.optional(),
    // Compatibility no-op: Codex App Server cannot enforce this limit, but Responses clients send it by default.
    max_output_tokens: ignoredOutputTokenLimitSchema.optional(),
    // Compatibility no-op: continuations stay server-side, so encrypted reasoning is neither needed nor exposed.
    include: z
      .array(
        z.enum([
          "file_search_call.results",
          "web_search_call.results",
          "web_search_call.action.sources",
          "message.input_image.image_url",
          "computer_call_output.output.image_url",
          "code_interpreter_call.outputs",
          "reasoning.encrypted_content",
          "message.output_text.logprobs",
        ]),
      )
      .nullable()
      .optional(),
    // Compatibility no-op: Codex App Server owns upstream prompt-cache routing.
    prompt_cache_key: nonEmptyString.optional(),
    reasoning: z
      .strictObject({
        effort: reasoningEffortSchema.nullable().optional(),
        summary: reasoningSummarySchema.nullable().optional(),
      })
      .nullable()
      .optional(),
    text: z
      .strictObject({
        // Compatibility no-op: Codex App Server has no per-turn verbosity override.
        verbosity: z.enum(["low", "medium", "high"]).nullable().optional(),
        format: z
          .discriminatedUnion("type", [
            z.strictObject({ type: z.literal("text") }),
            z.strictObject({
              type: z.literal("json_schema"),
              name: nonEmptyString,
              description: z.string().optional(),
              schema: jsonObjectSchema,
              strict: z.boolean().optional(),
            }),
          ])
          .optional(),
      })
      .optional(),
  })
  .superRefine((request, context) => {
    if (request.stream_options != null && request.stream !== true) {
      context.addIssue({
        code: "custom",
        message: "Stream options require streaming",
        path: ["stream_options"],
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
export type ResponsesUserContent = z.infer<typeof responseUserContentSchema>;

type ZodIssue = z.core.$ZodIssue;

function nestedIssues(
  issue: ZodIssue,
  parentPath: PropertyKey[] = [],
): ZodIssue[] {
  const path = [...parentPath, ...issue.path];
  if (issue.code !== "invalid_union") {
    return [{ ...issue, path } as ZodIssue];
  }
  if (issue.errors.length === 0) {
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

  throw ProxyError.public(400, code, message, param);
}

export function parseChatRequest(value: unknown): ChatRequest {
  return parseWithSchema(chatRequestSchema, value);
}

export function parseResponsesRequest(value: unknown): ResponsesRequest {
  return parseWithSchema(responsesRequestSchema, value);
}

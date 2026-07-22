import type { ServerRequest } from "./generated/ServerRequest.js";
import type { GetAccountResponse } from "./generated/v2/GetAccountResponse.js";
import type { Model } from "./generated/v2/Model.js";
import type { ModelListResponse } from "./generated/v2/ModelListResponse.js";
import type { Thread } from "./generated/v2/Thread.js";
import type { ThreadStartResponse } from "./generated/v2/ThreadStartResponse.js";
import type { Turn } from "./generated/v2/Turn.js";
import type { TurnStartResponse } from "./generated/v2/TurnStartResponse.js";

type ToolCallRequest = Extract<ServerRequest, { method: "item/tool/call" }>;

export function fakeAccountResponse(
  overrides: Partial<GetAccountResponse> = {},
): GetAccountResponse {
  return {
    account: {
      type: "chatgpt",
      email: "fixture@example.com",
      planType: "plus",
    },
    requiresOpenaiAuth: true,
    ...overrides,
  };
}

export function fakeModel(overrides: Partial<Model> = {}): Model {
  return {
    id: "gpt-5.2-codex",
    model: "gpt-5.2-codex",
    upgrade: null,
    upgradeInfo: null,
    availabilityNux: null,
    displayName: "GPT-5.2 Codex",
    description: "Deterministic fake Codex model",
    hidden: false,
    supportedReasoningEfforts: [],
    defaultReasoningEffort: "medium",
    inputModalities: ["text"],
    supportsPersonality: false,
    additionalSpeedTiers: [],
    serviceTiers: [],
    defaultServiceTier: null,
    isDefault: true,
    ...overrides,
  };
}

export function fakeModelListResponse(
  overrides: Partial<ModelListResponse> = {},
): ModelListResponse {
  return { data: [fakeModel()], nextCursor: null, ...overrides };
}

export function fakeThread(overrides: Partial<Thread> = {}): Thread {
  return {
    id: "thread-1",
    extra: null,
    sessionId: "session-1",
    forkedFromId: null,
    parentThreadId: null,
    preview: "",
    ephemeral: false,
    historyMode: "legacy",
    modelProvider: "openai",
    createdAt: 1,
    updatedAt: 1,
    recencyAt: 1,
    status: { type: "idle" },
    path: null,
    cwd: "/workspace",
    cliVersion: "0.144.1",
    source: "appServer",
    canAcceptDirectInput: true,
    threadSource: null,
    agentNickname: null,
    agentRole: null,
    gitInfo: null,
    name: null,
    turns: [],
    ...overrides,
  };
}

export function fakeThreadStartResponse(
  overrides: Partial<ThreadStartResponse> = {},
): ThreadStartResponse {
  return {
    thread: fakeThread(),
    model: "gpt-5.2-codex",
    modelProvider: "openai",
    serviceTier: null,
    cwd: "/workspace",
    runtimeWorkspaceRoots: [],
    instructionSources: [],
    approvalPolicy: "never",
    approvalsReviewer: "user",
    sandbox: { type: "dangerFullAccess" },
    activePermissionProfile: null,
    reasoningEffort: "medium",
    multiAgentMode: "explicitRequestOnly",
    ...overrides,
  };
}

export function fakeTurn(overrides: Partial<Turn> = {}): Turn {
  return {
    id: "turn-1",
    items: [],
    itemsView: "full",
    status: "inProgress",
    error: null,
    startedAt: 1,
    completedAt: null,
    durationMs: null,
    ...overrides,
  };
}

export function fakeTurnStartResponse(
  overrides: Partial<TurnStartResponse> = {},
): TurnStartResponse {
  return { turn: fakeTurn(), ...overrides };
}

export function fakeToolCallRequest(
  overrides: Partial<ToolCallRequest> = {},
): ToolCallRequest {
  return {
    id: "tool-1",
    method: "item/tool/call",
    params: {
      threadId: "thread-1",
      turnId: "turn-1",
      callId: "call-1",
      namespace: null,
      tool: "lookup",
      arguments: {},
    },
    ...overrides,
  };
}

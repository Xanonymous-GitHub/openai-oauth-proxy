import { readFileSync } from "node:fs";
import { createInterface } from "node:readline";

const scriptedRecords = process.env.FAKE_CODEX_SCRIPT
  ? JSON.parse(readFileSync(process.env.FAKE_CODEX_SCRIPT, "utf8"))
  : [];
if (process.env.FAKE_CODEX_STDERR_SENTINEL) {
  process.stderr.write(`${process.env.FAKE_CODEX_STDERR_SENTINEL}\n`);
}

let initializeReceived = false;
let initializedReceived = false;
let loginId = 0;
let threadId = 0;
let turnId = 0;
let toolId = 0;
let dynamicTools = [];

function write(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function thread(id, forkedFromId = null) {
  return {
    id,
    extra: null,
    sessionId: "session-1",
    forkedFromId,
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
    threadSource: null,
    agentNickname: null,
    agentRole: null,
    gitInfo: null,
    name: null,
    turns: [],
  };
}

function threadResponse(value, extra = {}) {
  return {
    thread: value,
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
    ...extra,
  };
}

function turn(id) {
  return {
    id,
    items: [],
    itemsView: "full",
    status: "inProgress",
    error: null,
    startedAt: 1,
    completedAt: null,
    durationMs: null,
  };
}

function respond(id, result) {
  write({ id, result });
}

function emitCompletion(
  threadIdValue,
  turnIdValue,
  text = "fixture child response",
) {
  write({
    method: "item/agentMessage/delta",
    params: {
      threadId: threadIdValue,
      turnId: turnIdValue,
      itemId: `message-${turnIdValue}`,
      delta: text,
    },
  });
  write({
    method: "item/completed",
    params: {
      threadId: threadIdValue,
      turnId: turnIdValue,
      completedAtMs: 1,
      item: {
        type: "agentMessage",
        id: `message-${turnIdValue}`,
        text,
        phase: null,
        memoryCitation: null,
      },
    },
  });
  write({
    method: "turn/completed",
    params: {
      threadId: threadIdValue,
      turn: { ...turn(turnIdValue), status: "completed", completedAt: 1 },
    },
  });
}

function reject(id, code, message) {
  write({ id, error: { code, message } });
}

function handleRequest({ id, method, params }) {
  if (method === "initialize") {
    initializeReceived = true;
    respond(id, {
      userAgent: "fake-codex-app-server/0.144.1",
      codexHome: "/tmp/fake-codex-home",
      platformFamily: "unix",
      platformOs: process.platform,
    });
    return;
  }
  if (!initializeReceived) {
    reject(id, -32002, "App Server is not initialized");
    return;
  }

  switch (method) {
    case "account/read":
      respond(id, {
        account: {
          type: "chatgpt",
          email: "fixture@example.com",
          planType: "plus",
        },
        requiresOpenaiAuth: true,
      });
      break;
    case "account/login/start":
      loginId += 1;
      if (params?.type === "chatgptDeviceCode") {
        respond(id, {
          type: "chatgptDeviceCode",
          loginId: `login-${loginId}`,
          verificationUrl: "https://example.test/device",
          userCode: "FAKE-CODE",
        });
      } else {
        respond(id, { type: params?.type ?? "apiKey" });
      }
      break;
    case "account/login/cancel":
      respond(id, { status: "canceled" });
      break;
    case "account/logout":
    case "thread/inject_items":
    case "thread/delete":
    case "turn/interrupt":
      respond(id, {});
      break;
    case "model/list":
      respond(id, {
        data: [
          {
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
          },
        ],
        nextCursor: null,
      });
      break;
    case "thread/start": {
      threadId += 1;
      dynamicTools = params?.dynamicTools ?? [];
      respond(id, threadResponse(thread(`thread-${threadId}`)));
      break;
    }
    case "thread/resume":
      respond(
        id,
        threadResponse(thread(params.threadId), { initialTurnsPage: null }),
      );
      break;
    case "thread/fork": {
      threadId += 1;
      respond(
        id,
        threadResponse(thread(`thread-${threadId}`, params.threadId)),
      );
      break;
    }
    case "turn/start": {
      if (process.env.FAKE_CODEX_TURN_ERROR) {
        reject(id, -32000, process.env.FAKE_CODEX_TURN_ERROR);
        break;
      }
      turnId += 1;
      const currentTurnId = `turn-${turnId}`;
      respond(id, { turn: turn(currentTurnId) });
      const tool = dynamicTools.find(
        (candidate) => candidate.type === "function",
      );
      if (tool) {
        toolId += 1;
        write({
          id: `tool-${toolId}`,
          method: "item/tool/call",
          params: {
            threadId: params.threadId,
            turnId: currentTurnId,
            callId: `call-${toolId}`,
            namespace: null,
            tool: tool.name,
            arguments: {},
          },
        });
      } else if (process.env.FAKE_CODEX_AUTOCOMPLETE === "1") {
        emitCompletion(params.threadId, currentTurnId);
      }
      break;
    }
    default:
      reject(id, -32601, "Method not found");
  }
}

const lines = createInterface({
  input: process.stdin,
  crlfDelay: Number.POSITIVE_INFINITY,
});
for await (const line of lines) {
  let message;
  try {
    message = JSON.parse(line);
  } catch {
    continue;
  }

  if (message.method === "initialized" && message.id === undefined) {
    if (initializeReceived && !initializedReceived) {
      initializedReceived = true;
      for (const record of scriptedRecords) write(record);
    }
    continue;
  }
  if (message.id !== undefined && typeof message.method === "string") {
    handleRequest(message);
  }
}

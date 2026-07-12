import type { RequestId } from "./generated/RequestId.js";
import type { ServerNotification } from "./generated/ServerNotification.js";
import type { CancelLoginAccountParams } from "./generated/v2/CancelLoginAccountParams.js";
import type { CancelLoginAccountResponse } from "./generated/v2/CancelLoginAccountResponse.js";
import type { DynamicToolCallParams } from "./generated/v2/DynamicToolCallParams.js";
import type { DynamicToolCallResponse } from "./generated/v2/DynamicToolCallResponse.js";
import type { GetAccountResponse } from "./generated/v2/GetAccountResponse.js";
import type { LoginAccountParams } from "./generated/v2/LoginAccountParams.js";
import type { LoginAccountResponse } from "./generated/v2/LoginAccountResponse.js";
import type { LogoutAccountResponse } from "./generated/v2/LogoutAccountResponse.js";
import type { ModelListParams } from "./generated/v2/ModelListParams.js";
import type { ModelListResponse } from "./generated/v2/ModelListResponse.js";
import type { ThreadDeleteParams } from "./generated/v2/ThreadDeleteParams.js";
import type { ThreadDeleteResponse } from "./generated/v2/ThreadDeleteResponse.js";
import type { ThreadForkParams } from "./generated/v2/ThreadForkParams.js";
import type { ThreadForkResponse } from "./generated/v2/ThreadForkResponse.js";
import type { ThreadInjectItemsParams } from "./generated/v2/ThreadInjectItemsParams.js";
import type { ThreadInjectItemsResponse } from "./generated/v2/ThreadInjectItemsResponse.js";
import type { ThreadListParams } from "./generated/v2/ThreadListParams.js";
import type { ThreadListResponse } from "./generated/v2/ThreadListResponse.js";
import type { ThreadResumeParams } from "./generated/v2/ThreadResumeParams.js";
import type { ThreadResumeResponse } from "./generated/v2/ThreadResumeResponse.js";
import type { ThreadStartParams } from "./generated/v2/ThreadStartParams.js";
import type { ThreadStartResponse } from "./generated/v2/ThreadStartResponse.js";
import type { TurnInterruptParams } from "./generated/v2/TurnInterruptParams.js";
import type { TurnInterruptResponse } from "./generated/v2/TurnInterruptResponse.js";
import type { TurnStartParams } from "./generated/v2/TurnStartParams.js";
import type { TurnStartResponse } from "./generated/v2/TurnStartResponse.js";

export interface CodexHost {
  readonly generation: number;
  accountRead(
    refreshToken: boolean,
    signal?: AbortSignal,
  ): Promise<GetAccountResponse>;
  loginStart(
    params: LoginAccountParams,
    signal?: AbortSignal,
  ): Promise<LoginAccountResponse>;
  loginCancel(
    params: CancelLoginAccountParams,
    signal?: AbortSignal,
  ): Promise<CancelLoginAccountResponse>;
  logout(signal?: AbortSignal): Promise<LogoutAccountResponse>;
  modelList(
    params: ModelListParams,
    signal?: AbortSignal,
  ): Promise<ModelListResponse>;
  threadStart(
    params: ThreadStartParams,
    signal?: AbortSignal,
  ): Promise<ThreadStartResponse>;
  threadResume(
    params: ThreadResumeParams,
    signal?: AbortSignal,
  ): Promise<ThreadResumeResponse>;
  threadFork(
    params: ThreadForkParams,
    signal?: AbortSignal,
  ): Promise<ThreadForkResponse>;
  threadList(
    params: ThreadListParams,
    signal?: AbortSignal,
  ): Promise<ThreadListResponse>;
  threadInjectItems(
    params: ThreadInjectItemsParams,
    signal?: AbortSignal,
  ): Promise<ThreadInjectItemsResponse>;
  threadDelete(
    params: ThreadDeleteParams,
    signal?: AbortSignal,
  ): Promise<ThreadDeleteResponse>;
  turnStart(
    params: TurnStartParams,
    signal?: AbortSignal,
  ): Promise<TurnStartResponse>;
  turnInterrupt(
    params: TurnInterruptParams,
    signal?: AbortSignal,
  ): Promise<TurnInterruptResponse>;
  events(): AsyncIterable<HostNotification>;
  toolCalls(): AsyncIterable<PendingServerToolCall>;
}

export type HostNotification = ServerNotification & { generation: number };

export interface PendingServerToolCall {
  generation: number;
  id: RequestId;
  params: DynamicToolCallParams;
  respond(result: DynamicToolCallResponse): void;
  reject(code: number, message: string): void;
}

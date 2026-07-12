import { randomBytes } from "node:crypto";
import { DatabaseSync, type StatementSync } from "node:sqlite";
import { migrateConversations } from "./migrations.js";

export interface ConversationClock {
  now(): number;
}

export interface ConversationStoreOptions {
  responseTtlMs: number;
  turnLeaseMs: number;
  toolLeaseMs: number;
}

export type LeaseKind = "turn" | "tool";
export type ResponseState = "pending" | "complete" | "lost" | "expired";
export type OperationAction = "start" | "resume" | "fork";
export type OperationState = "active" | "abandoned";

export type ContinuationDecision =
  | { type: "start" }
  | { type: "resume"; responseId: string; threadId: string }
  | {
      type: "fork";
      responseId: string;
      threadId: string;
      lastTurnId: string;
    }
  | { type: "busy" }
  | { type: "not_found" }
  | { type: "lost" };

export interface CreatePendingResponse {
  threadId: string;
  parentResponseId?: string;
  parentThreadId?: string;
  forkedAtTurnId?: string;
  stored: boolean;
  processGeneration: number;
}

export interface ReserveOperationInput {
  responseId: string;
  previousResponseId?: string;
  ownerRequestId: string;
  stored: boolean;
  processGeneration: number;
  operationCwd: string;
}

export type OperationDecision =
  | { type: "start" }
  | {
      type: "resume" | "fork";
      responseId: string;
      threadId: string;
      lastTurnId: string;
    }
  | { type: "busy" }
  | { type: "not_found" }
  | { type: "lost" };

export interface ResponseOperation {
  responseId: string;
  ownerRequestId: string;
  action: OperationAction;
  state: OperationState;
  stored: boolean;
  parentResponseId?: string;
  sourceThreadId?: string;
  sourceTurnId?: string;
  threadId?: string;
  turnId?: string;
  operationCwd?: string;
  recoveryPending: boolean;
  processGeneration: number;
  createdAt: number;
  expiresAt: number;
}

export interface ResponseMapping {
  responseId: string;
  threadId: string;
  turnId?: string;
  parentResponseId?: string;
  rootResponseId: string;
  state: ResponseState;
  stored: boolean;
  processGeneration: number;
  createdAt: number;
  lastAccessAt: number;
  expiresAt: number;
}

interface ResponseRow {
  response_id: string;
  thread_id: string;
  turn_id: string | null;
  parent_response_id: string | null;
  root_response_id: string;
  state: ResponseState;
  stored: number;
  process_generation: number;
  created_at: number;
  last_access_at: number;
  expires_at: number;
}

interface LineageRow {
  parent_thread_id: string | null;
  forked_at_turn_id: string | null;
}

interface ExistsRow {
  present: number;
}

interface ThreadRow {
  thread_id: string;
}

interface OperationRow {
  response_id: string;
  owner_request_id: string;
  action: OperationAction;
  state: OperationState;
  stored: number;
  parent_response_id: string | null;
  source_thread_id: string | null;
  source_turn_id: string | null;
  thread_id: string | null;
  turn_id: string | null;
  process_generation: number;
  created_at: number;
  expires_at: number;
  operation_cwd: string | null;
  recovery_pending: number;
}

interface Statements {
  insertLineage: StatementSync;
  readLineage: StatementSync;
  insertResponse: StatementSync;
  completeResponse: StatementSync;
  expireResponse: StatementSync;
  expireResponses: StatementSync;
  readResponse: StatementSync;
  touchResponse: StatementSync;
  deleteStaleLease: StatementSync;
  deleteStaleLeases: StatementSync;
  countActiveLeases: StatementSync;
  insertLease: StatementSync;
  releaseLease: StatementSync;
  promoteLease: StatementSync;
  losePendingResponses: StatementSync;
  losePendingResponse: StatementSync;
  deleteOldGenerationLeases: StatementSync;
  hasCompleteDescendant: StatementSync;
  deletableThreads: StatementSync;
  deletePendingResponse: StatementSync;
  countThreadResponses: StatementSync;
  deleteThreadResponses: StatementSync;
  deleteThreadLineage: StatementSync;
  insertOperation: StatementSync;
  readOperation: StatementSync;
  hasActiveSourceOperation: StatementSync;
  attachOperation: StatementSync;
  attachOperationTurn: StatementSync;
  insertCompletedResponse: StatementSync;
  abandonOperation: StatementSync;
  retainOperationForRecovery: StatementSync;
  deleteOperation: StatementSync;
  abandonOldOperations: StatementSync;
  deleteRecoveryResumes: StatementSync;
  operationsForRecovery: StatementSync;
  abandonedThreads: StatementSync;
  abandonedOperations: StatementSync;
  finishAbandonedThread: StatementSync;
  finishAbandonedOperation: StatementSync;
}

export class ConversationStore {
  readonly #database: DatabaseSync;
  readonly #clock: ConversationClock;
  readonly #responseTtlMs: number;
  readonly #turnLeaseMs: number;
  readonly #toolLeaseMs: number;
  readonly #statements: Statements;
  #closed = false;

  private constructor(
    database: DatabaseSync,
    clock: ConversationClock,
    options: ConversationStoreOptions,
  ) {
    this.#database = database;
    this.#clock = clock;
    this.#responseTtlMs = options.responseTtlMs;
    this.#turnLeaseMs = options.turnLeaseMs;
    this.#toolLeaseMs = options.toolLeaseMs;
    this.#statements = {
      insertLineage: database.prepare(`
        INSERT INTO thread_lineage(thread_id, parent_thread_id, forked_at_turn_id)
        VALUES (?, ?, ?)
        ON CONFLICT(thread_id) DO NOTHING
      `),
      readLineage: database.prepare(`
        SELECT parent_thread_id, forked_at_turn_id
        FROM thread_lineage
        WHERE thread_id = ?
      `),
      insertResponse: database.prepare(`
        INSERT INTO responses(
          response_id, thread_id, turn_id, parent_response_id,
          root_response_id, state, stored, process_generation,
          created_at, last_access_at, expires_at
        )
        VALUES (
          ?, ?, NULL, ?,
          COALESCE(
            (SELECT root_response_id FROM responses WHERE response_id = ?),
            ?
          ),
          'pending', ?, ?, ?, ?, ?
        )
      `),
      completeResponse: database.prepare(`
        UPDATE responses
        SET turn_id = ?,
            state = CASE stored WHEN 1 THEN 'complete' ELSE 'expired' END,
            last_access_at = ?,
            expires_at = CASE stored WHEN 1 THEN ? ELSE ? END
        WHERE response_id = ? AND state = 'pending'
      `),
      expireResponse: database.prepare(`
        UPDATE responses
        SET state = 'expired'
        WHERE response_id = ?
          AND state IN ('pending', 'complete', 'lost')
          AND (
            expires_at <= ?
            OR (state IN ('complete', 'lost') AND stored = 0)
          )
      `),
      expireResponses: database.prepare(`
        UPDATE responses
        SET state = 'expired'
        WHERE state IN ('pending', 'complete', 'lost')
          AND (
            expires_at <= ?
            OR (state IN ('complete', 'lost') AND stored = 0)
          )
      `),
      readResponse: database.prepare(`
        SELECT response_id, thread_id, turn_id, parent_response_id,
               root_response_id, state, stored, process_generation,
               created_at, last_access_at, expires_at
        FROM responses
        WHERE response_id = ?
      `),
      touchResponse: database.prepare(`
        UPDATE responses
        SET last_access_at = ?, expires_at = ?
        WHERE response_id = ? AND state = 'complete' AND stored = 1
      `),
      deleteStaleLease: database.prepare(`
        DELETE FROM thread_leases
        WHERE thread_id = ? AND expires_at <= ?
      `),
      deleteStaleLeases: database.prepare(`
        DELETE FROM thread_leases WHERE expires_at <= ?
      `),
      countActiveLeases: database.prepare(`
        SELECT COUNT(*) AS count
        FROM thread_leases
        WHERE expires_at > ?
      `),
      insertLease: database.prepare(`
        INSERT INTO thread_leases(
          thread_id, owner_request_id, kind, process_generation, expires_at
        )
        VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(thread_id) DO NOTHING
      `),
      releaseLease: database.prepare(`
        DELETE FROM thread_leases
        WHERE thread_id = ? AND owner_request_id = ?
      `),
      promoteLease: database.prepare(`
        UPDATE thread_leases
        SET kind = 'tool', expires_at = ?
        WHERE thread_id = ? AND owner_request_id = ?
      `),
      losePendingResponses: database.prepare(`
        UPDATE responses
        SET state = 'lost', last_access_at = ?, expires_at = ?
        WHERE state = 'pending'
      `),
      losePendingResponse: database.prepare(`
        UPDATE responses
        SET state = 'lost', last_access_at = ?, expires_at = ?
        WHERE response_id = ? AND state = 'pending'
      `),
      deleteOldGenerationLeases: database.prepare(`
        DELETE FROM thread_leases
      `),
      hasCompleteDescendant: database.prepare(`
        WITH RECURSIVE descendants(response_id) AS (
          SELECT response_id
          FROM responses
          WHERE parent_response_id = ? AND thread_id = ?
          UNION ALL
          SELECT response.response_id
          FROM responses AS response
          JOIN descendants
            ON response.parent_response_id = descendants.response_id
          WHERE response.thread_id = ?
        )
        SELECT EXISTS(
          SELECT 1
          FROM descendants
          JOIN responses USING (response_id)
          WHERE responses.turn_id IS NOT NULL
        ) AS present
      `),
      deletableThreads: database.prepare(`
        WITH RECURSIVE
          descendants(ancestor_thread_id, descendant_thread_id) AS (
            SELECT parent_thread_id, thread_id
            FROM thread_lineage
            WHERE parent_thread_id IS NOT NULL
            UNION ALL
            SELECT descendants.ancestor_thread_id, lineage.thread_id
            FROM descendants
            JOIN thread_lineage AS lineage
              ON lineage.parent_thread_id = descendants.descendant_thread_id
          ),
          depths(thread_id, depth) AS (
            SELECT thread_id, 0
            FROM thread_lineage
            WHERE parent_thread_id IS NULL
            UNION ALL
            SELECT lineage.thread_id, depths.depth + 1
            FROM depths
            JOIN thread_lineage AS lineage
              ON lineage.parent_thread_id = depths.thread_id
          ),
          expired_threads(thread_id) AS (
            SELECT lineage.thread_id
            FROM thread_lineage AS lineage
            WHERE EXISTS (
              SELECT 1 FROM responses
              WHERE responses.thread_id = lineage.thread_id
            )
              AND NOT EXISTS (
                SELECT 1 FROM responses
                WHERE responses.thread_id = lineage.thread_id
                  AND responses.state <> 'expired'
              )
          )
        SELECT expired_threads.thread_id
        FROM expired_threads
        LEFT JOIN depths USING (thread_id)
        WHERE NOT EXISTS (
          SELECT 1
          FROM descendants
          JOIN responses
            ON responses.thread_id = descendants.descendant_thread_id
          WHERE descendants.ancestor_thread_id = expired_threads.thread_id
            AND responses.state <> 'expired'
        )
          AND NOT EXISTS (
            SELECT 1 FROM thread_leases
            WHERE thread_leases.thread_id = expired_threads.thread_id
          )
          AND NOT EXISTS (
            SELECT 1
            FROM descendants
            JOIN thread_leases
              ON thread_leases.thread_id = descendants.descendant_thread_id
            WHERE descendants.ancestor_thread_id = expired_threads.thread_id
          )
        ORDER BY COALESCE(depths.depth, 0) DESC, expired_threads.thread_id
      `),
      deletePendingResponse: database.prepare(`
        DELETE FROM responses
        WHERE response_id = ? AND state = 'pending'
        RETURNING thread_id
      `),
      countThreadResponses: database.prepare(`
        SELECT COUNT(*) AS count FROM responses WHERE thread_id = ?
      `),
      deleteThreadResponses: database.prepare(`
        DELETE FROM responses WHERE thread_id = ?
      `),
      deleteThreadLineage: database.prepare(`
        DELETE FROM thread_lineage WHERE thread_id = ?
      `),
      insertOperation: database.prepare(`
        INSERT INTO response_operations(
          response_id, owner_request_id, action, state, stored,
          parent_response_id, source_thread_id, source_turn_id,
          thread_id, turn_id, process_generation, created_at, expires_at,
          operation_cwd, recovery_pending
        ) VALUES (?, ?, ?, 'active', ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, 0)
      `),
      readOperation: database.prepare(`
        SELECT response_id, owner_request_id, action, state, stored,
               parent_response_id, source_thread_id, source_turn_id,
               thread_id, turn_id, process_generation, created_at, expires_at,
               operation_cwd, recovery_pending
        FROM response_operations
        WHERE response_id = ?
      `),
      hasActiveSourceOperation: database.prepare(`
        SELECT EXISTS(
          SELECT 1 FROM response_operations
          WHERE source_thread_id = ? AND state = 'active'
        ) AS present
      `),
      attachOperation: database.prepare(`
        UPDATE response_operations
        SET thread_id = ?
        WHERE response_id = ? AND state = 'active' AND thread_id IS NULL
      `),
      attachOperationTurn: database.prepare(`
        UPDATE response_operations
        SET turn_id = ?
        WHERE response_id = ? AND state = 'active'
          AND thread_id IS NOT NULL AND turn_id IS NULL
      `),
      insertCompletedResponse: database.prepare(`
        INSERT INTO responses(
          response_id, thread_id, turn_id, parent_response_id,
          root_response_id, state, stored, process_generation,
          created_at, last_access_at, expires_at
        ) VALUES (
          ?, ?, ?, ?,
          COALESCE(
            (SELECT root_response_id FROM responses WHERE response_id = ?),
            ?
          ),
          'complete', 1, ?, ?, ?, ?
        )
      `),
      abandonOperation: database.prepare(`
        UPDATE response_operations
        SET state = 'abandoned'
        WHERE response_id = ? AND state = 'active'
      `),
      retainOperationForRecovery: database.prepare(`
        UPDATE response_operations
        SET recovery_pending = 1
        WHERE response_id = ? AND state = 'active'
          AND action IN ('start', 'fork') AND thread_id IS NULL
          AND operation_cwd IS NOT NULL
      `),
      deleteOperation: database.prepare(`
        DELETE FROM response_operations WHERE response_id = ?
      `),
      abandonOldOperations: database.prepare(`
        UPDATE response_operations
        SET state = CASE
              WHEN action IN ('start', 'fork') AND thread_id IS NOT NULL
                THEN 'abandoned'
              ELSE state
            END,
            recovery_pending = CASE action WHEN 'resume' THEN 0 ELSE 1 END
        WHERE state = 'active'
      `),
      deleteRecoveryResumes: database.prepare(`
        DELETE FROM response_operations
        WHERE state = 'active' AND action = 'resume'
      `),
      operationsForRecovery: database.prepare(`
        SELECT response_id, owner_request_id, action, state, stored,
               parent_response_id, source_thread_id, source_turn_id,
               thread_id, turn_id, process_generation, created_at, expires_at,
               operation_cwd, recovery_pending
        FROM response_operations
        WHERE recovery_pending = 1
        ORDER BY created_at, response_id
      `),
      abandonedThreads: database.prepare(`
        SELECT DISTINCT thread_id
        FROM response_operations
        WHERE state = 'abandoned' AND thread_id IS NOT NULL
          AND action IN ('start', 'fork')
        ORDER BY thread_id
      `),
      abandonedOperations: database.prepare(`
        SELECT response_id, owner_request_id, action, state, stored,
               parent_response_id, source_thread_id, source_turn_id,
               thread_id, turn_id, process_generation, created_at, expires_at,
               operation_cwd, recovery_pending
        FROM response_operations
        WHERE state = 'abandoned' AND thread_id IS NOT NULL
          AND action IN ('start', 'fork')
        ORDER BY created_at, response_id
      `),
      finishAbandonedThread: database.prepare(`
        DELETE FROM response_operations
        WHERE state = 'abandoned' AND thread_id = ?
          AND action IN ('start', 'fork')
      `),
      finishAbandonedOperation: database.prepare(`
        DELETE FROM response_operations
        WHERE response_id = ? AND state = 'abandoned'
          AND action IN ('start', 'fork')
      `),
    };
  }

  static open(
    path: string,
    clock: ConversationClock,
    options: ConversationStoreOptions,
  ): ConversationStore {
    assertDuration("responseTtlMs", options.responseTtlMs);
    assertDuration("turnLeaseMs", options.turnLeaseMs);
    assertDuration("toolLeaseMs", options.toolLeaseMs);
    const database = new DatabaseSync(path, { timeout: 5_000 });
    try {
      database.exec(`
        PRAGMA journal_mode = WAL;
        PRAGMA foreign_keys = ON;
        PRAGMA busy_timeout = 5000;
      `);
      migrateConversations(database, () => clock.now());
      return new ConversationStore(database, clock, options);
    } catch (error) {
      database.close();
      throw error;
    }
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#database.close();
  }

  createPending(input: CreatePendingResponse): string {
    const responseId = `resp_${randomBytes(24).toString("base64url")}`;
    this.beginPending(responseId, input);
    return responseId;
  }

  beginPending(
    responseId: string,
    input: CreatePendingResponse,
    leaseOwnerRequestId?: string,
  ): boolean {
    const now = this.#clock.now();
    return this.#transaction(() => {
      if (leaseOwnerRequestId !== undefined) {
        this.#statements.deleteStaleLease.run(input.threadId, now);
        const lease = this.#statements.insertLease.run(
          input.threadId,
          leaseOwnerRequestId,
          "turn",
          input.processGeneration,
          now + this.#turnLeaseMs,
        );
        if (lease.changes !== 1) return false;
      }
      const inserted = this.#statements.insertLineage.run(
        input.threadId,
        input.parentThreadId ?? null,
        input.forkedAtTurnId ?? null,
      );
      if (inserted.changes === 0 && input.parentThreadId !== undefined) {
        const lineage = this.#statements.readLineage.get(
          input.threadId,
        ) as unknown as LineageRow | undefined;
        if (
          lineage?.parent_thread_id !== input.parentThreadId ||
          lineage.forked_at_turn_id !== (input.forkedAtTurnId ?? null)
        ) {
          throw new Error(`Conflicting lineage for thread ${input.threadId}`);
        }
      }
      this.#statements.insertResponse.run(
        responseId,
        input.threadId,
        input.parentResponseId ?? null,
        input.parentResponseId ?? null,
        responseId,
        input.stored ? 1 : 0,
        input.processGeneration,
        now,
        now,
        now + this.#responseTtlMs,
      );
      return true;
    });
  }

  complete(responseId: string, turnId: string): void {
    const now = this.#clock.now();
    this.#transaction(() => {
      this.#statements.expireResponse.run(responseId, now);
      const result = this.#statements.completeResponse.run(
        turnId,
        now,
        now + this.#responseTtlMs,
        now,
        responseId,
      );
      if (result.changes !== 1) {
        throw new Error(`Pending response ${responseId} does not exist`);
      }
    });
  }

  lookup(responseId: string): ResponseMapping | undefined {
    return this.#transaction(() => {
      this.#statements.expireResponse.run(responseId, this.#clock.now());
      const row = this.#responseRow(responseId);
      if (!row || row.state === "expired" || row.stored === 0) return undefined;
      return mapResponse(row);
    });
  }

  touch(responseId: string): boolean {
    const now = this.#clock.now();
    return this.#transaction(() => {
      this.#statements.expireResponse.run(responseId, now);
      return (
        this.#statements.touchResponse.run(
          now,
          now + this.#responseTtlMs,
          responseId,
        ).changes === 1
      );
    });
  }

  acquireLease(
    threadId: string,
    ownerRequestId: string,
    kind: LeaseKind,
    processGeneration: number,
  ): boolean {
    const now = this.#clock.now();
    const leaseMs = kind === "tool" ? this.#toolLeaseMs : this.#turnLeaseMs;
    return this.#transaction(() => {
      this.#statements.deleteStaleLease.run(threadId, now);
      return (
        this.#statements.insertLease.run(
          threadId,
          ownerRequestId,
          kind,
          processGeneration,
          now + leaseMs,
        ).changes === 1
      );
    });
  }

  releaseLease(threadId: string, ownerRequestId: string): boolean {
    return (
      this.#statements.releaseLease.run(threadId, ownerRequestId).changes === 1
    );
  }

  busyThreads(): number {
    const row = this.#statements.countActiveLeases.get(
      this.#clock.now(),
    ) as unknown as { count: number };
    return row.count;
  }

  reserveOperation(input: ReserveOperationInput): OperationDecision {
    return this.#transaction(() => {
      const now = this.#clock.now();
      if (input.previousResponseId === undefined) {
        this.#insertOperation(input, "start", undefined, undefined, now);
        return { type: "start" };
      }

      this.#statements.expireResponse.run(input.previousResponseId, now);
      const response = this.#responseRow(input.previousResponseId);
      if (!response || response.state === "expired" || response.stored === 0) {
        return { type: "not_found" };
      }
      if (response.state === "lost") return { type: "lost" };
      if (response.state !== "complete" || response.turn_id === null) {
        return { type: "busy" };
      }
      const active = this.#statements.hasActiveSourceOperation.get(
        response.thread_id,
      ) as unknown as ExistsRow;
      if (active.present !== 0) return { type: "busy" };

      this.#statements.deleteStaleLease.run(response.thread_id, now);
      const acquired = this.#statements.insertLease.run(
        response.thread_id,
        input.ownerRequestId,
        "turn",
        input.processGeneration,
        now + this.#turnLeaseMs,
      );
      if (acquired.changes !== 1) return { type: "busy" };

      this.#statements.touchResponse.run(
        now,
        now + this.#responseTtlMs,
        response.response_id,
      );
      const descendant = this.#statements.hasCompleteDescendant.get(
        response.response_id,
        response.thread_id,
        response.thread_id,
      ) as unknown as ExistsRow;
      const action: OperationAction =
        !input.stored || descendant.present !== 0 ? "fork" : "resume";
      this.#insertOperation(
        input,
        action,
        response.thread_id,
        response.turn_id,
        now,
      );
      return {
        type: action,
        responseId: response.response_id,
        threadId: response.thread_id,
        lastTurnId: response.turn_id,
      };
    });
  }

  lookupOperation(responseId: string): ResponseOperation | undefined {
    const row = this.#operationRow(responseId);
    return row ? mapOperation(row) : undefined;
  }

  attachOperation(responseId: string, threadId: string): void {
    this.#transaction(() => {
      const attached = this.#statements.attachOperation.run(
        threadId,
        responseId,
      );
      if (attached.changes === 1) return;
      const operation = this.#operationRow(responseId);
      if (operation?.state !== "active" || operation.thread_id !== threadId) {
        throw new Error(
          `Active response operation ${responseId} does not exist`,
        );
      }
    });
  }

  attachOperationTurn(responseId: string, turnId: string): void {
    this.#transaction(() => {
      if (
        this.#statements.attachOperationTurn.run(turnId, responseId).changes !==
        1
      ) {
        throw new Error(
          `Attached response operation ${responseId} does not exist`,
        );
      }
    });
  }

  suspendOperation(responseId: string): void {
    this.#transaction(() => {
      const operation = this.#operationRow(responseId);
      if (
        operation?.state !== "active" ||
        operation.thread_id === null ||
        operation.turn_id === null
      ) {
        throw new Error(
          `Suspend response operation ${responseId} does not exist`,
        );
      }
      const existing = this.#responseRow(responseId);
      if (existing?.state !== "pending") {
        const parentThreadId =
          operation.action === "fork" ? operation.source_thread_id : null;
        const forkedAtTurnId =
          operation.action === "fork" ? operation.source_turn_id : null;
        this.#statements.insertLineage.run(
          operation.thread_id,
          parentThreadId,
          forkedAtTurnId,
        );
        const now = this.#clock.now();
        this.#statements.insertResponse.run(
          operation.response_id,
          operation.thread_id,
          operation.parent_response_id,
          operation.parent_response_id,
          operation.response_id,
          operation.stored,
          operation.process_generation,
          operation.created_at,
          now,
          now + this.#responseTtlMs,
        );
      }
      const leaseThreadId = operation.source_thread_id ?? operation.thread_id;
      const expiresAt = this.#clock.now() + this.#toolLeaseMs;
      if (
        this.#statements.promoteLease.run(
          expiresAt,
          leaseThreadId,
          operation.owner_request_id,
        ).changes !== 1 &&
        this.#statements.insertLease.run(
          leaseThreadId,
          operation.owner_request_id,
          "tool",
          operation.process_generation,
          expiresAt,
        ).changes !== 1
      ) {
        throw new Error(`Could not retain tool lease for ${responseId}`);
      }
    });
  }

  completeOperation(responseId: string): string | undefined {
    return this.#transaction(() => {
      const operation = this.#operationRow(responseId);
      if (
        operation?.state !== "active" ||
        operation.thread_id === null ||
        operation.turn_id === null
      ) {
        throw new Error(
          `Complete response operation ${responseId} does not exist`,
        );
      }
      const now = this.#clock.now();
      if (operation.stored === 1) {
        const parentThreadId =
          operation.action === "fork" ? operation.source_thread_id : null;
        const forkedAtTurnId =
          operation.action === "fork" ? operation.source_turn_id : null;
        this.#statements.insertLineage.run(
          operation.thread_id,
          parentThreadId,
          forkedAtTurnId,
        );
        const pending = this.#responseRow(operation.response_id);
        if (pending?.state === "pending") {
          this.#statements.completeResponse.run(
            operation.turn_id,
            now,
            now + this.#responseTtlMs,
            now,
            operation.response_id,
          );
        } else {
          this.#statements.insertCompletedResponse.run(
            operation.response_id,
            operation.thread_id,
            operation.turn_id,
            operation.parent_response_id,
            operation.parent_response_id,
            operation.response_id,
            operation.process_generation,
            operation.created_at,
            now,
            now + this.#responseTtlMs,
          );
        }
      }
      this.#releaseOperationLease(operation);
      this.#statements.deleteOperation.run(responseId);
      return operation.operation_cwd ?? undefined;
    });
  }

  abandonOperation(
    responseId: string,
    openedThreadId?: string,
    retainUnattached = false,
  ): string | undefined {
    return this.#transaction(() => {
      const operation = this.#operationRow(responseId);
      if (operation?.state !== "active") return undefined;
      this.#releaseOperationLease(operation);
      let cleanupThreadId = operation.thread_id;
      if (
        cleanupThreadId === null &&
        openedThreadId !== undefined &&
        (operation.action === "start" || operation.action === "fork")
      ) {
        if (
          this.#statements.attachOperation.run(openedThreadId, responseId)
            .changes !== 1
        ) {
          throw new Error(`Could not retain abandoned operation ${responseId}`);
        }
        cleanupThreadId = openedThreadId;
      }
      if (
        cleanupThreadId !== null &&
        (operation.action === "start" || operation.action === "fork")
      ) {
        this.#statements.abandonOperation.run(responseId);
        return cleanupThreadId;
      }
      if (
        retainUnattached &&
        (operation.action === "start" || operation.action === "fork") &&
        this.#statements.retainOperationForRecovery.run(responseId).changes ===
          1
      ) {
        return undefined;
      }
      this.#statements.deleteOperation.run(responseId);
      return undefined;
    });
  }

  loseOperation(responseId: string): string | undefined {
    const now = this.#clock.now();
    this.#statements.losePendingResponse.run(
      now,
      now + this.#responseTtlMs,
      responseId,
    );
    return this.abandonOperation(responseId);
  }

  abandonedThreads(): string[] {
    return (
      this.#statements.abandonedThreads.all() as unknown as Array<{
        thread_id: string;
      }>
    ).map((row) => row.thread_id);
  }

  recoveryOperations(): ResponseOperation[] {
    return (
      this.#statements.operationsForRecovery.all() as unknown as OperationRow[]
    ).map(mapOperation);
  }

  abandonedOperations(): ResponseOperation[] {
    return (
      this.#statements.abandonedOperations.all() as unknown as OperationRow[]
    ).map(mapOperation);
  }

  finishAbandonedThread(threadId: string): boolean {
    return this.#statements.finishAbandonedThread.run(threadId).changes > 0;
  }

  finishAbandonedOperation(responseId: string): boolean {
    return (
      this.#statements.finishAbandonedOperation.run(responseId).changes === 1
    );
  }

  markContinuationLost(_currentProcessGeneration: number): number {
    const now = this.#clock.now();
    return this.#transaction(() => {
      this.#statements.expireResponses.run(now);
      const result = this.#statements.losePendingResponses.run(
        now,
        now + this.#responseTtlMs,
      );
      this.#statements.deleteOldGenerationLeases.run();
      this.#statements.abandonOldOperations.run();
      const removed = this.#statements.deleteRecoveryResumes.run();
      return Number(result.changes) + Number(removed.changes);
    });
  }

  expire(): number {
    return this.#transaction(() => {
      const now = this.#clock.now();
      const result = this.#statements.expireResponses.run(now);
      this.#statements.deleteStaleLeases.run(now);
      return Number(result.changes);
    });
  }

  deletableLeafThreads(): string[] {
    return this.#transaction(() => {
      const now = this.#clock.now();
      this.#statements.expireResponses.run(now);
      this.#statements.deleteStaleLeases.run(now);
      return (
        this.#statements.deletableThreads.all() as unknown as ThreadRow[]
      ).map((row) => row.thread_id);
    });
  }

  abandon(responseId: string): boolean {
    return this.#transaction(() => {
      const deleted = this.#statements.deletePendingResponse.get(
        responseId,
      ) as unknown as { thread_id: string } | undefined;
      if (!deleted) return false;
      const remaining = this.#statements.countThreadResponses.get(
        deleted.thread_id,
      ) as unknown as { count: number };
      if (remaining.count === 0) {
        this.#statements.deleteThreadLineage.run(deleted.thread_id);
      }
      return true;
    });
  }

  removeThread(threadId: string): boolean {
    return this.#transaction(() => {
      const responses = this.#statements.deleteThreadResponses.run(threadId);
      const lineage = this.#statements.deleteThreadLineage.run(threadId);
      return responses.changes > 0 || lineage.changes > 0;
    });
  }

  decide(
    previousResponseId: string | undefined,
    ownerRequestId: string,
  ): ContinuationDecision {
    if (previousResponseId === undefined) return { type: "start" };

    return this.#transaction(() => {
      const now = this.#clock.now();
      this.#statements.expireResponse.run(previousResponseId, now);
      const response = this.#responseRow(previousResponseId);
      if (!response || response.state === "expired" || response.stored === 0) {
        return { type: "not_found" };
      }
      if (response.state === "lost") return { type: "lost" };
      if (response.state !== "complete" || response.turn_id === null) {
        return { type: "busy" };
      }

      this.#statements.deleteStaleLease.run(response.thread_id, now);
      const acquired = this.#statements.insertLease.run(
        response.thread_id,
        ownerRequestId,
        "turn",
        response.process_generation,
        now + this.#turnLeaseMs,
      );
      if (acquired.changes !== 1) return { type: "busy" };

      this.#statements.touchResponse.run(
        now,
        now + this.#responseTtlMs,
        response.response_id,
      );
      const descendant = this.#statements.hasCompleteDescendant.get(
        response.response_id,
        response.thread_id,
        response.thread_id,
      ) as unknown as ExistsRow;
      if (descendant.present === 0) {
        return {
          type: "resume",
          responseId: response.response_id,
          threadId: response.thread_id,
        };
      }
      return {
        type: "fork",
        responseId: response.response_id,
        threadId: response.thread_id,
        lastTurnId: response.turn_id,
      };
    });
  }

  #responseRow(responseId: string): ResponseRow | undefined {
    return this.#statements.readResponse.get(responseId) as unknown as
      | ResponseRow
      | undefined;
  }

  #operationRow(responseId: string): OperationRow | undefined {
    return this.#statements.readOperation.get(responseId) as unknown as
      | OperationRow
      | undefined;
  }

  #insertOperation(
    input: ReserveOperationInput,
    action: OperationAction,
    sourceThreadId: string | undefined,
    sourceTurnId: string | undefined,
    now: number,
  ): void {
    this.#statements.insertOperation.run(
      input.responseId,
      input.ownerRequestId,
      action,
      input.stored ? 1 : 0,
      input.previousResponseId ?? null,
      sourceThreadId ?? null,
      sourceTurnId ?? null,
      action === "resume" ? (sourceThreadId ?? null) : null,
      input.processGeneration,
      now,
      now + this.#responseTtlMs,
      action === "resume" ? null : input.operationCwd,
    );
  }

  #releaseOperationLease(operation: OperationRow): void {
    if (operation.source_thread_id !== null) {
      this.#statements.releaseLease.run(
        operation.source_thread_id,
        operation.owner_request_id,
      );
    }
    if (operation.thread_id !== null) {
      this.#statements.releaseLease.run(
        operation.thread_id,
        operation.owner_request_id,
      );
    }
  }

  #transaction<T>(operation: () => T): T {
    this.#database.exec("BEGIN IMMEDIATE");
    try {
      const result = operation();
      this.#database.exec("COMMIT");
      return result;
    } catch (error) {
      this.#database.exec("ROLLBACK");
      throw error;
    }
  }
}

function assertDuration(name: string, value: number): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
}

function mapResponse(row: ResponseRow): ResponseMapping {
  return {
    responseId: row.response_id,
    threadId: row.thread_id,
    ...(row.turn_id === null ? {} : { turnId: row.turn_id }),
    ...(row.parent_response_id === null
      ? {}
      : { parentResponseId: row.parent_response_id }),
    rootResponseId: row.root_response_id,
    state: row.state,
    stored: row.stored === 1,
    processGeneration: row.process_generation,
    createdAt: row.created_at,
    lastAccessAt: row.last_access_at,
    expiresAt: row.expires_at,
  };
}

function mapOperation(row: OperationRow): ResponseOperation {
  return {
    responseId: row.response_id,
    ownerRequestId: row.owner_request_id,
    action: row.action,
    state: row.state,
    stored: row.stored === 1,
    ...(row.parent_response_id === null
      ? {}
      : { parentResponseId: row.parent_response_id }),
    ...(row.source_thread_id === null
      ? {}
      : { sourceThreadId: row.source_thread_id }),
    ...(row.source_turn_id === null
      ? {}
      : { sourceTurnId: row.source_turn_id }),
    ...(row.thread_id === null ? {} : { threadId: row.thread_id }),
    ...(row.turn_id === null ? {} : { turnId: row.turn_id }),
    ...(row.operation_cwd === null ? {} : { operationCwd: row.operation_cwd }),
    recoveryPending: row.recovery_pending === 1,
    processGeneration: row.process_generation,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
  };
}

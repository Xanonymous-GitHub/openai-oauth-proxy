import { randomBytes } from "node:crypto";
import { DatabaseSync, type StatementSync } from "node:sqlite";
import { migrateConversations } from "./migrations.js";

const DAY_MS = 24 * 60 * 60 * 1_000;
const RESPONSE_TTL_MS = 7 * DAY_MS;
const TURN_LEASE_MS = 10 * 60 * 1_000;
const TOOL_LEASE_MS = 15 * 60 * 1_000;

export interface ConversationClock {
  now(): number;
}

export type LeaseKind = "turn" | "tool";
export type ResponseState = "pending" | "complete" | "lost" | "expired";

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
  insertLease: StatementSync;
  releaseLease: StatementSync;
  losePendingResponses: StatementSync;
  deleteOldGenerationLeases: StatementSync;
  hasCompleteDescendant: StatementSync;
  deletableThreads: StatementSync;
}

export class ConversationStore {
  readonly #database: DatabaseSync;
  readonly #clock: ConversationClock;
  readonly #statements: Statements;
  #closed = false;

  private constructor(database: DatabaseSync, clock: ConversationClock) {
    this.#database = database;
    this.#clock = clock;
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
          AND state IN ('complete', 'lost')
          AND (stored = 0 OR expires_at <= ?)
      `),
      expireResponses: database.prepare(`
        UPDATE responses
        SET state = 'expired'
        WHERE state IN ('complete', 'lost')
          AND (stored = 0 OR expires_at <= ?)
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
      losePendingResponses: database.prepare(`
        UPDATE responses
        SET state = 'lost', last_access_at = ?, expires_at = ?
        WHERE state = 'pending' AND process_generation <> ?
      `),
      deleteOldGenerationLeases: database.prepare(`
        DELETE FROM thread_leases WHERE process_generation <> ?
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
        ORDER BY COALESCE(depths.depth, 0) DESC, expired_threads.thread_id
      `),
    };
  }

  static open(path: string, clock: ConversationClock): ConversationStore {
    const database = new DatabaseSync(path, { timeout: 5_000 });
    try {
      database.exec(`
        PRAGMA journal_mode = WAL;
        PRAGMA foreign_keys = ON;
        PRAGMA busy_timeout = 5000;
      `);
      migrateConversations(database, () => clock.now());
      return new ConversationStore(database, clock);
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
    const now = this.#clock.now();
    return this.#transaction(() => {
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
        now + RESPONSE_TTL_MS,
      );
      return responseId;
    });
  }

  complete(responseId: string, turnId: string): void {
    const now = this.#clock.now();
    this.#transaction(() => {
      const result = this.#statements.completeResponse.run(
        turnId,
        now,
        now + RESPONSE_TTL_MS,
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
          now + RESPONSE_TTL_MS,
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
    const leaseMs = kind === "tool" ? TOOL_LEASE_MS : TURN_LEASE_MS;
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

  markContinuationLost(currentProcessGeneration: number): number {
    const now = this.#clock.now();
    return this.#transaction(() => {
      const result = this.#statements.losePendingResponses.run(
        now,
        now + RESPONSE_TTL_MS,
        currentProcessGeneration,
      );
      this.#statements.deleteOldGenerationLeases.run(currentProcessGeneration);
      return Number(result.changes);
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
        now + TURN_LEASE_MS,
      );
      if (acquired.changes !== 1) return { type: "busy" };

      this.#statements.touchResponse.run(
        now,
        now + RESPONSE_TTL_MS,
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

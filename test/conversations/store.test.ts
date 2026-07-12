import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { migrateConversations } from "../../src/conversations/migrations.js";
import {
  type ConversationClock,
  ConversationStore,
  type ConversationStoreOptions,
} from "../../src/conversations/store.js";

const DAY_MS = 24 * 60 * 60 * 1_000;
const TURN_LEASE_MS = 10 * 60 * 1_000;
const LEASE_OPTIONS: ConversationStoreOptions = {
  responseTtlMs: 7 * DAY_MS,
  turnLeaseMs: TURN_LEASE_MS,
  toolLeaseMs: 15 * 60 * 1_000,
};

let now = 1_700_000_000_000;
const clock: ConversationClock = { now: () => now };
const directories = new Set<string>();
const stores = new Set<ConversationStore>();

function databasePath(): string {
  const directory = mkdtempSync(join(tmpdir(), "conversation-store-"));
  directories.add(directory);
  return join(directory, "proxy.sqlite");
}

function open(
  path = databasePath(),
  options: ConversationStoreOptions = LEASE_OPTIONS,
): ConversationStore {
  const store = ConversationStore.open(path, clock, options);
  stores.add(store);
  return store;
}

function openPreviousReader(
  path: string,
  supportedVersion: number,
): DatabaseSync {
  const database = new DatabaseSync(path);
  try {
    database.exec("PRAGMA foreign_keys = ON");
    migrateConversations(database, () => now, supportedVersion);
    return database;
  } catch (error) {
    database.close();
    throw error;
  }
}

function close(store: ConversationStore): void {
  store.close();
  stores.delete(store);
}

function completeResponse(
  store: ConversationStore,
  input: Parameters<ConversationStore["createPending"]>[0],
  turnId: string,
): string {
  const responseId = store.createPending(input);
  store.complete(responseId, turnId);
  return responseId;
}

afterEach(() => {
  for (const store of stores) store.close();
  for (const directory of directories) {
    rmSync(directory, { recursive: true, force: true });
  }
  stores.clear();
  directories.clear();
  now = 1_700_000_000_000;
});

describe("ConversationStore", () => {
  it("starts, resumes the exact latest response, forks an older response, and fences competing decisions", () => {
    const store = open();

    expect(store.decide(undefined, "req-1")).toEqual({ type: "start" });

    const olderId = completeResponse(
      store,
      { threadId: "thr_a", stored: true, processGeneration: 1 },
      "turn_1",
    );
    now += 1;
    const latestId = completeResponse(
      store,
      {
        threadId: "thr_a",
        parentResponseId: olderId,
        stored: true,
        processGeneration: 1,
      },
      "turn_2",
    );

    expect(latestId).toMatch(/^resp_[A-Za-z0-9_-]{32}$/);
    expect(store.decide(latestId, "req-2")).toEqual({
      type: "resume",
      responseId: latestId,
      threadId: "thr_a",
    });
    expect(store.releaseLease("thr_a", "req-2")).toBe(true);

    expect(store.decide(olderId, "req-3")).toEqual({
      type: "fork",
      responseId: olderId,
      threadId: "thr_a",
      lastTurnId: "turn_1",
    });
    expect(store.decide(latestId, "req-4")).toEqual({ type: "busy" });
  });

  it("treats latest as the latest complete response on the exact thread branch", () => {
    const store = open();
    const rootId = completeResponse(
      store,
      { threadId: "thr_root", stored: true, processGeneration: 1 },
      "turn_root",
    );
    now += 1;
    completeResponse(
      store,
      {
        threadId: "thr_child",
        parentResponseId: rootId,
        parentThreadId: "thr_root",
        forkedAtTurnId: "turn_root",
        stored: true,
        processGeneration: 1,
      },
      "turn_child",
    );

    expect(store.decide(rootId, "req-root")).toEqual({
      type: "resume",
      responseId: rootId,
      threadId: "thr_root",
    });
  });

  it("keeps a response as a fork point after its later same-thread mapping expires", () => {
    const store = open();
    const olderId = completeResponse(
      store,
      { threadId: "thr_history", stored: true, processGeneration: 1 },
      "turn_old",
    );
    now += 1;
    completeResponse(
      store,
      {
        threadId: "thr_history",
        parentResponseId: olderId,
        stored: true,
        processGeneration: 1,
      },
      "turn_new",
    );

    now += 6 * DAY_MS;
    expect(store.touch(olderId)).toBe(true);
    now += 2 * DAY_MS;

    expect(store.decide(olderId, "req-history")).toEqual({
      type: "fork",
      responseId: olderId,
      threadId: "thr_history",
      lastTurnId: "turn_old",
    });
  });

  it("slides stored response expiry seven days from the injected clock", () => {
    const store = open();
    const responseId = completeResponse(
      store,
      { threadId: "thr_touch", stored: true, processGeneration: 1 },
      "turn_touch",
    );
    const original = store.lookup(responseId);

    expect(original).toMatchObject({
      responseId,
      lastAccessAt: now,
      expiresAt: now + 7 * DAY_MS,
    });

    now += 6 * DAY_MS;
    expect(store.touch(responseId)).toBe(true);
    expect(store.lookup(responseId)).toMatchObject({
      lastAccessAt: now,
      expiresAt: now + 7 * DAY_MS,
    });
  });

  it("uses the configured response TTL", () => {
    const store = open(databasePath(), {
      responseTtlMs: 1_234,
      turnLeaseMs: TURN_LEASE_MS,
      toolLeaseMs: 15 * 60 * 1_000,
    });
    const responseId = completeResponse(
      store,
      { threadId: "thr_custom_ttl", stored: true, processGeneration: 1 },
      "turn_custom_ttl",
    );

    expect(store.lookup(responseId)?.expiresAt).toBe(now + 1_234);
  });

  it("makes store=false responses non-resumable as soon as they complete", () => {
    const store = open();
    const responseId = completeResponse(
      store,
      { threadId: "thr_disposable", stored: false, processGeneration: 1 },
      "turn_disposable",
    );

    expect(store.lookup(responseId)).toBeUndefined();
    expect(store.decide(responseId, "req-later")).toEqual({
      type: "not_found",
    });
    expect(store.deletableLeafThreads()).toEqual(["thr_disposable"]);
  });

  it("does not expose a pending response after its deadline", () => {
    const store = open();
    const responseId = store.createPending({
      threadId: "thr_pending_lookup",
      stored: true,
      processGeneration: 1,
    });

    now += 7 * DAY_MS;

    expect(store.lookup(responseId)).toBeUndefined();
  });

  it("returns not_found instead of busy for a pending response after its deadline", () => {
    const store = open();
    const responseId = store.createPending({
      threadId: "thr_pending_decide",
      stored: true,
      processGeneration: 1,
    });

    now += 7 * DAY_MS;

    expect(store.decide(responseId, "req-after-deadline")).toEqual({
      type: "not_found",
    });
  });

  it("rolls back lineage when creating a response fails", () => {
    const path = databasePath();
    const store = open(path);

    expect(() =>
      store.createPending({
        threadId: "thr_orphan",
        parentResponseId: "resp_missing",
        stored: true,
        processGeneration: 1,
      }),
    ).toThrow();
    close(store);

    const database = new DatabaseSync(path);
    expect(
      database
        .prepare("SELECT thread_id FROM thread_lineage WHERE thread_id = ?")
        .get("thr_orphan"),
    ).toBeUndefined();
    database.close();
  });

  it("recovers stale leases without allowing two stores to acquire one live lease", () => {
    const path = databasePath();
    const first = open(path);
    const second = open(path);

    expect(first.acquireLease("thr_lease", "req-1", "turn", 1)).toBe(true);
    expect(second.acquireLease("thr_lease", "req-2", "turn", 1)).toBe(false);

    now += TURN_LEASE_MS;
    expect(second.acquireLease("thr_lease", "req-2", "turn", 1)).toBe(true);
    expect(first.releaseLease("thr_lease", "req-1")).toBe(false);
    expect(second.releaseLease("thr_lease", "req-2")).toBe(true);
  });

  it("uses distinct configured durations for turn and tool leases", () => {
    const path = databasePath();
    const options = { responseTtlMs: 700, turnLeaseMs: 100, toolLeaseMs: 300 };
    const first = open(path, options);
    const second = open(path, options);

    expect(first.acquireLease("thr_turn", "req-turn-1", "turn", 1)).toBe(true);
    expect(first.acquireLease("thr_tool", "req-tool-1", "tool", 1)).toBe(true);

    now += 100;
    expect(second.acquireLease("thr_turn", "req-turn-2", "turn", 1)).toBe(true);
    expect(second.acquireLease("thr_tool", "req-tool-2", "tool", 1)).toBe(
      false,
    );

    now += 200;
    expect(second.acquireLease("thr_tool", "req-tool-2", "tool", 1)).toBe(true);
  });

  it.each([
    ["responseTtlMs", { responseTtlMs: 0, turnLeaseMs: 1, toolLeaseMs: 1 }],
    ["turnLeaseMs", { responseTtlMs: 1, turnLeaseMs: 0, toolLeaseMs: 1 }],
    ["toolLeaseMs", { responseTtlMs: 1, turnLeaseMs: 1, toolLeaseMs: 1.5 }],
  ] as const)("rejects an invalid %s", (name, options) => {
    expect(() =>
      ConversationStore.open(databasePath(), clock, options),
    ).toThrow(`${name} must be a positive integer`);
  });

  it("returns lost for pending continuations from another process generation", () => {
    const store = open();
    const responseId = store.createPending({
      threadId: "thr_tool",
      stored: true,
      processGeneration: 3,
    });
    expect(store.acquireLease("thr_tool", "req-tool", "tool", 3)).toBe(true);

    expect(store.markContinuationLost(4)).toBe(1);
    expect(store.decide(responseId, "req-after-restart")).toEqual({
      type: "lost",
    });
  });

  it("marks mappings expired before returning physical deletion candidates", () => {
    const path = databasePath();
    const store = open(path);
    const responseId = completeResponse(
      store,
      { threadId: "thr_expired", stored: true, processGeneration: 1 },
      "turn_expired",
    );

    now += 7 * DAY_MS;
    expect(store.deletableLeafThreads()).toEqual(["thr_expired"]);
    expect(store.lookup(responseId)).toBeUndefined();
    close(store);

    const database = new DatabaseSync(path);
    expect(
      database
        .prepare("SELECT state FROM responses WHERE response_id = ?")
        .get(responseId),
    ).toEqual({ state: "expired" });
    database.close();
  });

  it("keeps an expired ancestor until its live descendant expires, then orders deletion leaf-first", () => {
    const store = open();
    const rootId = completeResponse(
      store,
      { threadId: "thr_root", stored: true, processGeneration: 1 },
      "turn_root",
    );
    const childId = completeResponse(
      store,
      {
        threadId: "thr_child",
        parentResponseId: rootId,
        parentThreadId: "thr_root",
        forkedAtTurnId: "turn_root",
        stored: true,
        processGeneration: 1,
      },
      "turn_child",
    );

    now += 6 * DAY_MS;
    expect(store.touch(childId)).toBe(true);
    now += 2 * DAY_MS;
    expect(store.expire()).toBe(1);
    expect(store.lookup(rootId)).toBeUndefined();
    expect(store.lookup(childId)).toBeDefined();
    expect(store.deletableLeafThreads()).toEqual([]);

    now += 5 * DAY_MS;
    expect(store.deletableLeafThreads()).toEqual(["thr_child", "thr_root"]);
  });

  it("atomically acquires a lease as part of continuation decisions", () => {
    const path = databasePath();
    const first = open(path);
    const responseId = completeResponse(
      first,
      { threadId: "thr_atomic", stored: true, processGeneration: 9 },
      "turn_atomic",
    );
    const second = open(path);

    expect(first.decide(responseId, "req-first")).toMatchObject({
      type: "resume",
      threadId: "thr_atomic",
    });
    expect(second.decide(responseId, "req-second")).toEqual({
      type: "busy",
    });
  });

  it("durably reserves start operations before a thread exists and recovers them after restart", () => {
    const path = databasePath();
    const first = open(path);

    expect(
      first.reserveOperation({
        responseId: "resp_start_operation",
        ownerRequestId: "req-start",
        stored: true,
        processGeneration: 1,
      }),
    ).toEqual({ type: "start" });
    expect(first.lookupOperation("resp_start_operation")).toMatchObject({
      action: "start",
      state: "active",
      stored: true,
    });
    close(first);

    const restarted = open(path);
    expect(restarted.lookupOperation("resp_start_operation")).toBeDefined();
    restarted.markContinuationLost(2);
    expect(restarted.lookupOperation("resp_start_operation")).toBeUndefined();
  });

  it("recovers stale operations when a restarted process reuses the same generation number", () => {
    const path = databasePath();
    const first = open(path);
    first.reserveOperation({
      responseId: "resp_same_generation",
      ownerRequestId: "req-same-generation",
      stored: true,
      processGeneration: 1,
    });
    close(first);

    const restarted = open(path);
    restarted.markContinuationLost(1);

    expect(restarted.lookupOperation("resp_same_generation")).toBeUndefined();
  });

  it("atomically reserves resume operations with the source lease and recovers without deleting the source", () => {
    const path = databasePath();
    const first = open(path);
    const sourceId = completeResponse(
      first,
      { threadId: "thr_resume_source", stored: true, processGeneration: 1 },
      "turn_resume_source",
    );

    expect(
      first.reserveOperation({
        responseId: "resp_resume_operation",
        previousResponseId: sourceId,
        ownerRequestId: "req-resume",
        stored: true,
        processGeneration: 1,
      }),
    ).toEqual({
      type: "resume",
      responseId: sourceId,
      threadId: "thr_resume_source",
      lastTurnId: "turn_resume_source",
    });
    expect(
      open(path).reserveOperation({
        responseId: "resp_competing_operation",
        previousResponseId: sourceId,
        ownerRequestId: "req-competing",
        stored: true,
        processGeneration: 1,
      }),
    ).toEqual({ type: "busy" });
    close(first);

    const restarted = open(path);
    restarted.markContinuationLost(2);
    expect(restarted.lookupOperation("resp_resume_operation")).toBeUndefined();
    expect(restarted.lookup(sourceId)).toMatchObject({
      threadId: "thr_resume_source",
      state: "complete",
    });
    expect(
      restarted.reserveOperation({
        responseId: "resp_after_restart",
        previousResponseId: sourceId,
        ownerRequestId: "req-after-restart",
        stored: true,
        processGeneration: 2,
      }),
    ).toMatchObject({ type: "resume" });
  });

  it("forces disposable continuations to fork inclusively and retains attached forks for crash cleanup", () => {
    const path = databasePath();
    const first = open(path);
    const sourceId = completeResponse(
      first,
      { threadId: "thr_fork_source", stored: true, processGeneration: 1 },
      "turn_fork_source",
    );

    expect(
      first.reserveOperation({
        responseId: "resp_disposable_fork",
        previousResponseId: sourceId,
        ownerRequestId: "req-disposable",
        stored: false,
        processGeneration: 1,
      }),
    ).toEqual({
      type: "fork",
      responseId: sourceId,
      threadId: "thr_fork_source",
      lastTurnId: "turn_fork_source",
    });
    first.attachOperation("resp_disposable_fork", "thr_disposable_fork");
    close(first);

    const restarted = open(path);
    restarted.markContinuationLost(2);
    expect(restarted.lookup(sourceId)).toBeDefined();
    expect(restarted.lookupOperation("resp_disposable_fork")).toMatchObject({
      state: "abandoned",
      threadId: "thr_disposable_fork",
    });
    expect(restarted.abandonedThreads()).toEqual(["thr_disposable_fork"]);
    expect(restarted.finishAbandonedThread("thr_disposable_fork")).toBe(true);
    expect(restarted.lookupOperation("resp_disposable_fork")).toBeUndefined();
  });

  it("attaches thread and turn identities before completing a stored operation", () => {
    const store = open();
    expect(
      store.reserveOperation({
        responseId: "resp_attached",
        ownerRequestId: "req-attached",
        stored: true,
        processGeneration: 1,
      }),
    ).toEqual({ type: "start" });

    store.attachOperation("resp_attached", "thr_attached");
    store.attachOperationTurn("resp_attached", "turn_attached");
    expect(store.lookupOperation("resp_attached")).toMatchObject({
      threadId: "thr_attached",
      turnId: "turn_attached",
      state: "active",
    });
    store.completeOperation("resp_attached");

    expect(store.lookupOperation("resp_attached")).toBeUndefined();
    expect(store.lookup("resp_attached")).toMatchObject({
      threadId: "thr_attached",
      turnId: "turn_attached",
      state: "complete",
    });
  });

  it("does not delete an expired thread while its own lease is live", () => {
    const store = open(databasePath(), {
      responseTtlMs: 100,
      turnLeaseMs: 300,
      toolLeaseMs: 300,
    });
    completeResponse(
      store,
      { threadId: "thr_leased_expired", stored: true, processGeneration: 1 },
      "turn_leased_expired",
    );
    expect(
      store.acquireLease("thr_leased_expired", "req-live", "turn", 1),
    ).toBe(true);

    now += 100;
    expect(store.deletableLeafThreads()).toEqual([]);
    now += 200;
    expect(store.deletableLeafThreads()).toEqual(["thr_leased_expired"]);
  });

  it("does not delete an expired ancestor while a descendant lease is live", () => {
    const store = open(databasePath(), {
      responseTtlMs: 100,
      turnLeaseMs: 300,
      toolLeaseMs: 300,
    });
    const rootId = completeResponse(
      store,
      { threadId: "thr_leased_root", stored: true, processGeneration: 1 },
      "turn_leased_root",
    );
    completeResponse(
      store,
      {
        threadId: "thr_leased_child",
        parentResponseId: rootId,
        parentThreadId: "thr_leased_root",
        forkedAtTurnId: "turn_leased_root",
        stored: true,
        processGeneration: 1,
      },
      "turn_leased_child",
    );
    expect(store.acquireLease("thr_leased_child", "req-child", "turn", 1)).toBe(
      true,
    );

    now += 100;
    expect(store.deletableLeafThreads()).toEqual([]);
    now += 200;
    expect(store.deletableLeafThreads()).toEqual([
      "thr_leased_child",
      "thr_leased_root",
    ]);
  });
});

describe("conversation migrations", () => {
  it("uses the clock as an object when recording migration timestamps", () => {
    const path = databasePath();
    const contextualClock = {
      current: 42,
      now() {
        return this.current;
      },
    };

    const store = ConversationStore.open(path, contextualClock, LEASE_OPTIONS);
    store.close();

    const database = new DatabaseSync(path);
    expect(
      database
        .prepare(
          "SELECT applied_at FROM schema_migrations ORDER BY version LIMIT 1",
        )
        .get(),
    ).toEqual({ applied_at: 42 });
    database.close();
  });

  it("additively migrates the immediately previous fixture without changing its readable data", () => {
    const path = databasePath();
    const database = new DatabaseSync(path);
    database.exec(`
      PRAGMA foreign_keys = ON;
      CREATE TABLE schema_migrations (
        version INTEGER PRIMARY KEY,
        applied_at INTEGER NOT NULL
      );
      CREATE TABLE responses (
        response_id TEXT PRIMARY KEY,
        thread_id TEXT NOT NULL,
        turn_id TEXT,
        parent_response_id TEXT REFERENCES responses(response_id),
        root_response_id TEXT NOT NULL,
        state TEXT NOT NULL CHECK (state IN ('pending','complete','lost','expired')),
        stored INTEGER NOT NULL CHECK (stored IN (0,1)),
        process_generation INTEGER NOT NULL,
        created_at INTEGER NOT NULL,
        last_access_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL
      );
      INSERT INTO schema_migrations(version, applied_at) VALUES (1, 1000);
      INSERT INTO responses(
        response_id, thread_id, turn_id, parent_response_id, root_response_id,
        state, stored, process_generation, created_at, last_access_at, expires_at
      ) VALUES (
        'resp_fixture', 'thr_fixture', 'turn_fixture', NULL, 'resp_fixture',
        'complete', 1, 7, 1000, 1000, 2000
      );
    `);
    database.close();

    const store = open(path);
    close(store);

    const previousApplication = openPreviousReader(path, 1);
    expect(
      previousApplication
        .prepare(`
          SELECT response_id, thread_id, turn_id, state, stored,
                 process_generation, created_at, last_access_at, expires_at
          FROM responses
          WHERE response_id = 'resp_fixture'
        `)
        .get(),
    ).toEqual({
      response_id: "resp_fixture",
      thread_id: "thr_fixture",
      turn_id: "turn_fixture",
      state: "complete",
      stored: 1,
      process_generation: 7,
      created_at: 1000,
      last_access_at: 1000,
      expires_at: 2000,
    });
    expect(
      previousApplication
        .prepare("SELECT version FROM schema_migrations ORDER BY version")
        .all(),
    ).toEqual([{ version: 1 }, { version: 2 }, { version: 3 }]);
    expect(
      previousApplication
        .prepare(
          "SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('thread_lineage', 'thread_leases') ORDER BY name",
        )
        .all(),
    ).toEqual([{ name: "thread_leases" }, { name: "thread_lineage" }]);
    previousApplication.close();
  });

  it("lets the previous reader open a database after a future additive migration", () => {
    const path = databasePath();
    const store = open(path);
    completeResponse(
      store,
      { threadId: "thr_future", stored: true, processGeneration: 1 },
      "turn_future",
    );
    close(store);

    const futureApplication = new DatabaseSync(path);
    futureApplication.exec(`
      BEGIN IMMEDIATE;
      CREATE TABLE future_additive_data (
        id INTEGER PRIMARY KEY,
        value TEXT NOT NULL
      );
      INSERT INTO schema_migrations(version, applied_at) VALUES (4, ${now});
      COMMIT;
    `);
    futureApplication.close();

    const previousApplication = openPreviousReader(path, 2);
    expect(
      previousApplication
        .prepare(
          "SELECT thread_id, turn_id FROM responses WHERE thread_id = 'thr_future'",
        )
        .get(),
    ).toEqual({ thread_id: "thr_future", turn_id: "turn_future" });
    previousApplication.close();
  });

  it("lets the version-two reader reopen a database after the additive operations migration", () => {
    const path = databasePath();
    const store = open(path);
    close(store);

    const previousApplication = openPreviousReader(path, 2);
    expect(
      previousApplication
        .prepare("SELECT version FROM schema_migrations ORDER BY version")
        .all(),
    ).toEqual([{ version: 1 }, { version: 2 }, { version: 3 }]);
    expect(
      previousApplication
        .prepare(
          "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'response_operations'",
        )
        .get(),
    ).toEqual({ name: "response_operations" });
    previousApplication.close();
  });

  it("rejects a newer migration row when the known schema is corrupt", () => {
    const path = databasePath();
    const database = new DatabaseSync(path);
    database.exec(`
      CREATE TABLE schema_migrations (
        version INTEGER PRIMARY KEY,
        applied_at INTEGER NOT NULL
      );
      INSERT INTO schema_migrations(version, applied_at) VALUES
        (1, ${now}),
        (2, ${now}),
        (3, ${now});
    `);
    database.close();

    expect(() => openPreviousReader(path, 2)).toThrow(
      "Conversation database is incompatible: missing table responses",
    );
  });
});

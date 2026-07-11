import type { DatabaseSync } from "node:sqlite";

interface Migration {
  version: number;
  sql: string;
}

const MIGRATIONS: Migration[] = [
  {
    version: 1,
    sql: `
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
    `,
  },
  {
    version: 2,
    sql: `
      CREATE INDEX responses_thread_idx ON responses(thread_id, created_at);
      CREATE INDEX responses_expiry_idx ON responses(state, expires_at);
      CREATE TABLE thread_lineage (
        thread_id TEXT PRIMARY KEY,
        parent_thread_id TEXT REFERENCES thread_lineage(thread_id),
        forked_at_turn_id TEXT
      );
      CREATE TABLE thread_leases (
        thread_id TEXT PRIMARY KEY,
        owner_request_id TEXT NOT NULL,
        kind TEXT NOT NULL CHECK (kind IN ('turn','tool')),
        process_generation INTEGER NOT NULL,
        expires_at INTEGER NOT NULL
      );
    `,
  },
];

interface VersionRow {
  version: number;
}

export function migrateConversations(
  database: DatabaseSync,
  appliedAt: () => number,
): void {
  const hasMigrations = database
    .prepare(
      "SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = 'schema_migrations'",
    )
    .get();
  const currentVersion = hasMigrations
    ? ((
        database
          .prepare(
            "SELECT COALESCE(MAX(version), 0) AS version FROM schema_migrations",
          )
          .get() as unknown as VersionRow
      ).version ?? 0)
    : 0;
  const latestVersion = MIGRATIONS.at(-1)?.version ?? 0;
  if (currentVersion > latestVersion) {
    throw new Error(
      `Conversation database version ${currentVersion} is newer than supported version ${latestVersion}`,
    );
  }

  for (const migration of MIGRATIONS) {
    if (migration.version <= currentVersion) continue;
    database.exec("BEGIN IMMEDIATE");
    try {
      database.exec(migration.sql);
      database
        .prepare(
          "INSERT INTO schema_migrations(version, applied_at) VALUES (?, ?)",
        )
        .run(migration.version, appliedAt());
      database.exec("COMMIT");
    } catch (error) {
      database.exec("ROLLBACK");
      throw error;
    }
  }
}

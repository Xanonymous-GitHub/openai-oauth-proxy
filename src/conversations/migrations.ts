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
  {
    version: 3,
    sql: `
      CREATE TABLE response_operations (
        response_id TEXT PRIMARY KEY,
        owner_request_id TEXT NOT NULL,
        action TEXT NOT NULL CHECK (action IN ('start','resume','fork')),
        state TEXT NOT NULL CHECK (state IN ('active','abandoned')),
        stored INTEGER NOT NULL CHECK (stored IN (0,1)),
        parent_response_id TEXT REFERENCES responses(response_id),
        source_thread_id TEXT,
        source_turn_id TEXT,
        thread_id TEXT,
        turn_id TEXT,
        process_generation INTEGER NOT NULL,
        created_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL
      );
      CREATE INDEX response_operations_source_idx
        ON response_operations(source_thread_id, state);
      CREATE INDEX response_operations_cleanup_idx
        ON response_operations(state, thread_id);
    `,
  },
  {
    version: 4,
    sql: `
      ALTER TABLE response_operations ADD COLUMN operation_cwd TEXT;
      ALTER TABLE response_operations ADD COLUMN recovery_pending INTEGER NOT NULL DEFAULT 0 CHECK (recovery_pending IN (0,1));
      CREATE INDEX response_operations_recovery_idx
        ON response_operations(recovery_pending, state);
    `,
  },
];

interface VersionRow {
  version: number;
}

interface ColumnRow {
  name: string;
}

const REQUIRED_COLUMNS = [
  {
    version: 1,
    tables: {
      schema_migrations: ["version", "applied_at"],
      responses: [
        "response_id",
        "thread_id",
        "turn_id",
        "parent_response_id",
        "root_response_id",
        "state",
        "stored",
        "process_generation",
        "created_at",
        "last_access_at",
        "expires_at",
      ],
    },
  },
  {
    version: 2,
    tables: {
      thread_lineage: ["thread_id", "parent_thread_id", "forked_at_turn_id"],
      thread_leases: [
        "thread_id",
        "owner_request_id",
        "kind",
        "process_generation",
        "expires_at",
      ],
    },
  },
  {
    version: 3,
    tables: {
      response_operations: [
        "response_id",
        "owner_request_id",
        "action",
        "state",
        "stored",
        "parent_response_id",
        "source_thread_id",
        "source_turn_id",
        "thread_id",
        "turn_id",
        "process_generation",
        "created_at",
        "expires_at",
      ],
    },
  },
  {
    version: 4,
    tables: {
      response_operations: ["operation_cwd", "recovery_pending"],
    },
  },
] as const;

export function migrateConversations(
  database: DatabaseSync,
  appliedAt: () => number,
  supportedVersion = MIGRATIONS.at(-1)?.version ?? 0,
): void {
  if (!MIGRATIONS.some((migration) => migration.version === supportedVersion)) {
    throw new Error(
      `Unsupported conversation schema version ${supportedVersion}`,
    );
  }
  const hasMigrations = database
    .prepare(
      "SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = 'schema_migrations'",
    )
    .get();
  if (hasMigrations) {
    assertTable(database, "schema_migrations", ["version", "applied_at"]);
  }
  const appliedVersions = new Set(
    hasMigrations
      ? (
          database
            .prepare("SELECT version FROM schema_migrations")
            .all() as unknown as VersionRow[]
        ).map((row) => row.version)
      : [],
  );

  for (const migration of MIGRATIONS) {
    if (
      migration.version > supportedVersion ||
      appliedVersions.has(migration.version)
    ) {
      continue;
    }
    if (migration.version === 1 && hasMigrations) {
      throw new Error(
        "Conversation database is incompatible: missing migration 1",
      );
    }
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

  for (const requirement of REQUIRED_COLUMNS) {
    if (requirement.version > supportedVersion) continue;
    for (const [table, columns] of Object.entries(requirement.tables)) {
      assertTable(database, table, columns);
    }
  }
}

function assertTable(
  database: DatabaseSync,
  table: string,
  requiredColumns: readonly string[],
): void {
  const exists = database
    .prepare(
      "SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = ?",
    )
    .get(table);
  if (!exists) {
    throw new Error(
      `Conversation database is incompatible: missing table ${table}`,
    );
  }
  const columns = new Set(
    (
      database
        .prepare(`PRAGMA table_info(${table})`)
        .all() as unknown as ColumnRow[]
    ).map((row) => row.name),
  );
  for (const column of requiredColumns) {
    if (!columns.has(column)) {
      throw new Error(
        `Conversation database is incompatible: missing column ${table}.${column}`,
      );
    }
  }
}

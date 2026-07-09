import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

export function resolveDataDir(): string {
  return process.env.LOCAL_ISSUES_DATA_DIR ?? join(projectRoot, "data");
}

export function openDatabase(dataDir = resolveDataDir()): Database.Database {
  mkdirSync(dataDir, { recursive: true });
  const db = new Database(join(dataDir, "issues.db"));
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  migrate(db);
  return db;
}

function migrate(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS issues (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      title TEXT NOT NULL,
      body TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'open' CHECK(status IN ('open', 'in_progress', 'closed')),
      labels TEXT NOT NULL DEFAULT '[]',
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS config (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS webhook_deliveries (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      issue_id INTEGER NOT NULL,
      url TEXT NOT NULL,
      payload TEXT NOT NULL,
      status_code INTEGER,
      response_body TEXT,
      success INTEGER NOT NULL,
      attempts INTEGER NOT NULL DEFAULT 1,
      error TEXT,
      created_at INTEGER NOT NULL,
      FOREIGN KEY (issue_id) REFERENCES issues(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_issues_status ON issues(status);
    CREATE INDEX IF NOT EXISTS idx_deliveries_issue ON webhook_deliveries(issue_id);

    CREATE TABLE IF NOT EXISTS comments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      issue_id INTEGER NOT NULL,
      author TEXT NOT NULL DEFAULT 'system',
      source TEXT NOT NULL DEFAULT 'system',
      body TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      FOREIGN KEY (issue_id) REFERENCES issues(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_comments_issue ON comments(issue_id);
  `);

  migrateIssuesStatusConstraint(db);
}

/** Existing DBs may still CHECK only open|closed; recreate table if needed. */
function migrateIssuesStatusConstraint(db: Database.Database): void {
  const table = db
    .prepare(`SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'issues'`)
    .get() as { sql: string } | undefined;
  if (!table?.sql || table.sql.includes("'in_progress'")) return;

  db.exec(`
    PRAGMA foreign_keys = OFF;

    CREATE TABLE issues_new (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      title TEXT NOT NULL,
      body TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'open' CHECK(status IN ('open', 'in_progress', 'closed')),
      labels TEXT NOT NULL DEFAULT '[]',
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );

    INSERT INTO issues_new (id, title, body, status, labels, created_at, updated_at)
    SELECT id, title, body, status, labels, created_at, updated_at FROM issues;

    DROP TABLE issues;
    ALTER TABLE issues_new RENAME TO issues;
    CREATE INDEX IF NOT EXISTS idx_issues_status ON issues(status);

    PRAGMA foreign_keys = ON;
  `);
}

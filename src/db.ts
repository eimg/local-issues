import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

export function resolveDataDir(): string {
  return process.env.ACME_ISSUES_DATA_DIR ?? process.env.LOCAL_ISSUES_DATA_DIR ?? join(projectRoot, "data");
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

    CREATE TABLE IF NOT EXISTS helix_runs (
      run_id TEXT PRIMARY KEY,
      issue_id INTEGER NOT NULL,
      parent_run_id TEXT,
      root_run_id TEXT NOT NULL,
      status TEXT NOT NULL,
      trigger TEXT,
      started_at INTEGER NOT NULL,
      finished_at INTEGER,
      updated_at INTEGER NOT NULL,
      FOREIGN KEY (issue_id) REFERENCES issues(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_helix_runs_issue ON helix_runs(issue_id, finished_at DESC);

    CREATE TABLE IF NOT EXISTS pull_requests (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      issue_id INTEGER,
      title TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      repository_path TEXT NOT NULL,
      base_branch TEXT NOT NULL,
      base_sha TEXT NOT NULL,
      head_branch TEXT NOT NULL,
      head_sha TEXT NOT NULL,
      author TEXT NOT NULL DEFAULT 'unknown',
      origin TEXT NOT NULL CHECK(origin IN ('helix', 'external')),
      status TEXT NOT NULL DEFAULT 'draft'
        CHECK(status IN ('draft', 'reviewing', 'changes_requested', 'blocked', 'ready_to_merge', 'merged', 'closed')),
      active_review_run_id TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      merged_at INTEGER,
      merge_commit_sha TEXT,
      FOREIGN KEY (issue_id) REFERENCES issues(id) ON DELETE SET NULL
    );

    CREATE INDEX IF NOT EXISTS idx_pull_requests_status ON pull_requests(status, updated_at DESC);
    CREATE INDEX IF NOT EXISTS idx_pull_requests_issue ON pull_requests(issue_id, updated_at DESC);

    CREATE TABLE IF NOT EXISTS pull_request_reviews (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      pull_request_id INTEGER NOT NULL,
      review_run_id TEXT NOT NULL UNIQUE,
      head_sha TEXT NOT NULL,
      status TEXT NOT NULL CHECK(status IN ('running', 'completed', 'error')),
      decision TEXT CHECK(decision IN ('ready_to_merge', 'changes_requested', 'blocked')),
      summary TEXT NOT NULL DEFAULT '',
      findings_json TEXT NOT NULL DEFAULT '[]',
      checks_json TEXT NOT NULL DEFAULT '[]',
      started_at INTEGER NOT NULL,
      finished_at INTEGER,
      FOREIGN KEY (pull_request_id) REFERENCES pull_requests(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_pull_request_reviews_pr
      ON pull_request_reviews(pull_request_id, started_at DESC);
  `);

  migrateIssuesStatusConstraint(db);
  migrateHelixRunsTrigger(db);
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

function migrateHelixRunsTrigger(db: Database.Database): void {
  const columns = db.prepare(`PRAGMA table_info(helix_runs)`).all() as Array<{ name: string }>;
  if (columns.some((column) => column.name === "trigger")) return;
  db.exec(`ALTER TABLE helix_runs ADD COLUMN trigger TEXT`);
}

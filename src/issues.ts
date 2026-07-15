import type Database from "better-sqlite3";
import type {
  AppConfig,
  Issue,
  IssueInput,
  IssueListQuery,
  IssueListResult,
  IssueStatus,
  IssueUpdate,
} from "./types.js";

interface IssueRow {
  id: number;
  title: string;
  body: string;
  status: IssueStatus;
  labels: string;
  created_at: number;
  updated_at: number;
}

function parseLabels(raw: string): string[] {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((l): l is string => typeof l === "string");
  } catch {
    return [];
  }
}

function normalizeLabels(labels: string[] | undefined): string[] {
  if (!labels) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const label of labels) {
    const trimmed = label.trim();
    if (!trimmed || seen.has(trimmed)) continue;
    seen.add(trimmed);
    out.push(trimmed);
  }
  return out;
}

function toIssue(row: IssueRow, baseUrl: string): Issue {
  return {
    id: row.id,
    title: row.title,
    body: row.body,
    status: row.status,
    labels: parseLabels(row.labels),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    url: `${baseUrl}/issues/${row.id}`,
  };
}

const DEFAULT_PAGE_LIMIT = 25;
const MAX_PAGE_LIMIT = 100;

export function listIssues(
  db: Database.Database,
  baseUrl: string,
  query: IssueListQuery = {}
): IssueListResult {
  const limit = clampLimit(query.limit);
  const offset = Math.max(0, Number.isFinite(query.offset) ? Number(query.offset) : 0);
  const status = query.status;
  const label = query.label?.trim() || undefined;

  const where: string[] = [];
  const params: unknown[] = [];

  if (status) {
    where.push("status = ?");
    params.push(status);
  }
  if (label) {
    where.push(`EXISTS (
      SELECT 1 FROM json_each(issues.labels) AS jl
      WHERE jl.value = ?
    )`);
    params.push(label);
  }

  const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";
  const total = (
    db.prepare(`SELECT COUNT(*) AS count FROM issues ${whereSql}`).get(...params) as {
      count: number;
    }
  ).count;

  const rows = db
    .prepare(
      `SELECT * FROM issues
       ${whereSql}
       ORDER BY id DESC
       LIMIT ? OFFSET ?`
    )
    .all(...params, limit, offset) as IssueRow[];

  return {
    items: rows.map((row) => toIssue(row, baseUrl)),
    total,
    limit,
    offset,
  };
}

function clampLimit(value: unknown): number {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_PAGE_LIMIT;
  return Math.min(Math.floor(n), MAX_PAGE_LIMIT);
}

export function getIssue(db: Database.Database, baseUrl: string, id: number): Issue | null {
  const row = db.prepare("SELECT * FROM issues WHERE id = ?").get(id) as IssueRow | undefined;
  return row ? toIssue(row, baseUrl) : null;
}

export function createIssue(db: Database.Database, baseUrl: string, input: IssueInput): Issue {
  const now = Date.now();
  const labels = normalizeLabels(input.labels);
  const result = db
    .prepare(
      `INSERT INTO issues (title, body, status, labels, created_at, updated_at)
       VALUES (@title, @body, @status, @labels, @now, @now)`
    )
    .run({
      title: input.title.trim(),
      body: input.body?.trim() ?? "",
      status: input.status ?? "open",
      labels: JSON.stringify(labels),
      now,
    });

  return getIssue(db, baseUrl, Number(result.lastInsertRowid))!;
}

export function updateIssue(
  db: Database.Database,
  baseUrl: string,
  id: number,
  patch: IssueUpdate
): Issue | null {
  const existing = getIssue(db, baseUrl, id);
  if (!existing) return null;

  const title = patch.title !== undefined ? patch.title.trim() : existing.title;
  const body = patch.body !== undefined ? patch.body.trim() : existing.body;
  const status = patch.status ?? existing.status;
  const labels = patch.labels !== undefined ? normalizeLabels(patch.labels) : existing.labels;
  const now = Date.now();

  db.prepare(
    `UPDATE issues
     SET title = @title, body = @body, status = @status, labels = @labels, updated_at = @now
     WHERE id = @id`
  ).run({
    id,
    title,
    body,
    status,
    labels: JSON.stringify(labels),
    now,
  });

  return getIssue(db, baseUrl, id);
}

export function deleteIssue(db: Database.Database, id: number): boolean {
  const result = db.prepare("DELETE FROM issues WHERE id = ?").run(id);
  return result.changes > 0;
}

export function issueMatchesFilter(issue: Issue, labelFilter: string): boolean {
  return issue.status === "open" && issue.labels.includes(labelFilter);
}

export function labelWasAdded(oldLabels: string[], newLabels: string[], label: string): boolean {
  return !oldLabels.includes(label) && newLabels.includes(label);
}

export function issueToWebhookPayload(issue: Issue, trackerUrl: string): { title: string; body: string; labels: string[]; external: { trackerUrl: string; issueId: number } } {
  return {
    title: issue.title,
    body: issue.body,
    labels: issue.labels,
    external: {
      trackerUrl: trackerUrl.replace(/\/$/, ""),
      issueId: issue.id,
    },
  };
}

export function listDeliveries(db: Database.Database, limit = 50): import("./types.js").WebhookDelivery[] {
  const rows = db
    .prepare(
      `SELECT id, issue_id, url, payload, status_code, response_body, success, attempts, error, created_at
       FROM webhook_deliveries
       ORDER BY id DESC
       LIMIT ?`
    )
    .all(limit) as {
    id: number;
    issue_id: number;
    url: string;
    payload: string;
    status_code: number | null;
    response_body: string | null;
    success: number;
    attempts: number;
    error: string | null;
    created_at: number;
  }[];

  return rows.map((row) => ({
    id: row.id,
    issueId: row.issue_id,
    url: row.url,
    payload: JSON.parse(row.payload) as import("./types.js").OutboundWebhookPayload,
    statusCode: row.status_code,
    responseBody: row.response_body,
    success: row.success === 1,
    attempts: row.attempts,
    error: row.error,
    createdAt: row.created_at,
  }));
}

export function deleteDelivery(db: Database.Database, id: number): boolean {
  const result = db.prepare("DELETE FROM webhook_deliveries WHERE id = ?").run(id);
  return result.changes > 0;
}

export function clearDeliveries(db: Database.Database): number {
  const result = db.prepare("DELETE FROM webhook_deliveries").run();
  return result.changes;
}

export function recordDelivery(
  db: Database.Database,
  entry: {
    issueId: number;
    url: string;
    payload: import("./types.js").OutboundWebhookPayload;
    statusCode: number | null;
    responseBody: string | null;
    success: boolean;
    attempts: number;
    error: string | null;
  }
): import("./types.js").WebhookDelivery {
  const now = Date.now();
  const result = db
    .prepare(
      `INSERT INTO webhook_deliveries
       (issue_id, url, payload, status_code, response_body, success, attempts, error, created_at)
       VALUES (@issueId, @url, @payload, @statusCode, @responseBody, @success, @attempts, @error, @now)`
    )
    .run({
      issueId: entry.issueId,
      url: entry.url,
      payload: JSON.stringify(entry.payload),
      statusCode: entry.statusCode,
      responseBody: entry.responseBody,
      success: entry.success ? 1 : 0,
      attempts: entry.attempts,
      error: entry.error,
      now,
    });

  const id = Number(result.lastInsertRowid);
  const deliveries = listDeliveries(db, 1);
  return deliveries.find((d) => d.id === id) ?? {
    id,
    issueId: entry.issueId,
    url: entry.url,
    payload: entry.payload,
    statusCode: entry.statusCode,
    responseBody: entry.responseBody,
    success: entry.success,
    attempts: entry.attempts,
    error: entry.error,
    createdAt: now,
  };
}

export type { AppConfig };

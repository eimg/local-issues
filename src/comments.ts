import type Database from "better-sqlite3";
import type {
  CommentInput,
  CommentSource,
  CommentUpdate,
  HelixRunPayload,
  IssueComment,
} from "./types.js";

interface CommentRow {
  id: number;
  issue_id: number;
  author: string;
  source: string;
  body: string;
  created_at: number;
}

const COMMENT_SELECT =
  "SELECT id, issue_id, author, source, body, created_at FROM comments WHERE id = ?";

function toComment(row: CommentRow): IssueComment {
  return {
    id: row.id,
    issueId: row.issue_id,
    author: row.author,
    source: row.source as CommentSource,
    body: row.body,
    createdAt: row.created_at,
  };
}

export function listComments(db: Database.Database, issueId: number): IssueComment[] {
  const rows = db
    .prepare(
      `SELECT id, issue_id, author, source, body, created_at
       FROM comments
       WHERE issue_id = ?
       ORDER BY created_at ASC, id ASC`
    )
    .all(issueId) as CommentRow[];
  return rows.map(toComment);
}

export function getComment(db: Database.Database, commentId: number): IssueComment | null {
  const row = db.prepare(COMMENT_SELECT).get(commentId) as CommentRow | undefined;
  return row ? toComment(row) : null;
}

export function createComment(
  db: Database.Database,
  issueId: number,
  input: CommentInput
): IssueComment {
  const now = Date.now();
  const result = db
    .prepare(
      `INSERT INTO comments (issue_id, author, source, body, created_at)
       VALUES (@issueId, @author, @source, @body, @now)`
    )
    .run({
      issueId,
      author: input.author?.trim() || "system",
      source: input.source ?? "system",
      body: input.body.trim(),
      now,
    });

  return getComment(db, Number(result.lastInsertRowid))!;
}

export function updateComment(
  db: Database.Database,
  commentId: number,
  patch: CommentUpdate
): IssueComment | null {
  const existing = getComment(db, commentId);
  if (!existing) return null;

  const body = patch.body !== undefined ? patch.body.trim() : existing.body;
  const author = patch.author !== undefined ? patch.author.trim() || existing.author : existing.author;

  db.prepare(
    `UPDATE comments
     SET body = @body, author = @author
     WHERE id = @id`
  ).run({
    id: commentId,
    body,
    author,
  });

  return getComment(db, commentId);
}

export function deleteComment(db: Database.Database, commentId: number): boolean {
  const result = db.prepare("DELETE FROM comments WHERE id = ?").run(commentId);
  return result.changes > 0;
}

function shortRunId(runId: string): string {
  return runId.length > 8 ? `${runId.slice(0, 8)}…` : runId;
}

export function formatHelixStartComment(payload: HelixRunPayload): string {
  return [
    "Helix picked up this issue — run in progress.",
    `Run: ${shortRunId(payload.run.id)}`,
  ].join("\n");
}

export function formatHelixCloseComment(payload: HelixRunPayload): string {
  const finished = payload.run.finishedAt
    ? new Date(payload.run.finishedAt).toISOString()
    : "unknown";

  return [
    "Closed automatically — Helix run completed successfully.",
    `Run: ${shortRunId(payload.run.id)}`,
    `Finished: ${finished}`,
  ].join("\n");
}

export function formatHelixPullRequestComment(payload: HelixRunPayload): string {
  const finished = payload.run.finishedAt
    ? new Date(payload.run.finishedAt).toISOString()
    : "unknown";
  return [
    "Implementation completed — a local PR is awaiting independent review.",
    `Run: ${shortRunId(payload.run.id)}`,
    `Finished: ${finished}`,
  ].join("\n");
}

export function addHelixStartComment(
  db: Database.Database,
  issueId: number,
  payload: HelixRunPayload
): IssueComment {
  return createComment(db, issueId, {
    author: "helix",
    source: "helix.webhook",
    body: formatHelixStartComment(payload),
  });
}

export function addHelixCompletionComment(
  db: Database.Database,
  issueId: number,
  payload: HelixRunPayload
): IssueComment {
  return createComment(db, issueId, {
    author: "helix",
    source: "helix.webhook",
    body: formatHelixCloseComment(payload),
  });
}

export function addHelixPullRequestComment(
  db: Database.Database,
  issueId: number,
  payload: HelixRunPayload
): IssueComment {
  return createComment(db, issueId, {
    author: "helix",
    source: "helix.webhook",
    body: formatHelixPullRequestComment(payload),
  });
}

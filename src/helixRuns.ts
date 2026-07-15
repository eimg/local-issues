import type Database from "better-sqlite3";
import type { HelixRunPayload } from "./types.js";

export interface HelixRunRecord {
  runId: string;
  issueId: number;
  parentRunId?: string;
  rootRunId: string;
  status: string;
  startedAt: number;
  finishedAt?: number;
}

export function recordHelixRun(
  db: Database.Database,
  issueId: number,
  payload: HelixRunPayload,
): HelixRunRecord | undefined {
  const runId = typeof payload.run?.id === "string" ? payload.run.id.trim() : "";
  if (!runId) return undefined;

  const parentRunId = cleanOptional(payload.run.parentRunId);
  const rootRunId = cleanOptional(payload.run.rootRunId) ?? parentRunId ?? runId;
  const startedAt = finiteTimestamp(payload.run.startedAt) ?? Date.now();
  const finishedAt = finiteTimestamp(payload.run.finishedAt);

  db.prepare(`
    INSERT INTO helix_runs
      (run_id, issue_id, parent_run_id, root_run_id, status, started_at, finished_at, updated_at)
    VALUES
      (@runId, @issueId, @parentRunId, @rootRunId, @status, @startedAt, @finishedAt, @now)
    ON CONFLICT(run_id) DO UPDATE SET
      issue_id = excluded.issue_id,
      parent_run_id = excluded.parent_run_id,
      root_run_id = excluded.root_run_id,
      status = excluded.status,
      started_at = excluded.started_at,
      finished_at = excluded.finished_at,
      updated_at = excluded.updated_at
  `).run({
    runId,
    issueId,
    parentRunId: parentRunId ?? null,
    rootRunId,
    status: payload.run.status,
    startedAt,
    finishedAt: finishedAt ?? null,
    now: Date.now(),
  });

  return { runId, issueId, parentRunId, rootRunId, status: payload.run.status, startedAt, finishedAt };
}

export function latestCompletedHelixRun(
  db: Database.Database,
  issueId: number,
): HelixRunRecord | undefined {
  const row = db.prepare(`
    SELECT run_id, issue_id, parent_run_id, root_run_id, status, started_at, finished_at
    FROM helix_runs
    WHERE issue_id = ? AND status = 'done' AND finished_at IS NOT NULL
    ORDER BY finished_at DESC, updated_at DESC
    LIMIT 1
  `).get(issueId) as {
    run_id: string;
    issue_id: number;
    parent_run_id: string | null;
    root_run_id: string;
    status: string;
    started_at: number;
    finished_at: number | null;
  } | undefined;

  if (!row) return undefined;
  return {
    runId: row.run_id,
    issueId: row.issue_id,
    parentRunId: row.parent_run_id ?? undefined,
    rootRunId: row.root_run_id,
    status: row.status,
    startedAt: row.started_at,
    finishedAt: row.finished_at ?? undefined,
  };
}

function cleanOptional(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function finiteTimestamp(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

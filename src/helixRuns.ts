import type Database from "better-sqlite3";
import type { HelixRunPayload } from "./types.js";

export interface HelixRunRecord {
  runId: string;
  issueId: number;
  parentRunId?: string;
  rootRunId: string;
  status: string;
  trigger?: string;
  startedAt: number;
  finishedAt?: number;
}

export function recordHelixRun(
  db: Database.Database,
  issueId: number,
  payload: HelixRunPayload,
  trigger?: string,
): HelixRunRecord | undefined {
  const runId = typeof payload.run?.id === "string" ? payload.run.id.trim() : "";
  if (!runId) return undefined;

  const parentRunId = cleanOptional(payload.run.parentRunId);
  const rootRunId = cleanOptional(payload.run.rootRunId) ?? parentRunId ?? runId;
  const startedAt = finiteTimestamp(payload.run.startedAt) ?? Date.now();
  const finishedAt = finiteTimestamp(payload.run.finishedAt);
  const existing = getHelixRun(db, runId);

  db.prepare(`
    INSERT INTO helix_runs
      (run_id, issue_id, parent_run_id, root_run_id, status, trigger, started_at, finished_at, updated_at)
    VALUES
      (@runId, @issueId, @parentRunId, @rootRunId, @status, @trigger, @startedAt, @finishedAt, @now)
    ON CONFLICT(run_id) DO UPDATE SET
      issue_id = excluded.issue_id,
      parent_run_id = excluded.parent_run_id,
      root_run_id = excluded.root_run_id,
      status = excluded.status,
      trigger = COALESCE(excluded.trigger, helix_runs.trigger),
      started_at = excluded.started_at,
      finished_at = excluded.finished_at,
      updated_at = excluded.updated_at
  `).run({
    runId,
    issueId,
    parentRunId: parentRunId ?? null,
    rootRunId,
    status: payload.run.status,
    trigger: cleanOptional(trigger) ?? existing?.trigger ?? null,
    startedAt,
    finishedAt: finishedAt ?? null,
    now: Date.now(),
  });

  return getHelixRun(db, runId);
}

/** Record a child/continuation run as soon as Helix accepts it (before run.completed). */
export function recordPendingHelixRun(
  db: Database.Database,
  input: {
    issueId: number;
    runId: string;
    parentRunId?: string;
    rootRunId?: string;
    trigger: string;
    startedAt?: number;
  },
): HelixRunRecord | undefined {
  const runId = input.runId.trim();
  if (!runId) return undefined;
  const parentRunId = cleanOptional(input.parentRunId);
  const rootRunId = cleanOptional(input.rootRunId) ?? parentRunId ?? runId;
  const startedAt = input.startedAt ?? Date.now();

  db.prepare(`
    INSERT INTO helix_runs
      (run_id, issue_id, parent_run_id, root_run_id, status, trigger, started_at, finished_at, updated_at)
    VALUES
      (@runId, @issueId, @parentRunId, @rootRunId, 'running', @trigger, @startedAt, NULL, @now)
    ON CONFLICT(run_id) DO UPDATE SET
      issue_id = excluded.issue_id,
      parent_run_id = excluded.parent_run_id,
      root_run_id = excluded.root_run_id,
      status = CASE
        WHEN helix_runs.finished_at IS NULL THEN 'running'
        ELSE helix_runs.status
      END,
      trigger = COALESCE(excluded.trigger, helix_runs.trigger),
      started_at = helix_runs.started_at,
      updated_at = excluded.updated_at
  `).run({
    runId,
    issueId: input.issueId,
    parentRunId: parentRunId ?? null,
    rootRunId,
    trigger: input.trigger,
    startedAt,
    now: Date.now(),
  });

  return getHelixRun(db, runId);
}

export function getHelixRun(db: Database.Database, runId: string): HelixRunRecord | undefined {
  const row = db.prepare(`
    SELECT run_id, issue_id, parent_run_id, root_run_id, status, trigger, started_at, finished_at
    FROM helix_runs
    WHERE run_id = ?
  `).get(runId) as HelixRunRow | undefined;
  return row ? toRecord(row) : undefined;
}

export function activeHelixRun(
  db: Database.Database,
  issueId: number,
): HelixRunRecord | undefined {
  const row = db.prepare(`
    SELECT run_id, issue_id, parent_run_id, root_run_id, status, trigger, started_at, finished_at
    FROM helix_runs
    WHERE issue_id = ? AND finished_at IS NULL
    ORDER BY started_at DESC, updated_at DESC
    LIMIT 1
  `).get(issueId) as HelixRunRow | undefined;
  return row ? toRecord(row) : undefined;
}

export function latestCompletedHelixRun(
  db: Database.Database,
  issueId: number,
): HelixRunRecord | undefined {
  const row = db.prepare(`
    SELECT run_id, issue_id, parent_run_id, root_run_id, status, trigger, started_at, finished_at
    FROM helix_runs
    WHERE issue_id = ?
      AND status IN ('done', 'escalated')
      AND finished_at IS NOT NULL
    ORDER BY finished_at DESC, updated_at DESC
    LIMIT 1
  `).get(issueId) as HelixRunRow | undefined;
  return row ? toRecord(row) : undefined;
}

export function helixActivityForIssue(
  db: Database.Database,
  issueId: number,
): { activeRun?: HelixRunRecord; latestCompletedRun?: HelixRunRecord } {
  return {
    activeRun: activeHelixRun(db, issueId),
    latestCompletedRun: latestCompletedHelixRun(db, issueId),
  };
}

export function parseHelixContinuationResponse(body: string | null | undefined): {
  runId?: string;
  status?: string;
  duplicate?: boolean;
} {
  if (!body?.trim()) return {};
  try {
    const parsed = JSON.parse(body) as Record<string, unknown>;
    return {
      runId: cleanOptional(parsed.id),
      status: cleanOptional(parsed.status),
      duplicate: parsed.duplicate === true,
    };
  } catch {
    return {};
  }
}

interface HelixRunRow {
  run_id: string;
  issue_id: number;
  parent_run_id: string | null;
  root_run_id: string;
  status: string;
  trigger: string | null;
  started_at: number;
  finished_at: number | null;
}

function toRecord(row: HelixRunRow): HelixRunRecord {
  return {
    runId: row.run_id,
    issueId: row.issue_id,
    parentRunId: row.parent_run_id ?? undefined,
    rootRunId: row.root_run_id,
    status: row.status,
    trigger: row.trigger ?? undefined,
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

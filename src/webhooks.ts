import type Database from "better-sqlite3";
import { loadConfig } from "./config.js";
import {
  issueMatchesFilter,
  issueToWebhookPayload,
  recordDelivery,
  type AppConfig,
} from "./issues.js";
import type {
  ContinuationWebhookPayload,
  Issue,
  OutboundWebhookPayload,
  PullRequest,
  PullRequestReviewWebhookPayload,
  WebhookDelivery,
} from "./types.js";
import { getIssue } from "./issues.js";

const MAX_ATTEMPTS = 3;
const RETRY_DELAYS_MS = [0, 500, 1500];

export interface WebhookDispatcherOptions {
  db: Database.Database;
  fetchFn?: typeof fetch;
}

export class WebhookDispatcher {
  private readonly db: Database.Database;
  private readonly fetchFn: typeof fetch;

  constructor(opts: WebhookDispatcherOptions) {
    this.db = opts.db;
    this.fetchFn = opts.fetchFn ?? fetch;
  }

  shouldAutoTrigger(issue: Issue, config: AppConfig): boolean {
    return config.webhookEnabled && issueMatchesFilter(issue, config.labelFilter);
  }

  async dispatchForIssue(issue: Issue, reason: string): Promise<WebhookDelivery | null> {
    const config = loadConfig(this.db);
    if (!config.webhookEnabled) return null;
    if (!config.webhookUrl.trim()) {
      return recordDelivery(this.db, {
        issueId: issue.id,
        url: "",
        payload: issueToWebhookPayload(issue, config.baseUrl),
        statusCode: null,
        responseBody: null,
        success: false,
        attempts: 0,
        error: `Skipped (${reason}): webhook URL not configured`,
      });
    }
    if (issue.status !== "open") {
      return recordDelivery(this.db, {
        issueId: issue.id,
        url: config.webhookUrl,
        payload: issueToWebhookPayload(issue, config.baseUrl),
        statusCode: null,
        responseBody: null,
        success: false,
        attempts: 0,
        error: `Skipped (${reason}): issue is ${issue.status}`,
      });
    }

    const payload = issueToWebhookPayload(issue, config.baseUrl);
    return this.send(config.webhookUrl, issue.id, payload, reason, config.baseUrl);
  }

  async dispatchContinuation(
    issue: Issue,
    parentRunId: string,
    payload: ContinuationWebhookPayload,
    reason: string,
  ): Promise<WebhookDelivery | null> {
    const config = loadConfig(this.db);
    if (!config.webhookEnabled) return null;

    const url = continuationUrl(config.webhookUrl, parentRunId);
    if (!url) {
      return recordDelivery(this.db, {
        issueId: issue.id,
        url: config.webhookUrl,
        payload,
        statusCode: null,
        responseBody: null,
        success: false,
        attempts: 0,
        error: `Skipped (${reason}): webhook URL must end in /runs`,
      });
    }
    if (issue.status === "closed") {
      return recordDelivery(this.db, {
        issueId: issue.id,
        url,
        payload,
        statusCode: null,
        responseBody: null,
        success: false,
        attempts: 0,
        error: `Skipped (${reason}): issue is ${issue.status}`,
      });
    }
    return this.send(url, issue.id, payload, reason, config.baseUrl);
  }

  async dispatchPullRequestReview(
    pullRequest: PullRequest,
  ): Promise<{ success: boolean; statusCode: number | null; error: string | null; response?: unknown }> {
    const config = loadConfig(this.db);
    if (!config.webhookEnabled) {
      return { success: false, statusCode: null, error: "Webhooks are disabled" };
    }
    const url = pullRequestReviewUrl(config.webhookUrl);
    if (!url) {
      return {
        success: false,
        statusCode: null,
        error: "Webhook URL must end in /runs so the Helix PR-review endpoint can be derived",
      };
    }

    const issue = pullRequest.issueId
      ? getIssue(this.db, config.baseUrl, pullRequest.issueId)
      : undefined;
    const payload: PullRequestReviewWebhookPayload = {
      pullRequest: {
        id: pullRequest.id,
        title: pullRequest.title,
        description: pullRequest.description,
        repositoryPath: pullRequest.repositoryPath,
        baseBranch: pullRequest.baseBranch,
        baseSha: pullRequest.baseSha,
        headBranch: pullRequest.headBranch,
        headSha: pullRequest.headSha,
        author: pullRequest.author,
        origin: pullRequest.origin,
        issue: issue
          ? { id: issue.id, title: issue.title, body: issue.body }
          : undefined,
      },
      callback: {
        trackerUrl: config.baseUrl.replace(/\/$/, ""),
        pullRequestId: pullRequest.id,
      },
      externalEventId: `pull-request:${pullRequest.id}:head:${pullRequest.headSha}`,
    };

    try {
      const res = await this.fetchFn(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Issues-Reason": "pull_request.review_requested",
          "X-Issues-Pull-Request-Id": String(pullRequest.id),
          "X-Issues-Source": config.baseUrl.replace(/\/$/, ""),
        },
        body: JSON.stringify(payload),
      });
      const body = await res.text();
      let response: unknown;
      try {
        response = body ? JSON.parse(body) : undefined;
      } catch {
        response = body;
      }
      return {
        success: res.ok,
        statusCode: res.status,
        error: res.ok ? null : `HTTP ${res.status}`,
        response,
      };
    } catch (err) {
      return {
        success: false,
        statusCode: null,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }

  /**
   * Ask Helix to merge a reviewed local PR in the workspace Helix actually owns.
   * Issues may only have a stale/wrong repositoryPath from webhook metadata.
   */
  async dispatchLocalPullRequestMerge(
    pullRequest: PullRequest,
  ): Promise<{
    success: boolean;
    statusCode: number | null;
    error: string | null;
    mergeCommitSha?: string;
    repositoryPath?: string;
  }> {
    const config = loadConfig(this.db);
    if (!config.webhookEnabled) {
      return { success: false, statusCode: null, error: "Webhooks are disabled" };
    }
    const url = localPullRequestMergeUrl(config.webhookUrl);
    if (!url) {
      return {
        success: false,
        statusCode: null,
        error: "Webhook URL must end in /runs so the Helix merge endpoint can be derived",
      };
    }

    try {
      const res = await this.fetchFn(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Issues-Reason": "pull_request.merge",
          "X-Issues-Pull-Request-Id": String(pullRequest.id),
          "X-Issues-Source": config.baseUrl.replace(/\/$/, ""),
        },
        body: JSON.stringify({
          pullRequest: {
            id: pullRequest.id,
            title: pullRequest.title,
            repositoryPath: pullRequest.repositoryPath,
            baseBranch: pullRequest.baseBranch,
            headBranch: pullRequest.headBranch,
            headSha: pullRequest.headSha,
          },
        }),
      });
      const body = await res.text();
      let parsed: { mergeCommitSha?: string; repositoryPath?: string; error?: string } = {};
      try {
        parsed = body ? JSON.parse(body) as typeof parsed : {};
      } catch {
        parsed = {};
      }
      if (!res.ok) {
        return {
          success: false,
          statusCode: res.status,
          error: parsed.error || `Helix merge failed (HTTP ${res.status})`,
          repositoryPath: parsed.repositoryPath,
        };
      }
      if (typeof parsed.mergeCommitSha !== "string" || !parsed.mergeCommitSha.trim()) {
        return {
          success: false,
          statusCode: res.status,
          error: "Helix merge response did not include mergeCommitSha",
          repositoryPath: parsed.repositoryPath,
        };
      }
      return {
        success: true,
        statusCode: res.status,
        error: null,
        mergeCommitSha: parsed.mergeCommitSha.trim(),
        repositoryPath: parsed.repositoryPath,
      };
    } catch (err) {
      return {
        success: false,
        statusCode: null,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }

  /** Best-effort Helix workspace cwd for copyable merge commands. */
  async fetchHelixWorkspaceCwd(): Promise<string | undefined> {
    const config = loadConfig(this.db);
    const url = helixWorkspaceUrl(config.webhookUrl);
    if (!url) return undefined;
    try {
      const res = await this.fetchFn(url, { method: "GET" });
      if (!res.ok) return undefined;
      const body = await res.json() as { cwd?: unknown };
      return typeof body.cwd === "string" && body.cwd.trim() ? body.cwd.trim() : undefined;
    } catch {
      return undefined;
    }
  }

  async send(
    url: string,
    issueId: number,
    payload: OutboundWebhookPayload,
    reason: string,
    trackerUrl?: string
  ): Promise<WebhookDelivery> {
    let lastStatus: number | null = null;
    let lastBody: string | null = null;
    let lastError: string | null = null;

    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      const delay = RETRY_DELAYS_MS[attempt - 1] ?? 1500;
      if (delay > 0) await sleep(delay);

      try {
        const res = await this.fetchFn(url, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-Issues-Reason": reason,
            "X-Issues-Issue-Id": String(issueId),
            ...(trackerUrl ? { "X-Issues-Source": trackerUrl.replace(/\/$/, "") } : {}),
          },
          body: JSON.stringify(payload),
        });

        lastStatus = res.status;
        lastBody = await res.text();
        const success = res.status >= 200 && res.status < 300;

        if (success) {
          return recordDelivery(this.db, {
            issueId,
            url,
            payload,
            statusCode: lastStatus,
            responseBody: truncate(lastBody),
            success: true,
            attempts: attempt,
            error: null,
          });
        }

        lastError = `HTTP ${res.status}`;
      } catch (err) {
        lastError = err instanceof Error ? err.message : String(err);
      }
    }

    return recordDelivery(this.db, {
      issueId,
      url,
      payload,
      statusCode: lastStatus,
      responseBody: truncate(lastBody),
      success: false,
      attempts: MAX_ATTEMPTS,
      error: lastError,
    });
  }
}

function continuationUrl(webhookUrl: string, parentRunId: string): string | undefined {
  const normalized = webhookUrl.trim().replace(/\/+$/, "");
  if (!normalized.endsWith("/runs")) return undefined;
  return `${normalized}/${encodeURIComponent(parentRunId)}/continuations`;
}

function pullRequestReviewUrl(webhookUrl: string): string | undefined {
  const normalized = webhookUrl.trim().replace(/\/+$/, "");
  if (!normalized.endsWith("/runs")) return undefined;
  return `${normalized.slice(0, -"/runs".length)}/pr-reviews`;
}

function localPullRequestMergeUrl(webhookUrl: string): string | undefined {
  const normalized = webhookUrl.trim().replace(/\/+$/, "");
  if (!normalized.endsWith("/runs")) return undefined;
  return `${normalized.slice(0, -"/runs".length)}/local-prs/merge`;
}

function helixWorkspaceUrl(webhookUrl: string): string | undefined {
  const normalized = webhookUrl.trim().replace(/\/+$/, "");
  if (!normalized.endsWith("/runs")) return undefined;
  return `${normalized.slice(0, -"/runs".length)}/workspace`;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function truncate(text: string | null, max = 2000): string | null {
  if (text == null) return null;
  return text.length <= max ? text : `${text.slice(0, max)}…`;
}

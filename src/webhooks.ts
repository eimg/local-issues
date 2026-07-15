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
  WebhookDelivery,
} from "./types.js";

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
    if (issue.status !== "open") {
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

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function truncate(text: string | null, max = 2000): string | null {
  if (text == null) return null;
  return text.length <= max ? text : `${text.slice(0, max)}…`;
}

export type IssueStatus = "open" | "in_progress" | "closed";

export interface Issue {
  id: number;
  title: string;
  body: string;
  status: IssueStatus;
  labels: string[];
  createdAt: number;
  updatedAt: number;
  url: string;
}

export interface IssueInput {
  title: string;
  body?: string;
  labels?: string[];
  status?: IssueStatus;
}

export interface IssueUpdate {
  title?: string;
  body?: string;
  status?: IssueStatus;
  labels?: string[];
}

export interface AppConfig {
  webhookUrl: string;
  labelFilter: string;
  webhookEnabled: boolean;
  baseUrl: string;
}

export interface WebhookPayload {
  title: string;
  body: string;
  labels: string[];
  external?: {
    trackerUrl: string;
    issueId: number;
  };
}

export interface HelixRunPayload {
  event: "run.started" | "run.completed";
  run: {
    id: string;
    status: string;
    startedAt: number;
    finishedAt?: number;
  };
  issue: {
    id: number;
    title: string;
  };
}

export type HelixRunCompletedPayload = HelixRunPayload;

export interface IssueListQuery {
  status?: IssueStatus;
  label?: string;
  limit?: number;
  offset?: number;
}

export interface IssueListResult {
  items: Issue[];
  total: number;
  limit: number;
  offset: number;
}

export type CommentSource = "user" | "system" | "helix.webhook";

export interface IssueComment {
  id: number;
  issueId: number;
  author: string;
  source: CommentSource;
  body: string;
  createdAt: number;
}

export interface CommentInput {
  author?: string;
  source?: CommentSource;
  body: string;
}

export interface CommentUpdate {
  body?: string;
  author?: string;
}

export interface WebhookDelivery {
  id: number;
  issueId: number;
  url: string;
  payload: WebhookPayload;
  statusCode: number | null;
  responseBody: string | null;
  success: boolean;
  attempts: number;
  error: string | null;
  createdAt: number;
}

export const DEFAULT_PORT = 8320;
export const DEFAULT_WEBHOOK_URL = "";
export const DEFAULT_LABEL_FILTER = "trigger";

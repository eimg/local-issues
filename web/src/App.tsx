import { useState } from "react";
import {
  useMutation,
  useQuery,
  useQueryClient,
  type UseQueryResult,
} from "@tanstack/react-query";
import type {
  Issue,
  IssueComment,
  IssueListResult,
  IssueStatus,
  PullRequest,
  PullRequestReview,
  PullRequestStatus,
  WebhookDelivery,
} from "../../src/types";
import { api, formatStatus, formatTime } from "./api";

type View = "issues" | "pull-requests";
type PullRequestDetailData = PullRequest & { reviews: PullRequestReview[] };

export function App() {
  const [view, setView] = useState<View>("issues");
  return (
    <>
      <Header view={view} onView={setView} />
      {view === "issues" ? <IssuesWorkspace /> : <PullRequestsWorkspace />}
    </>
  );
}

function Header({ view, onView }: { view: View; onView: (view: View) => void }) {
  return (
    <header className="app-header">
      <div className="brand">
        <BrandMark />
        <div className="brand-text">
          <h1>Acme Issues</h1>
          <p className="brand-tagline">Local issue tracker with outbound webhooks</p>
        </div>
        <span className="react-port-badge">React preview</span>
      </div>
      <div className="header-actions">
        <div className="view-switcher" role="navigation" aria-label="Workspace">
          <button
            className={`view-switch ${view === "issues" ? "active" : ""}`}
            onClick={() => onView("issues")}
          >
            Issues
          </button>
          <button
            className={`view-switch ${view === "pull-requests" ? "active" : ""}`}
            onClick={() => onView("pull-requests")}
          >
            Pull requests
          </button>
        </div>
        <a className="btn btn-ghost" href="/">Current UI</a>
      </div>
    </header>
  );
}

function IssuesWorkspace() {
  const queryClient = useQueryClient();
  const [status, setStatus] = useState<IssueStatus | "">("");
  const [label, setLabel] = useState("");
  const [offset, setOffset] = useState(0);
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const query = useQuery({
    queryKey: ["issues", status, label, offset],
    queryFn: () => api<IssueListResult>(
      `/api/issues?limit=25&offset=${offset}&status=${status}&label=${encodeURIComponent(label)}`,
    ),
  });
  const deliveries = useQuery({
    queryKey: ["deliveries"],
    queryFn: () => api<WebhookDelivery[]>("/api/webhooks/deliveries?limit=50"),
  });

  return (
    <main className="layout">
      <section className="panel issues-panel" aria-label="Issue list">
        <div className="panel-header issues-panel-header">
          <div className="panel-title-row"><h2>Issues</h2></div>
          <div className="filters" role="group" aria-label="Filter by status">
            {(["", "open", "in_progress", "closed"] as const).map((value) => (
              <button
                key={value || "all"}
                className={`filter-btn ${status === value ? "active" : ""}`}
                onClick={() => {
                  setStatus(value);
                  setOffset(0);
                }}
              >
                {value ? formatStatus(value) : "All"}
              </button>
            ))}
          </div>
          <div className="list-toolbar">
            <input
              className="input label-filter-input"
              value={label}
              onChange={(event) => {
                setLabel(event.target.value);
                setOffset(0);
              }}
              placeholder="Filter by label"
            />
          </div>
        </div>
        {query.isPending ? (
          <p className="query-state">Loading issues…</p>
        ) : query.isError ? (
          <QueryError error={query.error} />
        ) : (
          <>
            <ul className="issue-list">
              {query.data.items.map((issue) => (
                <li
                  key={issue.id}
                  className={`issue-item ${selectedId === issue.id ? "active" : ""}`}
                  onClick={() => setSelectedId(issue.id)}
                >
                  <h3>#{issue.id} {issue.title}</h3>
                  <div className="issue-meta">
                    <span className={`status ${issue.status}`}>{formatStatus(issue.status)}</span>
                    {" · "}{formatTime(issue.updatedAt)}
                  </div>
                  <div className="labels">
                    {issue.labels.map((item) => <span className="label" key={item}>{item}</span>)}
                  </div>
                </li>
              ))}
              {!query.data.items.length && <li className="issue-empty">No matching issues.</li>}
            </ul>
            <div className="pager">
              <button
                className="btn btn-ghost btn-sm"
                disabled={offset === 0}
                onClick={() => setOffset(Math.max(0, offset - 25))}
              >
                Prev
              </button>
              <span className="page-info">
                {query.data.total
                  ? `${offset + 1}–${Math.min(offset + 25, query.data.total)} of ${query.data.total}`
                  : "0 issues"}
              </span>
              <button
                className="btn btn-ghost btn-sm"
                disabled={offset + 25 >= query.data.total}
                onClick={() => setOffset(offset + 25)}
              >
                Next
              </button>
            </div>
          </>
        )}
      </section>
      <IssueDetail
        id={selectedId}
        onChanged={() => queryClient.invalidateQueries({ queryKey: ["issues"] })}
      />
      <DeliveriesPanel query={deliveries} />
    </main>
  );
}

function IssueDetail({ id, onChanged }: { id: number | null; onChanged: () => void }) {
  const queryClient = useQueryClient();
  const issue = useQuery({
    queryKey: ["issue", id],
    queryFn: () => api<Issue>(`/api/issues/${id}`),
    enabled: id !== null,
    refetchInterval: (query) => query.state.data?.status === "in_progress" ? 2_000 : false,
  });
  const comments = useQuery({
    queryKey: ["comments", id],
    queryFn: () => api<IssueComment[]>(`/api/issues/${id}/comments`),
    enabled: id !== null,
  });
  const invalidate = async () => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: ["issue", id] }),
      queryClient.invalidateQueries({ queryKey: ["comments", id] }),
      queryClient.invalidateQueries({ queryKey: ["deliveries"] }),
    ]);
    onChanged();
  };
  const patch = useMutation({
    mutationFn: (body: Partial<Issue>) => api<{ issue: Issue }>(`/api/issues/${id}`, {
      method: "PATCH",
      body: JSON.stringify(body),
    }),
    onSuccess: invalidate,
  });
  const trigger = useMutation({
    mutationFn: () => api(`/api/issues/${id}/trigger`, { method: "POST" }),
    onSuccess: invalidate,
  });
  const addComment = useMutation({
    mutationFn: (body: string) => api(`/api/issues/${id}/comments`, {
      method: "POST",
      body: JSON.stringify({ body, author: "user" }),
    }),
    onSuccess: invalidate,
  });

  if (id === null) return <section className="panel detail-panel"><EmptyIssue /></section>;
  if (issue.isPending) return <section className="panel detail-panel"><p className="query-state">Loading issue…</p></section>;
  if (issue.isError) return <section className="panel detail-panel"><QueryError error={issue.error} /></section>;
  return (
    <section className="panel detail-panel">
      <IssueEditor
        key={`${issue.data.id}:${issue.data.updatedAt}`}
        issue={issue.data}
        comments={comments.data ?? []}
        busy={patch.isPending || trigger.isPending || addComment.isPending}
        onSave={(body) => patch.mutate(body)}
        onToggle={() => patch.mutate({
          status: issue.data.status === "closed" ? "open" : "closed",
        })}
        onTrigger={() => trigger.mutate()}
        onComment={(body) => addComment.mutate(body)}
      />
    </section>
  );
}

function IssueEditor(props: {
  issue: Issue;
  comments: IssueComment[];
  busy: boolean;
  onSave: (patch: Partial<Issue>) => void;
  onToggle: () => void;
  onTrigger: () => void;
  onComment: (body: string) => void;
}) {
  const [title, setTitle] = useState(props.issue.title);
  const [body, setBody] = useState(props.issue.body);
  const [labels, setLabels] = useState(props.issue.labels.join(", "));
  const [comment, setComment] = useState("");
  return (
    <div className="issue-detail">
      <div className="detail-header">
        <span className="issue-number">Issue #{props.issue.id}</span>
        <div className="detail-actions">
          <button className="btn btn-secondary" disabled={props.busy} onClick={props.onTrigger}>Send webhook</button>
          <button className="btn btn-ghost" disabled={props.busy} onClick={props.onToggle}>
            {props.issue.status === "closed" ? "Reopen" : "Close issue"}
          </button>
        </div>
      </div>
      <input className="input title-input" value={title} onChange={(event) => setTitle(event.target.value)} />
      <textarea className="input body-input" rows={12} value={body} onChange={(event) => setBody(event.target.value)} />
      <div className="labels-row">
        <label>Labels</label>
        <div className="labels-row-fields">
          <input className="input" value={labels} onChange={(event) => setLabels(event.target.value)} />
          <button
            className="btn btn-primary"
            disabled={props.busy}
            onClick={() => props.onSave({
              title,
              body,
              labels: labels.split(",").map((item) => item.trim()).filter(Boolean),
            })}
          >
            Save
          </button>
        </div>
      </div>
      <p className="meta">{formatStatus(props.issue.status)} · updated {formatTime(props.issue.updatedAt)}</p>
      <section className="comments-section">
        <h3>Comments</h3>
        <ul className="comment-list">
          {props.comments.map((item) => (
            <li
              className={`comment-item ${item.source === "helix.webhook" ? "helix-webhook" : item.source}`}
              key={item.id}
            >
              <div className="comment-head">
                <span className="comment-author">{item.author}</span>
                <span>{formatTime(item.createdAt)}</span>
              </div>
              <p className="comment-body">{item.body}</p>
            </li>
          ))}
          {!props.comments.length && <li className="comment-empty">No comments yet.</li>}
        </ul>
        <form
          className="comment-form"
          onSubmit={(event) => {
            event.preventDefault();
            if (!comment.trim()) return;
            props.onComment(comment.trim());
            setComment("");
          }}
        >
          <textarea
            className="input comment-input"
            rows={3}
            value={comment}
            onChange={(event) => setComment(event.target.value)}
            placeholder="Write a comment… Use /helix to request continuation"
          />
          <div className="comment-form-actions">
            <button className="btn btn-primary" disabled={props.busy}>Add comment</button>
          </div>
        </form>
      </section>
    </div>
  );
}

function DeliveriesPanel({ query }: { query: UseQueryResult<WebhookDelivery[], Error> }) {
  const client = useQueryClient();
  const clear = useMutation({
    mutationFn: () => api("/api/webhooks/deliveries", { method: "DELETE" }),
    onSuccess: () => client.invalidateQueries({ queryKey: ["deliveries"] }),
  });
  return (
    <section className="panel deliveries-panel">
      <div className="panel-header">
        <h2>Webhook deliveries</h2>
        <div className="panel-header-actions">
          <button className="btn btn-ghost btn-sm" onClick={() => query.refetch()}>Refresh</button>
          <button className="btn btn-ghost btn-sm" disabled={clear.isPending} onClick={() => clear.mutate()}>Clear</button>
        </div>
      </div>
      <ul className="delivery-list">
        {query.data?.map((delivery) => (
          <li className={`delivery-item ${delivery.success ? "success" : "failed"}`} key={delivery.id}>
            <div className="delivery-item-head">
              <div className={`delivery-status ${delivery.success ? "success" : "failed"}`}>
                #{delivery.issueId} · {delivery.success
                  ? `HTTP ${delivery.statusCode}`
                  : delivery.error || `HTTP ${delivery.statusCode ?? "error"}`}
              </div>
            </div>
            <div className="delivery-meta">
              {formatTime(delivery.createdAt)} · {delivery.attempts} attempt(s)
            </div>
            <div className="delivery-meta">{delivery.url}</div>
          </li>
        ))}
        {!query.isPending && !query.data?.length && <li className="delivery-empty">No webhook deliveries.</li>}
      </ul>
    </section>
  );
}

function PullRequestsWorkspace() {
  const [status, setStatus] = useState<PullRequestStatus | "">("");
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const list = useQuery({
    queryKey: ["pull-requests", status],
    queryFn: () => api<PullRequest[]>(`/api/pull-requests?status=${status}`),
  });
  return (
    <main className="pr-layout">
      <section className="panel pr-list-panel">
        <div className="panel-header pr-list-header">
          <div><h2>Local pull requests</h2><p>Git-backed changes awaiting human merge</p></div>
          <button className="btn btn-ghost btn-sm" onClick={() => list.refetch()}>Refresh</button>
        </div>
        <div className="filters pr-filters">
          {([
            ["", "All"],
            ["reviewing", "Reviewing"],
            ["changes_requested", "Changes"],
            ["ready_to_merge", "Ready"],
          ] as const).map(([value, label]) => (
            <button
              className={`pr-filter-btn filter-btn ${status === value ? "active" : ""}`}
              key={value || "all"}
              onClick={() => setStatus(value)}
            >
              {label}
            </button>
          ))}
        </div>
        <ul className="issue-list pr-list">
          {list.data?.map((pr) => (
            <li
              className={`issue-item pr-item ${selectedId === pr.id ? "active" : ""}`}
              key={pr.id}
              onClick={() => setSelectedId(pr.id)}
            >
              <div className="pr-item-top">
                <h3>#{pr.id} {pr.title}</h3>
                <span className={`status pr-status ${pr.status}`}>{formatStatus(pr.status)}</span>
              </div>
              <div className="issue-meta">{pr.headBranch} → {pr.baseBranch}</div>
              <div className="issue-meta"><code>{pr.headSha.slice(0, 10)}</code> · {pr.origin}</div>
            </li>
          ))}
        </ul>
      </section>
      <PullRequestDetail id={selectedId} />
    </main>
  );
}

function PullRequestDetail({ id }: { id: number | null }) {
  const client = useQueryClient();
  const detail = useQuery({
    queryKey: ["pull-request", id],
    queryFn: () => api<PullRequestDetailData>(`/api/pull-requests/${id}`),
    enabled: id !== null,
    refetchInterval: (query) => query.state.data?.status === "reviewing" ? 2_000 : false,
  });
  const diff = useQuery({
    queryKey: ["pull-request-diff", id],
    queryFn: () => api<{ diff: string }>(`/api/pull-requests/${id}/diff`),
    enabled: id !== null,
    staleTime: Infinity,
  });
  const invalidate = async () => {
    await Promise.all([
      client.invalidateQueries({ queryKey: ["pull-request", id] }),
      client.invalidateQueries({ queryKey: ["pull-requests"] }),
    ]);
  };
  const review = useMutation({
    mutationFn: () => api(`/api/pull-requests/${id}/review`, { method: "POST" }),
    onSuccess: invalidate,
  });
  const merge = useMutation({
    mutationFn: () => api(`/api/pull-requests/${id}`, {
      method: "PATCH",
      body: JSON.stringify({ status: "merged" }),
    }),
    onSuccess: invalidate,
  });

  if (id === null) {
    return (
      <section className="panel pr-detail-panel">
        <div className="empty-state">
          <p className="empty-title">No pull request selected</p>
          <p className="empty-hint">Select a local PR to inspect its exact SHA, findings, checks, and diff.</p>
        </div>
      </section>
    );
  }
  if (detail.isPending) return <section className="panel pr-detail-panel"><p className="query-state">Loading pull request…</p></section>;
  if (detail.isError) return <section className="panel pr-detail-panel"><QueryError error={detail.error} /></section>;

  const pr = detail.data;
  const latest = pr.reviews.find((item) => item.headSha === pr.headSha);
  const reviewed = pr.reviews.some((item) => item.headSha === pr.headSha && item.status === "completed");
  const closed = pr.status === "merged" || pr.status === "closed";
  return (
    <section className="panel pr-detail-panel">
      <article className="pr-detail">
        <div className="pr-detail-head">
          <div><span className="issue-number">Local PR #{pr.id}</span><h2>{pr.title}</h2></div>
          <div className="detail-actions">
            {!closed && (
              <button
                className={`btn ${reviewed ? "btn-secondary" : "btn-primary"}`}
                disabled={pr.status === "reviewing" || review.isPending}
                onClick={() => review.mutate()}
              >
                {pr.status === "reviewing" ? "Review running…" : reviewed ? "Review again" : "Request review"}
              </button>
            )}
            {pr.status === "ready_to_merge" && (
              <button className="btn btn-secondary" disabled={merge.isPending} onClick={() => merge.mutate()}>
                Mark merged
              </button>
            )}
          </div>
        </div>
        <div className={`pr-status-banner ${pr.status}`}>{formatStatus(pr.status)}</div>
        <p className="pr-description">{pr.description || "No description."}</p>
        <dl className="pr-identity">
          <div><dt>Repository</dt><dd>{pr.repositoryPath}</dd></div>
          <div><dt>Branches</dt><dd>{pr.headBranch} → {pr.baseBranch}</dd></div>
          <div><dt>Base SHA</dt><dd><code>{pr.baseSha}</code></dd></div>
          <div><dt>Head SHA</dt><dd><code>{pr.headSha}</code></dd></div>
          <div><dt>Origin</dt><dd>{pr.origin} · {pr.author}</dd></div>
          <div><dt>Linked issue</dt><dd>{pr.issueId ? `Issue #${pr.issueId}` : "None"}</dd></div>
        </dl>
        <section className="pr-review-section">
          <h3>Latest review</h3>
          <div className="review-summary muted-card">{latest?.summary || "No review has run for this head SHA."}</div>
          <div className="review-columns">
            <ReviewItems
              title="Findings"
              items={latest?.findings.map((item) => ({
                badge: item.severity,
                title: item.title,
                body: item.details,
              })) ?? []}
            />
            <ReviewItems
              title="Checks"
              items={latest?.checks.map((item) => ({
                badge: item.status,
                title: item.name,
                body: item.summary,
              })) ?? []}
            />
          </div>
        </section>
        <section className="pr-diff-section">
          <div className="section-heading">
            <h3>Diff</h3>
            <button className="btn btn-ghost btn-sm" onClick={() => diff.refetch()}>Reload</button>
          </div>
          <pre className="pr-diff">
            {diff.isPending ? "Loading…" : diff.isError ? diff.error.message : diff.data?.diff || "(no diff)"}
          </pre>
        </section>
      </article>
    </section>
  );
}

function ReviewItems({
  title,
  items,
}: {
  title: string;
  items: { badge: string; title: string; body: string }[];
}) {
  return (
    <div>
      <h4>{title}</h4>
      <ul className="review-list">
        {items.map((item, index) => (
          <li className="review-item" key={`${item.title}-${index}`}>
            <div><span className="review-badge">{item.badge}</span> <strong>{item.title}</strong></div>
            <p>{item.body}</p>
          </li>
        ))}
        {!items.length && <li className="review-empty">No {title.toLowerCase()}.</li>}
      </ul>
    </div>
  );
}

function EmptyIssue() {
  return (
    <div className="empty-state">
      <p className="empty-title">No issue selected</p>
      <p className="empty-hint">Pick an issue from the list to inspect and edit it.</p>
    </div>
  );
}

function QueryError({ error }: { error: Error }) {
  return <p className="query-state react-error">{error.message}</p>;
}

function BrandMark() {
  return (
    <span className="brand-mark" aria-hidden="true">
      <svg viewBox="0 0 32 32" fill="none">
        <rect width="32" height="32" rx="8" fill="#4f46e5" />
        <path
          d="M11 8v16M21 8v16M8 13h16M8 19h16"
          stroke="#fff"
          strokeWidth="2.6"
          strokeLinecap="round"
        />
      </svg>
    </span>
  );
}

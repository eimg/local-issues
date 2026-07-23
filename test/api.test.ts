import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import request from "supertest";
import { openDatabase } from "../src/db.js";
import { createApp } from "../src/app.js";
import { WebhookDispatcher } from "../src/webhooks.js";
import { saveConfig } from "../src/config.js";

describe("acme-issues API", () => {
  let dataDir: string;
  let db: ReturnType<typeof openDatabase>;
  let app: ReturnType<typeof createApp>;
  let webhookCalls: { url: string; body: unknown }[];

  before(() => {
    dataDir = mkdtempSync(join(tmpdir(), "acme-issues-"));
    db = openDatabase(dataDir);
    saveConfig(db, {
      webhookUrl: "http://helix.test/runs",
      labelFilter: "trigger",
      commentTrigger: "/helix",
      webhookEnabled: true,
      baseUrl: "http://127.0.0.1:8320",
    });

    webhookCalls = [];
    const dispatcher = new WebhookDispatcher({
      db,
      fetchFn: async (url, init) => {
        webhookCalls.push({ url: String(url), body: JSON.parse(String(init?.body)) });
        return new Response(JSON.stringify({ ok: true }), { status: 202 });
      },
    });

    app = createApp({ db, dispatcher });
  });

  after(() => {
    db.close();
    rmSync(dataDir, { recursive: true, force: true });
  });

  it("browses local repositories and persists a validated default repository", async () => {
    const parent = join(dataDir, "repositories");
    const repository = join(parent, "acme-todo");
    mkdirSync(join(repository, ".git"), { recursive: true });
    mkdirSync(join(repository, "src"), { recursive: true });

    const browsed = await request(app)
      .get("/api/repositories/browse")
      .query({ path: parent })
      .expect(200);
    assert.equal(browsed.body.path, realpathSync(parent));
    assert.deepEqual(
      browsed.body.directories.map((entry: { name: string; isGitRepository: boolean }) => ({
        name: entry.name,
        isGitRepository: entry.isGitRepository,
      })),
      [{ name: "acme-todo", isGitRepository: true }],
    );

    const saved = await request(app)
      .patch("/api/config")
      .send({ defaultRepositoryPath: repository })
      .expect(200);
    assert.equal(saved.body.defaultRepositoryPath, realpathSync(repository));

    const loaded = await request(app).get("/api/config").expect(200);
    assert.equal(loaded.body.defaultRepositoryPath, realpathSync(repository));

    await request(app)
      .patch("/api/config")
      .send({ defaultRepositoryPath: "relative/repository" })
      .expect(400);
    await request(app)
      .patch("/api/config")
      .send({ defaultRepositoryPath: parent })
      .expect(400);
  });

  it("creates an issue and auto-triggers webhook when filter label present", async () => {
    webhookCalls.length = 0;
    const res = await request(app)
      .post("/api/issues")
      .send({ title: "Fix login", body: "Empty password returns 500", labels: ["trigger"] })
      .expect(201);

    assert.equal(res.body.issue.title, "Fix login");
    assert.deepEqual(res.body.issue.labels, ["trigger"]);
    assert.equal(webhookCalls.length, 1);
    assert.deepEqual(webhookCalls[0].body, {
      title: "Fix login",
      body: "Empty password returns 500",
      labels: ["trigger"],
      external: {
        trackerUrl: "http://127.0.0.1:8320",
        issueId: res.body.issue.id,
      },
    });
    assert.equal(res.body.delivery.success, true);
  });

  it("does not auto-trigger without filter label", async () => {
    webhookCalls.length = 0;
    const res = await request(app)
      .post("/api/issues")
      .send({ title: "Docs typo", labels: ["docs"] })
      .expect(201);

    assert.equal(webhookCalls.length, 0);
    assert.equal(res.body.delivery, null);
  });

  it("triggers webhook when filter label is added later", async () => {
    const created = await request(app)
      .post("/api/issues")
      .send({ title: "Later label", labels: ["bug"] })
      .expect(201);

    webhookCalls.length = 0;
    const updated = await request(app)
      .patch(`/api/issues/${created.body.issue.id}`)
      .send({ labels: ["bug", "trigger"] })
      .expect(200);

    assert.equal(webhookCalls.length, 1);
    assert.equal(updated.body.delivery.success, true);
  });

  it("manual trigger works for any open issue", async () => {
    const created = await request(app)
      .post("/api/issues")
      .send({ title: "Manual", labels: [] })
      .expect(201);

    webhookCalls.length = 0;
    const res = await request(app)
      .post(`/api/issues/${created.body.issue.id}/trigger`)
      .expect(200);

    assert.equal(webhookCalls.length, 1);
    assert.equal(res.body.delivery.success, true);
  });

  it("lists deliveries and supports remove/clear", async () => {
    const res = await request(app).get("/api/webhooks/deliveries").expect(200);
    assert.ok(Array.isArray(res.body));
    assert.ok(res.body.length > 0);

    const firstId = res.body[0].id as number;
    await request(app).delete(`/api/webhooks/deliveries/${firstId}`).expect(204);
    await request(app).delete(`/api/webhooks/deliveries/${firstId}`).expect(404);

    const afterOne = await request(app).get("/api/webhooks/deliveries").expect(200);
    assert.ok(!afterOne.body.some((d: { id: number }) => d.id === firstId));

    const cleared = await request(app).delete("/api/webhooks/deliveries").expect(200);
    assert.ok(cleared.body.deleted >= 0);

    const empty = await request(app).get("/api/webhooks/deliveries").expect(200);
    assert.equal(empty.body.length, 0);
  });

  it("supports full comment CRUD on an issue", async () => {
    const created = await request(app)
      .post("/api/issues")
      .send({ title: "With comments", labels: [] })
      .expect(201);

    const issueId = created.body.issue.id as number;

    const createdComment = await request(app)
      .post(`/api/issues/${issueId}/comments`)
      .send({ body: "First note", author: "alice" })
      .expect(201);

    assert.equal(createdComment.body.body, "First note");
    assert.equal(createdComment.body.author, "alice");
    assert.equal(createdComment.body.source, "user");
    assert.equal(createdComment.body.issueId, issueId);

    const listed = await request(app).get(`/api/issues/${issueId}/comments`).expect(200);
    assert.equal(listed.body.length, 1);
    assert.equal(listed.body[0].id, createdComment.body.id);

    const updated = await request(app)
      .patch(`/api/issues/${issueId}/comments/${createdComment.body.id}`)
      .send({ body: "Updated note" })
      .expect(200);

    assert.equal(updated.body.body, "Updated note");
    assert.equal(updated.body.author, "alice");

    await request(app)
      .delete(`/api/issues/${issueId}/comments/${createdComment.body.id}`)
      .expect(204);

    const afterDelete = await request(app).get(`/api/issues/${issueId}/comments`).expect(200);
    assert.equal(afterDelete.body.length, 0);
  });

  it("rejects invalid comment create/update and mismatched issue ids", async () => {
    const created = await request(app)
      .post("/api/issues")
      .send({ title: "Comment validation", labels: [] })
      .expect(201);
    const other = await request(app)
      .post("/api/issues")
      .send({ title: "Other issue", labels: [] })
      .expect(201);

    const issueId = created.body.issue.id as number;
    const otherId = other.body.issue.id as number;

    await request(app)
      .post(`/api/issues/${issueId}/comments`)
      .send({ body: "   " })
      .expect(400);

    const comment = await request(app)
      .post(`/api/issues/${issueId}/comments`)
      .send({ body: "Keep me" })
      .expect(201);

    await request(app)
      .patch(`/api/issues/${issueId}/comments/${comment.body.id}`)
      .send({ body: "" })
      .expect(400);

    await request(app)
      .patch(`/api/issues/${otherId}/comments/${comment.body.id}`)
      .send({ body: "Nope" })
      .expect(404);

    await request(app)
      .delete(`/api/issues/${otherId}/comments/${comment.body.id}`)
      .expect(404);

    await request(app).post("/api/issues/99999/comments").send({ body: "missing" }).expect(404);
  });

  it("marks issue in_progress on helix run.started and closes on run.completed", async () => {
    const created = await request(app)
      .post("/api/issues")
      .send({ title: "To progress", labels: ["trigger"] })
      .expect(201);

    const issueId = created.body.issue.id as number;
    const started = await request(app)
      .post("/api/webhooks/helix")
      .set("X-Helix-Event", "run.started")
      .send({
        event: "run.started",
        run: { id: "run-abc-123", status: "running", startedAt: Date.now() },
        issue: { id: issueId, title: "To progress" },
      })
      .expect(200);

    assert.equal(started.body.issue.status, "in_progress");
    assert.match(started.body.comment.body, /in progress/i);

    const completed = await request(app)
      .post("/api/webhooks/helix")
      .set("X-Helix-Event", "run.completed")
      .send({
        event: "run.completed",
        run: {
          id: "run-abc-123",
          status: "done",
          startedAt: Date.now() - 5000,
          finishedAt: Date.now(),
        },
        issue: { id: issueId, title: "To progress" },
      })
      .expect(200);

    assert.equal(completed.body.issue.status, "closed");
    assert.equal(completed.body.comment.author, "helix");
    assert.equal(completed.body.comment.source, "helix.webhook");
    assert.match(completed.body.comment.body, /Closed automatically/);
    assert.match(completed.body.comment.body, /run-abc/);
    assert.doesNotMatch(completed.body.comment.body, /Event:/);

    const comments = await request(app).get(`/api/issues/${issueId}/comments`).expect(200);
    assert.equal(comments.body.length, 2);
    assert.equal(comments.body[0].source, "helix.webhook");
    assert.equal(comments.body[1].source, "helix.webhook");

    const got = await request(app).get(`/api/issues/${issueId}`).expect(200);
    assert.equal(got.body.status, "closed");
  });

  it("sends /helix comments as linked continuations and reopens the issue", async () => {
    const created = await request(app)
      .post("/api/issues")
      .send({ title: "Continue me", body: "Original work", labels: ["trigger"] })
      .expect(201);
    const issueId = created.body.issue.id as number;

    await request(app)
      .post("/api/webhooks/helix")
      .set("X-Helix-Event", "run.completed")
      .send({
        event: "run.completed",
        run: { id: "root-run", status: "done", startedAt: 100, finishedAt: 200 },
        issue: { id: issueId, title: "Continue me" },
      })
      .expect(200);

    webhookCalls.length = 0;
    const comment = await request(app)
      .post(`/api/issues/${issueId}/comments`)
      .send({ body: "/helix also cover the regression case", author: "alice" })
      .expect(201);

    assert.equal(comment.body.issue.status, "open");
    assert.equal(comment.body.delivery.success, true);
    assert.equal(webhookCalls.length, 1);
    assert.equal(webhookCalls[0].url, "http://helix.test/runs/root-run/continuations");
    assert.deepEqual(webhookCalls[0].body, {
      instruction: "also cover the regression case",
      externalEventId: `comment:${comment.body.id}`,
      trigger: "issue.comment",
    });
  });

  it("reopen targets the latest completed Helix run", async () => {
    const created = await request(app)
      .post("/api/issues")
      .send({ title: "Reopen me", labels: ["trigger"] })
      .expect(201);
    const issueId = created.body.issue.id as number;

    await request(app).post("/api/webhooks/helix").set("X-Helix-Event", "run.completed").send({
      event: "run.completed",
      run: {
        id: "continuation-two",
        parentRunId: "root-one",
        rootRunId: "root-one",
        status: "done",
        startedAt: 300,
        finishedAt: 400,
      },
      issue: { id: issueId, title: "Reopen me" },
    }).expect(200);

    webhookCalls.length = 0;
    const reopened = await request(app)
      .patch(`/api/issues/${issueId}`)
      .send({ status: "open" })
      .expect(200);

    assert.equal(reopened.body.delivery.success, true);
    assert.equal(webhookCalls[0].url, "http://helix.test/runs/continuation-two/continuations");
    assert.equal((webhookCalls[0].body as { trigger: string }).trigger, "issue.reopened");
    assert.match(
      (webhookCalls[0].body as { externalEventId: string }).externalEventId,
      new RegExp(`^issue-reopened:${issueId}:`),
    );
  });

  it("ordinary comments do not trigger Helix", async () => {
    const created = await request(app)
      .post("/api/issues")
      .send({ title: "Just discussing", labels: [] })
      .expect(201);
    webhookCalls.length = 0;

    const comment = await request(app)
      .post(`/api/issues/${created.body.issue.id}/comments`)
      .send({ body: "This is only a note" })
      .expect(201);

    assert.equal(comment.body.delivery, null);
    assert.equal(webhookCalls.length, 0);
  });

  it("filters and paginates issue lists", async () => {
    const before = await request(app).get("/api/issues?limit=100&offset=0").expect(200);
    const baseTotal = before.body.total as number;

    const createdIds: number[] = [];
    for (let i = 0; i < 3; i++) {
      const res = await request(app)
        .post("/api/issues")
        .send({ title: `Paged ${i}`, labels: i === 1 ? ["docs"] : ["bug"] })
        .expect(201);
      createdIds.push(res.body.issue.id);
    }

    await request(app)
      .patch(`/api/issues/${createdIds[0]}`)
      .send({ status: "in_progress" })
      .expect(200);

    const byStatus = await request(app).get("/api/issues?status=in_progress").expect(200);
    assert.ok(byStatus.body.items.every((issue: { status: string }) => issue.status === "in_progress"));
    assert.ok(byStatus.body.items.some((issue: { id: number }) => issue.id === createdIds[0]));

    const byLabel = await request(app).get("/api/issues?label=docs").expect(200);
    assert.ok(byLabel.body.items.every((issue: { labels: string[] }) => issue.labels.includes("docs")));
    assert.ok(byLabel.body.items.some((issue: { id: number }) => issue.id === createdIds[1]));

    const page = await request(app).get("/api/issues?limit=2&offset=0").expect(200);
    assert.equal(page.body.limit, 2);
    assert.equal(page.body.offset, 0);
    assert.equal(page.body.items.length, 2);
    assert.equal(page.body.total, baseTotal + 3);

    const next = await request(app).get("/api/issues?limit=2&offset=2").expect(200);
    assert.equal(next.body.offset, 2);
    assert.ok(next.body.items.length >= 1);
    assert.notEqual(next.body.items[0].id, page.body.items[0].id);
  });

  it("manages local PR review lifecycle and ignores stale SHA decisions", async () => {
    const issue = await request(app)
      .post("/api/issues")
      .send({ title: "Local PR issue", body: "Acceptance criteria", labels: [] })
      .expect(201);
    const issueId = issue.body.issue.id as number;

    const created = await request(app)
      .post("/api/pull-requests")
      .send({
        issueId,
        title: "Implement local PR",
        description: "Review this exact change",
        repositoryPath: "/tmp/example-repo",
        baseBranch: "main",
        baseSha: "base-1",
        headBranch: "feature/local-pr",
        headSha: "head-1",
        author: "alice",
        origin: "external",
      })
      .expect(201);
    const pullRequestId = created.body.id as number;
    assert.equal(created.body.status, "draft");

    webhookCalls.length = 0;
    const requested = await request(app)
      .post(`/api/pull-requests/${pullRequestId}/review`)
      .expect(202);
    assert.equal(requested.body.delivery.success, true);
    assert.equal(webhookCalls[0].url, "http://helix.test/pr-reviews");
    assert.equal(
      (webhookCalls[0].body as { externalEventId: string }).externalEventId,
      `pull-request:${pullRequestId}:head:head-1`,
    );

    await request(app).post("/api/webhooks/helix").set("X-Helix-Event", "pr.review.started").send({
      event: "pr.review.started",
      review: {
        id: "review-one",
        status: "running",
        headSha: "head-1",
        startedAt: 100,
      },
      pullRequest: { id: pullRequestId },
    }).expect(200);

    await request(app).post("/api/webhooks/helix").set("X-Helix-Event", "pr.review.completed").send({
      event: "pr.review.completed",
      review: {
        id: "review-one",
        status: "completed",
        headSha: "head-1",
        startedAt: 100,
        finishedAt: 200,
        decision: "ready_to_merge",
        summary: "reviewer and verifier passed",
        findings: [],
        checks: [{ name: "npm test", status: "passed", summary: "all passed" }],
      },
      pullRequest: { id: pullRequestId },
    }).expect(200);

    const ready = await request(app).get(`/api/pull-requests/${pullRequestId}`).expect(200);
    assert.equal(ready.body.status, "ready_to_merge");
    assert.equal(ready.body.reviews.length, 1);

    const updatedHead = await request(app)
      .patch(`/api/pull-requests/${pullRequestId}`)
      .send({ headSha: "head-2" })
      .expect(200);
    assert.equal(updatedHead.body.status, "draft");
    assert.equal(updatedHead.body.activeReviewRunId, undefined);

    const stale = await request(app).post("/api/webhooks/helix").send({
      event: "pr.review.completed",
      review: {
        id: "late-old-review",
        status: "completed",
        headSha: "head-1",
        startedAt: 300,
        finishedAt: 400,
        decision: "ready_to_merge",
        summary: "stale",
      },
      pullRequest: { id: pullRequestId },
    }).expect(200);
    assert.equal(stale.body.stale, true);
    assert.equal(stale.body.pullRequest.status, "draft");

    await request(app).patch(`/api/pull-requests/${pullRequestId}`)
      .send({ status: "merged" })
      .expect(409);
  });

  it("keeps linked issue open for PR review and closes only after human merge record", async () => {
    const issue = await request(app)
      .post("/api/issues")
      .send({ title: "Human merge boundary", labels: [] })
      .expect(201);
    const issueId = issue.body.issue.id as number;
    const pullRequest = await request(app).post("/api/pull-requests").send({
      issueId,
      title: "Ready change",
      repositoryPath: "/tmp/example-repo",
      baseBranch: "main",
      baseSha: "base",
      headBranch: "feature/ready",
      headSha: "head",
      author: "helix",
      origin: "helix",
    }).expect(201);
    const pullRequestId = pullRequest.body.id as number;

    await request(app).post("/api/webhooks/helix").send({
      event: "run.completed",
      run: { id: "implementation-run", status: "done", startedAt: 1, finishedAt: 2 },
      issue: { id: issueId, title: "Human merge boundary" },
    }).expect(200);
    const inProgress = await request(app).get(`/api/issues/${issueId}`).expect(200);
    assert.equal(inProgress.body.status, "in_progress");

    await request(app).post("/api/webhooks/helix").send({
      event: "pr.review.completed",
      review: {
        id: "review-ready",
        status: "completed",
        headSha: "head",
        startedAt: 3,
        finishedAt: 4,
        decision: "ready_to_merge",
        summary: "ready",
      },
      pullRequest: { id: pullRequestId },
    }).expect(200);

    await request(app).patch(`/api/pull-requests/${pullRequestId}`)
      .send({ status: "merged", mergeCommitSha: "merge-sha" })
      .expect(200);
    const closed = await request(app).get(`/api/issues/${issueId}`).expect(200);
    assert.equal(closed.body.status, "closed");
  });

  it("serves React as the primary interface with the legacy interface available", async () => {
    const page = await request(app).get("/").expect(200);
    assert.match(page.text, /id="root"/);

    const legacy = await request(app).get("/legacy").expect(200);
    assert.match(legacy.text, /Pull requests/);
    assert.match(legacy.text, /id="pr-list"/);
    assert.match(legacy.text, /id="request-review-btn"/);
    assert.match(legacy.text, /id="browse-default-repository-btn"/);
    assert.match(legacy.text, /id="repository-picker-dialog"/);
    assert.match(legacy.text, /data-close-dialog type="button">Cancel/);
    const script = await request(app).get("/app.js").expect(200);
    assert.match(script.text, /currentHeadReviewed/);
    assert.match(script.text, /Review again/);
    assert.match(script.text, /requestReviewBtn\.classList\.toggle\("hidden", reviewClosed\)/);

    const reactPreview = await request(app).get("/react").expect(302);
    assert.equal(reactPreview.headers.location, "/");
  });
});

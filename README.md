# Acme Issues

A small, self-contained issue tracker for local development. Issues live in SQLite; outbound webhooks POST JSON to any URL you configure.

Pairs naturally with [Helix](https://github.com/eimg/helix) for local agent-driven workflows — no GitHub account required.

## Acme development testbed

Acme Issues is one of four related projects. They remain separate products with separate responsibilities.

| Project | Role |
|---|---|
| **[Primer](https://github.com/eimg/primer)** | Knowledge product and fictional Acme evidence corpus; not currently part of the runtime loop. |
| **[Helix](https://github.com/eimg/helix)** | Agent workflow control plane that receives work and orchestrates changes. |
| **[Acme Issues](https://github.com/eimg/acme-issues)** | Local issue tracker and webhook harness that triggers Helix and receives callbacks. |
| **[Acme Todo](https://github.com/eimg/acme-todo)** | Disposable target application used for agent implementation and verification. |

Typical exercise: Acme Issues sends a work item to Helix, which works on Acme Todo. Primer develops the separate knowledge and retrieval side of the same fictional Acme context.

![Acme Issues](https://i.imgur.com/icyJMPP.jpeg)

## Companion project: [Helix](https://github.com/eimg/helix)

This tracker is built to pair with **[Helix](https://github.com/eimg/helix)** — an agent orchestration system that runs specialist coding agents (planner, dev, verifier, …) against your repo.

| Project | Role |
|---------|------|
| **acme-issues** (this repo) | Create and track issues locally; fire webhooks when labeled issues appear |
| **[Helix](https://github.com/eimg/helix)** | Receives `POST /runs`, orchestrates agents, optionally callbacks on completion |

```
acme-issues (issue + label) ──POST──► Helix /runs ──► specialist agents
       ▲                                        │
       └──────── run.completed callback ────────┘
```

No GitHub account or `gh` CLI required for this loop.

## Requirements

- Node.js ≥ 20

## Install

```bash
git clone https://github.com/eimg/acme-issues.git
cd acme-issues
npm install
npm run build    # optional; dev mode compiles on the fly
npm link         # optional; exposes `acme-issues` CLI
```

## Getting started

### Standalone (tracker only)

```bash
npm run dev
# → http://127.0.0.1:8320/
```

Open **Settings** to set your webhook URL and label filter, then create issues from the UI or API.

### Recommended: Helix integration

Run both services side by side.

**Terminal 1 — Helix on your target repo**

```bash
git clone https://github.com/eimg/helix.git
cd helix && npm install && npm run build && npm link

cd your-project
helix init --preset typescript
cp .env.example .env   # set OPENROUTER_API_KEY + HELIX_MODEL
helix serve
# → http://127.0.0.1:8319/
```

**Terminal 2 — acme-issues**

```bash
git clone https://github.com/eimg/acme-issues.git
cd acme-issues && npm install
npm run dev
# → http://127.0.0.1:8320/
```

**Configure Settings** (`http://127.0.0.1:8320/`):

| Setting | Value |
|---------|-------|
| Webhook URL | `http://127.0.0.1:8319/runs` |
| Label filter | `trigger` (default) |
| Continuation comment command | `/helix` (default) |
| Webhooks enabled | on |

Create an open issue with the `trigger` label (or add the label to an existing issue). acme-issues delivers a webhook; Helix starts a run. Watch progress in the Helix run console. On completion, Helix POSTs back and this tracker marks the issue **closed** with a Helix comment.

After completion, reopen the issue or add a comment such as `/helix also cover the regression case`. The tracker uses the latest completed Helix run recorded from callbacks and sends a linked continuation request. Ordinary comments do not trigger Helix.

Full Helix setup and config: [github.com/eimg/helix](https://github.com/eimg/helix#getting-started).

## Default configuration

| Setting | Default |
|---------|---------|
| Port | `8320` |
| Webhook URL | *(empty — configure in Settings)* |
| Label filter | `trigger` |
| Continuation comment command | `/helix` |
| Webhooks enabled | `false` |
| Data directory | `./data/` (override with `ACME_ISSUES_DATA_DIR`) |

## Webhook behavior

When webhooks are enabled and a URL is set, delivery fires on:

1. **Issue created** — open issue includes the label filter
2. **Label added** — filter label added to an open issue
3. **Issue reopened** — if a completed Helix run is known, continue it; otherwise start an initial run
4. **Command comment** — a user comment beginning with the configured command continues the latest completed run
5. **Manual** — **Send webhook** button or `POST /api/issues/:id/trigger`

Outbound payload (includes correlation for Helix callbacks):

```json
{
  "title": "Fix login",
  "body": "Empty password returns 500",
  "labels": ["trigger", "bug"],
  "external": {
    "trackerUrl": "http://127.0.0.1:8320",
    "issueId": 7
  }
}
```

Headers: `X-Issues-Issue-Id`, `X-Issues-Source`, `X-Issues-Reason`.

Failed deliveries retry up to 3 times. All attempts appear in the **Webhook deliveries** panel.

## Helix callbacks (inbound)

Helix can notify this tracker as a run progresses. Endpoint: `POST /api/webhooks/helix`

**`run.completed`** (sent by Helix today when a run finishes):

```
POST /api/webhooks/helix
X-Helix-Event: run.completed

{
  "event": "run.completed",
  "run": { "id": "...", "status": "done", "startedAt": ..., "finishedAt": ... },
  "issue": { "id": 7, "title": "Fix login" }
}
```

→ issue status `closed` + Helix comment

The callback may include `parentRunId` and `rootRunId`. acme-issues stores this lineage and uses the newest completed run when it delivers a reopen or command-comment continuation.

**`run.started`** (supported by this tracker; Helix does not send it yet):

```
POST /api/webhooks/helix
X-Helix-Event: run.started

{
  "event": "run.started",
  "run": { "id": "...", "status": "running", "startedAt": ... },
  "issue": { "id": 7, "title": "Fix login" }
}
```

→ issue status `in_progress` + Helix comment

Callbacks use no auth — intended for local development.

## API

| Method | Path | Purpose |
|--------|------|---------|
| `GET` | `/api/issues` | List issues (`?status=open\|in_progress\|closed`, `?label=`, `?limit=`, `?offset=`) |
| `POST` | `/api/issues` | Create issue |
| `GET` | `/api/issues/:id` | Get issue |
| `PATCH` | `/api/issues/:id` | Update issue |
| `DELETE` | `/api/issues/:id` | Delete issue |
| `GET` | `/api/issues/:id/comments` | List comments |
| `POST` | `/api/issues/:id/comments` | Create comment (`body` required; optional `author`) |
| `PATCH` | `/api/issues/:issueId/comments/:commentId` | Update comment (`body` and/or `author`) |
| `DELETE` | `/api/issues/:issueId/comments/:commentId` | Delete comment |
| `POST` | `/api/issues/:id/trigger` | Manual webhook delivery |
| `GET` | `/api/webhooks/deliveries` | Delivery log |
| `DELETE` | `/api/webhooks/deliveries/:id` | Remove one delivery log |
| `DELETE` | `/api/webhooks/deliveries` | Clear all delivery logs |
| `GET` | `/api/config` | Read settings |
| `PATCH` | `/api/config` | Update settings |

`GET /api/issues` returns `{ items, total, limit, offset }` (default `limit` 25).

Issue status values: `open`, `in_progress`, `closed`.

## Development

```bash
npm run dev -- --port 8320
npm test
npm run build
```

## License

[MIT](./LICENSE)

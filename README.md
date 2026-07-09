# Local Issues

A small, self-contained issue tracker for local development. Issues are stored in SQLite; outbound webhooks POST JSON to any URL you configure.

## Quick start

```bash
cd ~/Desktop/local-issues
npm install
npm run dev
# → http://127.0.0.1:8320/
```

Open **Settings** to set your webhook URL and label filter, then create issues from the UI or API.

## Default configuration

| Setting | Default |
|---------|---------|
| Port | `8320` |
| Webhook URL | *(empty — configure in Settings)* |
| Label filter | `trigger` |
| Webhooks enabled | `false` |
| Data directory | `./data/` (override with `LOCAL_ISSUES_DATA_DIR`) |

## Webhook behavior

When webhooks are enabled and a URL is set, delivery fires on:

1. **Issue created** — open issue includes the label filter
2. **Label added** — filter label added to an open issue
3. **Issue reopened** — open issue still has the filter label
4. **Manual** — **Send webhook** button or `POST /api/issues/:id/trigger`

Payload:

```json
{
  "title": "Fix login",
  "body": "Empty password returns 500",
  "labels": ["trigger", "bug"]
}
```

Failed deliveries retry up to 3 times. All attempts appear in the **Webhook deliveries** panel.

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

## Webhook integration

Point the webhook URL at any HTTP endpoint that accepts `POST` with a JSON body. The receiver defines what the payload means — this tracker only stores issues and delivers events.

### Progress callbacks (Helix → Local Issues)

Helix can notify this tracker as a run progresses:

```
POST /api/webhooks/helix
X-Helix-Event: run.started

{
  "event": "run.started",
  "run": { "id": "...", "status": "running", "startedAt": ... },
  "issue": { "id": 7, "title": "Fix login" }
}
```

```
POST /api/webhooks/helix
X-Helix-Event: run.completed

{
  "event": "run.completed",
  "run": { "id": "...", "status": "done", "startedAt": ..., "finishedAt": ... },
  "issue": { "id": 7, "title": "Fix login" }
}
```

- `run.started` → status `in_progress` + Helix comment
- `run.completed` → status `closed` + Helix comment

Outbound webhooks include correlation for this round-trip:

```json
{
  "title": "...",
  "body": "...",
  "labels": ["trigger"],
  "external": {
    "trackerUrl": "http://127.0.0.1:8320",
    "issueId": 7
  }
}
```

Headers: `X-Issues-Issue-Id`, `X-Issues-Source` (same correlation, header-style).

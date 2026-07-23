# Acme Issues agent guide

Acme Issues is the local issue and pull-request management surface for Helix. It is not the target application Helix should modify during an end-to-end workflow test.

## Related projects

| Project | Local path | Responsibility |
|---|---|---|
| Primer | `~/Desktop/acme/primer` | Knowledge product and fictional Acme evidence corpus; not currently part of the runtime loop. |
| Helix | `~/Desktop/acme/helix` | Agent workflow control plane that receives work and orchestrates changes. |
| Acme Issues | `~/Desktop/acme/acme-issues` | Local issue and PR management surface that triggers Helix and receives callbacks. |
| Acme Todo | `~/Desktop/acme/acme-todo` | Disposable target application used for agent implementation and verification. |

The normal local flow is Acme issue → Helix implementation → Acme local PR → Helix independent PR review → human merge record. Primer shares the fictional Acme context but is not currently in that runtime path.

## Working rules

- Preserve SQLite issue, comment, delivery, Helix-run lineage, local PR, and review-revision behavior.
- Keep webhook retries and continuation event identities deterministic.
- PR readiness is valid only for the current stored head SHA. Retain stale review history without applying its decision.
- Acme Issues is the human-facing PR UI; Helix owns specialist execution and readiness policy. Acme may record a human merge but must not auto-merge Git.
- Do not add GitHub as a requirement for the local webhook loop.
- Keep callbacks unauthenticated only while the server remains a local-development harness.
- Before committing cross-cutting changes, run `npm test` and `npm run build`.

# Acme Issues agent guide

Acme Issues is the local issue-tracker and webhook test harness for Helix. It is not the application Helix should modify during an end-to-end workflow test.

## Related projects

| Project | Local path | Responsibility |
|---|---|---|
| Primer | `~/Desktop/acme/primer` | Knowledge product and fictional Acme evidence corpus; not currently part of the runtime loop. |
| Helix | `~/Desktop/acme/helix` | Agent workflow control plane that receives work and orchestrates changes. |
| Acme Issues | `~/Desktop/acme/acme-issues` | Local issue tracker and webhook harness that triggers Helix and receives callbacks. |
| Acme Todo | `~/Desktop/acme/acme-todo` | Disposable target application used for agent implementation and verification. |

The normal local flow is Acme Issues → Helix → Acme Todo, followed by a Helix completion callback to Acme Issues. Primer shares the fictional Acme context but is not currently in that runtime path.

## Working rules

- Preserve SQLite issue, comment, delivery, and Helix-run lineage behavior.
- Keep webhook retries and continuation event identities deterministic.
- Do not add GitHub as a requirement for the local webhook loop.
- Keep callbacks unauthenticated only while the server remains a local-development harness.
- Before committing cross-cutting changes, run `npm test` and `npm run build`.

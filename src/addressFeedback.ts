/**
 * Build a Helix continuation instruction from a failed local PR review.
 */
import type { PullRequest, PullRequestReview } from "./types.js";

const MAX_INSTRUCTION = 7_500;
const MAX_FINDINGS = 12;
const MAX_CHECKS = 12;
const MAX_FIELD = 500;

export function buildAddressFeedbackInstruction(
  pullRequest: PullRequest,
  review: PullRequestReview,
): string {
  const decision = review.decision ?? "changes_requested";
  const parts = [
    "Address the latest local PR review feedback on the existing implementation attempt.",
    "Prefer fixing the current feature branch / PR head rather than starting unrelated work.",
    "",
    `Pull request: #${pullRequest.id} — ${pullRequest.title}`,
    `Decision: ${decision}`,
    `Head: ${pullRequest.headBranch} @ ${pullRequest.headSha}`,
    `Base: ${pullRequest.baseBranch} @ ${pullRequest.baseSha}`,
    "",
    "## Review summary",
    truncate(review.summary.trim() || "(no summary)", MAX_FIELD),
  ];

  const findings = review.findings.slice(0, MAX_FINDINGS);
  if (findings.length > 0) {
    parts.push("", "## Findings");
    for (const finding of findings) {
      parts.push(
        `- [${finding.severity}] ${truncate(finding.title, 160)}: ${truncate(finding.details, MAX_FIELD)}`,
      );
    }
    if (review.findings.length > findings.length) {
      parts.push(`- …and ${review.findings.length - findings.length} more finding(s)`);
    }
  }

  const failingChecks = review.checks
    .filter((check) => check.status !== "passed")
    .slice(0, MAX_CHECKS);
  if (failingChecks.length > 0) {
    parts.push("", "## Failed / blocked checks");
    for (const check of failingChecks) {
      parts.push(
        `- [${check.status}] ${truncate(check.name, 120)}: ${truncate(check.summary, MAX_FIELD)}`,
      );
    }
  }

  parts.push(
    "",
    "Update the implementation to resolve the blocking feedback, keep changes scoped to this PR, and leave evidence that the concerns were addressed.",
  );

  return truncate(parts.join("\n"), MAX_INSTRUCTION);
}

function truncate(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, max).trimEnd()}…`;
}

import { execFile } from "node:child_process";
import { resolve } from "node:path";
import { promisify } from "node:util";
import type { PullRequest } from "./types.js";

const execFileP = promisify(execFile);
const MAX_DIFF_CHARS = 500_000;

export async function readPullRequestDiff(
  pullRequest: PullRequest,
): Promise<{ diff: string; truncated: boolean }> {
  const cwd = resolve(pullRequest.repositoryPath);
  const { stdout } = await execFileP(
    "git",
    ["diff", "--no-ext-diff", "--unified=3", `${pullRequest.baseSha}...${pullRequest.headSha}`],
    { cwd, maxBuffer: 5 * 1024 * 1024 },
  );
  if (stdout.length <= MAX_DIFF_CHARS) return { diff: stdout, truncated: false };
  return {
    diff: `${stdout.slice(0, MAX_DIFF_CHARS)}\n\n[diff truncated by Acme Issues]\n`,
    truncated: true,
  };
}

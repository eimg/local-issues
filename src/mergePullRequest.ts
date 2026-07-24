import { execFile } from "node:child_process";
import { resolve } from "node:path";
import { promisify } from "node:util";
import type { PullRequest } from "./types.js";

const execFileP = promisify(execFile);

export interface MergeCommandSnippet {
  cwd: string;
  shell: string;
  lines: string[];
}

export interface LocalMergeResult {
  mergeCommitSha: string;
  baseBranch: string;
  headSha: string;
}

/**
 * Human-initiated local Git merge of a reviewed head into its base branch.
 * Never called automatically — only from an explicit Merge API/UI action.
 */
export async function mergePullRequestLocally(
  pullRequest: PullRequest,
): Promise<LocalMergeResult> {
  const cwd = resolve(pullRequest.repositoryPath);
  await assertRepository(cwd);

  const dirty = await git(cwd, ["status", "--porcelain"]);
  if (dirty) {
    throw new Error("Repository working tree is not clean; commit or stash local changes before merging");
  }

  await git(cwd, ["rev-parse", "--verify", `${pullRequest.headSha}^{commit}`]);

  if (await refExists(cwd, pullRequest.headBranch)) {
    const branchTip = await git(cwd, ["rev-parse", "--verify", `${pullRequest.headBranch}^{commit}`]);
    if (branchTip !== pullRequest.headSha) {
      throw new Error(
        `Head branch ${pullRequest.headBranch} no longer points at the reviewed SHA ${pullRequest.headSha.slice(0, 8)}`,
      );
    }
  }

  const previousRef = await git(cwd, ["rev-parse", "--abbrev-ref", "HEAD"]);
  let merged = false;
  try {
    await git(cwd, ["checkout", "--quiet", pullRequest.baseBranch]);
    const message = `Merge local PR #${pullRequest.id}: ${pullRequest.title}`.slice(0, 120);
    try {
      await git(cwd, ["merge", "--no-ff", "-m", message, pullRequest.headSha]);
    } catch (error) {
      try {
        await git(cwd, ["merge", "--abort"]);
      } catch {
        // Ignore abort failures when merge never started.
      }
      throw new Error(`Git merge failed: ${formatGitError(error)}`);
    }
    merged = true;
    const mergeCommitSha = await git(cwd, ["rev-parse", "HEAD"]);
    return {
      mergeCommitSha,
      baseBranch: pullRequest.baseBranch,
      headSha: pullRequest.headSha,
    };
  } finally {
    if (!merged && previousRef && previousRef !== "HEAD") {
      try {
        await git(cwd, ["checkout", "--quiet", previousRef]);
      } catch {
        // Leave the repo where Git stopped; the merge error is the important signal.
      }
    }
  }
}

/** Shell commands a human can paste if they prefer to merge outside Acme Issues. */
export function buildMergeCommandSnippet(
  pullRequest: PullRequest,
  repositoryPath = pullRequest.repositoryPath,
): MergeCommandSnippet {
  const cwd = resolve(repositoryPath);
  const message = `Merge local PR #${pullRequest.id}: ${pullRequest.title}`
    .replaceAll('"', '\\"')
    .slice(0, 120);
  const lines = [
    `cd ${shellQuote(cwd)}`,
    `git checkout ${shellQuote(pullRequest.baseBranch)}`,
    `git merge --no-ff ${pullRequest.headSha} -m "${message}"`,
  ];
  return {
    cwd,
    shell: lines.join(" && \\\n  "),
    lines,
  };
}

export async function isGitWorkingTree(repositoryPath: string): Promise<boolean> {
  try {
    const cwd = resolve(repositoryPath);
    const inside = await git(cwd, ["rev-parse", "--is-inside-work-tree"]);
    return inside === "true";
  } catch {
    return false;
  }
}

async function assertRepository(cwd: string): Promise<void> {
  let inside: string;
  try {
    inside = await git(cwd, ["rev-parse", "--is-inside-work-tree"]);
  } catch {
    throw new Error(`Repository path is not a Git working tree: ${cwd}`);
  }
  if (inside !== "true") {
    throw new Error(`Repository path is not a Git working tree: ${cwd}`);
  }
}

async function refExists(cwd: string, ref: string): Promise<boolean> {
  try {
    await git(cwd, ["rev-parse", "--verify", `${ref}^{commit}`]);
    return true;
  } catch {
    return false;
  }
}

function shellQuote(value: string): string {
  if (/^[A-Za-z0-9_./:@%-]+$/.test(value)) return value;
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

function formatGitError(error: unknown): string {
  if (!(error instanceof Error)) return String(error);
  const err = error as Error & { stderr?: string | Buffer };
  const stderr = typeof err.stderr === "string"
    ? err.stderr
    : Buffer.isBuffer(err.stderr)
      ? err.stderr.toString("utf8")
      : "";
  return (stderr.trim() || err.message).trim();
}

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFileP("git", args, {
    cwd,
    maxBuffer: 5 * 1024 * 1024,
  });
  return stdout.trim();
}

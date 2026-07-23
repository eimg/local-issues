import { readdir, realpath, stat } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";

export interface RepositoryDirectory {
  name: string;
  path: string;
  isGitRepository: boolean;
}

export interface RepositoryBrowseResult {
  path: string;
  parent?: string;
  isGitRepository: boolean;
  directories: RepositoryDirectory[];
}

export async function browseRepositoryDirectories(inputPath: string): Promise<RepositoryBrowseResult> {
  if (!isAbsolute(inputPath)) {
    throw new Error("Repository browser path must be absolute");
  }

  const path = await canonicalDirectory(inputPath);
  const entries = await readdir(path, { withFileTypes: true });
  const directoryEntries = entries
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith("."))
    .sort((a, b) => a.name.localeCompare(b.name));
  const directories = await Promise.all(
    directoryEntries.map(async (entry) => {
      const childPath = join(path, entry.name);
      return {
        name: entry.name,
        path: childPath,
        isGitRepository: await isGitRepositoryRoot(childPath),
      };
    }),
  );
  const parent = dirname(path);

  return {
    path,
    parent: parent === path ? undefined : parent,
    isGitRepository: await isGitRepositoryRoot(path),
    directories,
  };
}

export async function validateRepositoryPath(inputPath: string): Promise<string> {
  if (!isAbsolute(inputPath)) {
    throw new Error("Default repository path must be absolute");
  }
  const path = await canonicalDirectory(inputPath);
  if (!(await isGitRepositoryRoot(path))) {
    throw new Error("Default repository path must point to a Git repository root");
  }
  return path;
}

async function canonicalDirectory(inputPath: string): Promise<string> {
  const candidate = resolve(inputPath);
  const info = await stat(candidate);
  if (!info.isDirectory()) throw new Error("Path is not a directory");
  return realpath(candidate);
}

async function isGitRepositoryRoot(path: string): Promise<boolean> {
  try {
    await stat(join(path, ".git"));
    return true;
  } catch {
    return false;
  }
}

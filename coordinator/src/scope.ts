/**
 * Scope resolution — spec §5.3.
 * Project is a logical identifier; roots/repos/folders are evidence.
 * Order: explicit declaration > repository identity > canonical workspace path.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createHash } from "node:crypto";

export function resolveProject(explicit: string | null | undefined, roots: string[]): string {
  if (explicit && explicit.trim().length > 0) return `prj:${explicit.trim()}`;

  const root = roots[0];
  if (root) {
    const path = fileUriToPath(root);
    const repo = repoIdentity(path);
    if (repo) return `repo:${repo}`;
    return `path:${hash(resolve(path))}`;
  }

  // No workspace at all — spec §5.3 requires explicit declaration; callers
  // hitting this get their own isolated scope (ambiguity → more isolated).
  return `isolated:${hash(String(Math.random()) + Date.now())}`;
}

function fileUriToPath(uri: string): string {
  if (uri.startsWith("file://")) {
    try {
      return decodeURIComponent(new URL(uri).pathname);
    } catch {
      return uri;
    }
  }
  return uri;
}

/** Normalized VCS remote identity, so clones/worktrees/CI checkouts co-resolve. */
function repoIdentity(path: string): string | null {
  // Direct repo, then worktree indirection (.git file with "gitdir: ..." line).
  for (const candidate of [`${path}/.git/config`, gitdirConfig(path)]) {
    if (!candidate) continue;
    try {
      const config = readFileSync(candidate, "utf8");
      const m = config.match(/\[remote "origin"\][^[]*?url\s*=\s*(.+)/);
      if (m) return hash(normalizeRemote(m[1].trim()));
    } catch {
      /* not a repo or unreadable — fall through */
    }
  }
  return null;
}

function gitdirConfig(path: string): string | null {
  try {
    const f = readFileSync(`${path}/.git`, "utf8");
    const m = f.match(/gitdir:\s*(.+)/);
    if (!m) return null;
    // worktree gitdir points at .git/worktrees/<name>; commondir holds the real .git
    const gitdir = resolve(path, m[1].trim());
    try {
      const common = readFileSync(`${gitdir}/commondir`, "utf8").trim();
      return `${resolve(gitdir, common)}/config`;
    } catch {
      return `${gitdir}/config`;
    }
  } catch {
    return null;
  }
}

function normalizeRemote(url: string): string {
  return url
    .replace(/^git@([^:]+):/, "https://$1/")
    .replace(/\.git$/, "")
    .toLowerCase();
}

function hash(s: string): string {
  return createHash("sha256").update(s).digest("hex").slice(0, 16);
}

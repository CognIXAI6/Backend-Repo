import { execSync } from 'child_process';

/**
 * Best-effort git SHA resolution. There's no CI pipeline in this repo that
 * injects a build SHA env var, so fall back to reading it from git directly —
 * which itself may not be available if the deployed artifact is a bare
 * `dist/` without `.git`. Resolved once at module load, not per-request.
 */
function resolveGitSha(): string {
  const envSha = process.env.GIT_SHA || process.env.COMMIT_SHA;
  if (envSha) return envSha;

  try {
    return execSync('git rev-parse --short HEAD', { stdio: ['ignore', 'pipe', 'ignore'] })
      .toString()
      .trim();
  } catch {
    return 'unknown';
  }
}

export const GIT_SHA = resolveGitSha();
export const PROCESS_STARTED_AT = new Date().toISOString();

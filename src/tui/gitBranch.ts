import { execFileNoThrow } from "../utils/execFileNoThrow.js";

export type GitBranchResolver = (cwd: string) => Promise<string | undefined>;

type GitCommandRunner = typeof execFileNoThrow;

export async function currentGitBranch(cwd: string, run: GitCommandRunner = execFileNoThrow): Promise<string | undefined> {
  const result = await run("git", ["branch", "--show-current"], { cwd, timeout: 3_000 });
  if (result.code !== 0) return undefined;
  return result.stdout.trim() || undefined;
}

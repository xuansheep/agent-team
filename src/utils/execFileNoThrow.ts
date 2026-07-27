import { execFile } from "node:child_process";

export function execFileNoThrow(
  file: string,
  args: string[],
  options: { input?: string; timeout?: number; useCwd?: boolean; cwd?: string } = {}
): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = execFile(
      file,
      args,
      {
        cwd: options.cwd ?? (options.useCwd === false ? undefined : process.cwd()),
        timeout: options.timeout,
        windowsHide: true
      },
      (error, stdout, stderr) => {
        const rawCode = (error as NodeJS.ErrnoException | null)?.code;
        const code = typeof rawCode === "number" ? rawCode : error ? 1 : 0;
        resolve({ code, stdout, stderr });
      }
    );
    if (options.input) {
      child.stdin?.end(options.input);
    }
  });
}

import { launchTui } from "../tui/launchTui.js";

export type TuiLauncher = (options: { cwd: string }) => Promise<void>;

export function shouldLaunchTui(_argv: string[]): boolean {
  return true;
}

export async function dispatchCli(_argv = process.argv, launcher: TuiLauncher = launchTui): Promise<void> {
  await launcher({ cwd: process.cwd() });
}

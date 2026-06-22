import { createProgram } from "./program.js";
import { launchTui } from "../tui/launchTui.js";

export type TuiLauncher = (options: { cwd: string }) => Promise<void>;

export function shouldLaunchTui(argv: string[]): boolean {
  return argv.slice(2).length === 0;
}

export async function dispatchCli(argv = process.argv, launcher: TuiLauncher = launchTui): Promise<void> {
  if (shouldLaunchTui(argv)) {
    await launcher({ cwd: process.cwd() });
    return;
  }

  createProgram().parse(argv);
}

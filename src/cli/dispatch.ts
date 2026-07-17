import { launchTui } from "../tui/launchTui.js";

export type TuiLauncher = (options: { cwd: string }) => Promise<void>;


export async function dispatchCli(_argv = process.argv, launcher: TuiLauncher = launchTui): Promise<void> {
  await launcher({ cwd: process.cwd() });
}

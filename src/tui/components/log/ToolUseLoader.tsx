import type { TuiToolLogMessage } from "../../logTypes.js";
import { LogStatusDot } from "./LogStatusDot.js";

export function ToolUseLoader({ status }: { status: TuiToolLogMessage["status"] }) {
  const tone = status === "failed" ? "red" : status === "completed" ? "green" : "deepGray";
  return <LogStatusDot tone={tone} blinking={status === "running"} />;
}

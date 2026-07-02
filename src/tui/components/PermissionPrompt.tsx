import { TuiPermissionRequestState } from "../state.js";
import { ChoicePrompt } from "./ChoicePrompt.js";

export function PermissionPrompt({
  request,
  onResolve
}: {
  request?: TuiPermissionRequestState;
  onResolve: (requestId: string, decision: "allow_once" | "deny_once") => void;
}) {
  if (!request) return null;
  return (
    <ChoicePrompt
      title="Permission required"
      detail={`${request.tool} ${request.specifier}`}
      defaultValue="allow_once"
      options={[
        { label: "Allow once", value: "allow_once", shortcut: "y" },
        { label: "Deny once", value: "deny_once", shortcut: "n" }
      ]}
      onSubmit={(value) => onResolve(request.requestId, value === "deny_once" ? "deny_once" : "allow_once")}
    />
  );
}

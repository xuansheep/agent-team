export type TuiLogMessage =
  | TuiUserLogMessage
  | TuiAssistantLogMessage
  | TuiStatusLogMessage
  | TuiToolLogMessage
  | TuiPermissionLogMessage;

type BaseLogMessage = {
  id: string;
  text: string;
  detailText?: string;
  nodeId?: string;
  attempt?: number;
};

export type TuiUserLogMessage = BaseLogMessage & {
  kind: "user";
};

export type TuiAssistantLogMessage = BaseLogMessage & {
  kind: "assistant";
};

export type TuiStatusLogMessage = BaseLogMessage & {
  kind: "status";
};

export type TuiToolLogMessage = BaseLogMessage & {
  kind: "tool";
  nodeId: string;
  attempt: number;
  toolCallId: string;
  tool: string;
  status: "running" | "completed" | "failed";
  summary: string;
};

export type TuiPermissionLogMessage = BaseLogMessage & {
  kind: "permission";
  nodeId: string;
  attempt: number;
  requestId: string;
  toolCallId: string;
  tool: string;
  status: "pending" | "allowed" | "denied";
};

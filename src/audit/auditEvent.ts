export type AuditDecision = "allow" | "ask" | "deny";

export type AuditEvent = {
  timestamp?: string;
  session_id?: string;
  run_id?: string;
  node_id?: string;
  attempt?: number;
} & (
  | { type: "permission_decision"; tool: string; decision: AuditDecision; reason?: string; rule?: string; input?: unknown }
  | { type: "mcp_catalog_published"; revision: number; protocol: "portable" | "anthropic-tool-reference"; deferred_tools: string[]; discovered_tools: string[]; pending_servers: string[]; failed_servers: string[] }
  | { type: "mcp_tools_discovered"; query: string; tools: string[] }
  | { type: "tool_invocation"; tool: string; input?: unknown }
  | { type: "tool_result"; tool: string; status: "completed" | "failed"; result?: unknown; error?: string }
  | { type: "shell_command"; tool: "Bash" | "PowerShell"; command: string; destructive: boolean; executor?: "bash" | "powershell"; executable?: string; fallback?: boolean; exit_code?: number }
  | { type: "file_write"; tool: "Write" | "Edit" | "MultiEdit"; path: string }
  | { type: "artifact_read"; artifact_id: string; offset: number; bytes_read: number; total_bytes: number; truncated: boolean; source: "handoff" | "tool" }
  | { type: "skill_activated"; name: string; mode: "inline" | "fork"; source: string; version?: string; allowed_tools: string[] }
  | { type: "model_retry"; operation: "sampling" | "compaction"; phase: "request" | "stream"; retry_attempt: number; max_retries: number; retry_in_ms: number; retry_at: string; error_kind: string; status?: number; error: string; discarded_content_chars: number; discarded_thinking_chars: number }
  | { type: "plan_mode"; action: "entered" | "draft_updated" | "approval_requested" | "approval_resolved"; plan_file_path?: string; decision?: "continue" | "stay" }
);

export type AuditSink = (event: AuditEvent) => void | Promise<void>;

export function normalizeAuditEvent(event: AuditEvent): AuditEvent {
  return { timestamp: event.timestamp ?? new Date().toISOString(), ...event };
}

export type PermissionDecision = "allow_once" | "deny_once";

export type PermissionRequest = {
  requestId: string;
  nodeId: string;
  attempt: number;
  toolCallId: string;
  tool: string;
  input: unknown;
  specifier: string;
  rule?: string;
};

type PendingRequest = {
  resolve: (decision: PermissionDecision) => void;
};

export class PermissionController {
  private readonly pending = new Map<string, PendingRequest>();

  request(request: PermissionRequest): Promise<PermissionDecision> {
    if (this.pending.has(request.requestId)) {
      throw new Error(`Duplicate permission request ${request.requestId}`);
    }

    return new Promise<PermissionDecision>((resolve) => {
      this.pending.set(request.requestId, { resolve });
    });
  }

  resolve(requestId: string, decision: PermissionDecision): void {
    const pending = this.pending.get(requestId);
    if (!pending) throw new Error(`Unknown permission request ${requestId}`);
    this.pending.delete(requestId);
    pending.resolve(decision);
  }

  resolveAll(decision: PermissionDecision): void {
    for (const requestId of [...this.pending.keys()]) {
      this.resolve(requestId, decision);
    }
  }

  hasPending(requestId: string): boolean {
    return this.pending.has(requestId);
  }
}

import { randomUUID } from "node:crypto";

export type ActiveTurnInputDisposition = "active_turn" | "next_turn";

export type ActiveTurnInputReceipt = {
  id: string;
  disposition: ActiveTurnInputDisposition;
};

export type PendingTurnInput<T> = {
  id: string;
  input: T;
};

export class ActiveTurnInputChannel<T> {
  private accepting = false;
  private pending: PendingTurnInput<T>[] = [];

  open(): void {
    this.accepting = true;
  }

  offer(input: T, id: string = randomUUID()): ActiveTurnInputReceipt {
    if (!this.accepting) return { id, disposition: "next_turn" };
    this.pending.push({ id, input });
    return { id, disposition: "active_turn" };
  }

  drain(): PendingTurnInput<T>[] {
    return this.pending.splice(0);
  }

  close(): PendingTurnInput<T>[] {
    this.accepting = false;
    return this.drain();
  }

  isOpen(): boolean {
    return this.accepting;
  }
}

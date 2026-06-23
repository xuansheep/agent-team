declare module "react-reconciler" {
  export type FiberRoot = unknown;

  export default function createReconciler<
    Type = unknown,
    Props = unknown,
    Container = unknown,
    Instance = unknown,
    TextInstance = unknown,
    SuspenseInstance = unknown,
    HydratableInstance = unknown,
    FormInstance = unknown,
    PublicInstance = unknown,
    HostContext = unknown,
    UpdatePayload = unknown,
    ChildSet = unknown,
    TimeoutHandle = unknown,
    NoTimeout = unknown
  >(config: any): any;
}

declare module "react-reconciler/constants.js" {
  export const ConcurrentRoot: number;
  export const LegacyRoot: number;
  export const ContinuousEventPriority: number;
  export const DefaultEventPriority: number;
  export const DiscreteEventPriority: number;
  export const NoEventPriority: number;
  export type Root = number;
}
declare module "signal-exit" {
  export default function onExit(
    callback: (code: number | null, signal: string | null) => void,
    options?: { alwaysLast?: boolean }
  ): () => void;
}
declare module "stack-utils" {
  export type StackLineData = {
    file?: string;
    line?: number;
    column?: number;
    function?: string;
  };

  export default class StackUtils {
    constructor(options?: { cwd?: string; internals?: RegExp[] });
    static nodeInternals(): RegExp[];
    parseLine(line: string): StackLineData | null;
  }
}

declare const Bun:
  | {
      stringWidth(value: string, options?: { ambiguousIsNarrow?: boolean }): number;
      wrapAnsi?(value: string, columns: number, options?: { hard?: boolean; wordWrap?: boolean; trim?: boolean }): string;
    }
  | undefined;

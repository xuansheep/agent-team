import reconciler from "./reconciler.js";

const noop = (): void => {};

type ReconcilerCompat = {
  updateContainerSync?: (node: unknown, container: unknown, parent: null, callback: () => void) => void;
  updateContainer?: (node: unknown, container: unknown, parent: null, callback: () => void) => void;
  flushSyncWork?: () => void;
  flushSyncFromReconciler?: () => void;
  flushSync?: (callback: () => void) => void;
};

export function updateContainerSyncCompat(node: unknown, container: unknown): void {
  const renderer = reconciler as ReconcilerCompat;
  if (renderer.updateContainerSync) {
    renderer.updateContainerSync(node, container, null, noop);
    renderer.flushSyncWork?.();
    return;
  }

  if (!renderer.updateContainer) {
    throw new TypeError("react-reconciler does not provide updateContainer");
  }

  if (renderer.flushSync) {
    renderer.flushSync(() => renderer.updateContainer?.(node, container, null, noop));
    return;
  }

  renderer.updateContainer(node, container, null, noop);
  renderer.flushSyncWork?.();
}

export function flushReconcilerSyncCompat(): void {
  const renderer = reconciler as ReconcilerCompat;
  if (renderer.flushSyncFromReconciler) {
    renderer.flushSyncFromReconciler();
    return;
  }
  if (renderer.flushSync) {
    renderer.flushSync(noop);
    return;
  }
  renderer.flushSyncWork?.();
}

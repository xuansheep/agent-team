import { TerminalEvent } from './terminal-event.js'

export type MouseEventAction = 'press' | 'move' | 'release' | 'cancel'

/** Mouse event delivered to Ink Box handlers for pointer interactions. */
export class MouseEvent extends TerminalEvent {
  readonly col: number
  readonly row: number
  readonly button: number
  readonly action: MouseEventAction
  localCol = 0
  localRow = 0
  private pointerCaptureRequested = false

  constructor(input: {
    col: number
    row: number
    button: number
    action: MouseEventAction
  }) {
    super(
      input.action === 'press'
        ? 'mousedown'
        : input.action === 'move'
          ? 'mousemove'
          : 'mouseup',
    )
    this.col = input.col
    this.row = input.row
    this.button = input.button
    this.action = input.action
  }

  capturePointer(): void {
    this.pointerCaptureRequested = true
  }

  /** @internal */
  _isPointerCaptureRequested(): boolean {
    return this.pointerCaptureRequested
  }
}

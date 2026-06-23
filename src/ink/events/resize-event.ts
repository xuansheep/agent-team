import { Event } from "./event.js";

export class ResizeEvent extends Event {
  constructor(
    readonly columns: number,
    readonly rows: number
  ) {
    super();
  }
}

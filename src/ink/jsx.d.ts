import type { DOMElement } from "./dom.js";
import type { Styles, TextStyles } from "./styles.js";
import type { EventHandlerProps } from "./events/event-handlers.js";
import type React from "react";

declare global {
  namespace JSX {
    interface IntrinsicElements {
      "ink-box": React.PropsWithChildren<
        EventHandlerProps & {
          ref?: React.Ref<DOMElement>;
          style?: Styles;
          tabIndex?: number;
          autoFocus?: boolean;
          [key: string]: unknown;
        }
      >;
      "ink-text": React.PropsWithChildren<{
        style?: Styles;
        textStyles?: TextStyles;
        [key: string]: unknown;
      }>;
      "ink-link": React.PropsWithChildren<{
        url?: string;
        fallback?: boolean;
        [key: string]: unknown;
      }>;
      "ink-raw-ansi": {
        children?: string;
        [key: string]: unknown;
      };
    }
  }
}

export {};

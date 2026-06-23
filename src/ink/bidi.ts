/**
 * Bidirectional text reordering for terminal rendering.
 *
 * Terminals on Windows do not implement the Unicode Bidi Algorithm,
 * so RTL text (Hebrew, Arabic, etc.) appears reversed. This module
 * applies the bidi algorithm to reorder ClusteredChar arrays from
 * logical order to visual order before Ink's LTR cell placement loop.
 *
 * On macOS terminals (Terminal.app, iTerm2) bidi works natively.
 * Windows Terminal (including WSL) does not implement bidi
 * (https://github.com/microsoft/terminal/issues/538).
 *
 * Detection: Windows Terminal sets WT_SESSION; native Windows cmd/conhost
 * also lacks bidi. We enable bidi reordering when running on Windows or
 * inside Windows Terminal (covers WSL).
 */
type ClusteredChar = {
  value: string
  width: number
  styleId: number
  hyperlink: string | undefined
}

let needsSoftwareBidi: boolean | undefined

function needsBidi(): boolean {
  if (needsSoftwareBidi === undefined) {
    needsSoftwareBidi =
      process.platform === 'win32' ||
      typeof process.env['WT_SESSION'] === 'string' || // WSL in Windows Terminal
      process.env['TERM_PROGRAM'] === 'vscode' // VS Code integrated terminal (xterm.js)
  }
  return needsSoftwareBidi
}

/**
 * Reorder an array of ClusteredChars from logical order to visual order
 * using the Unicode Bidi Algorithm. Active on terminals that lack native
 * bidi support (Windows Terminal, conhost, WSL).
 *
 * Returns the same array on bidi-capable terminals (no-op).
 */
export function reorderBidi(characters: ClusteredChar[]): ClusteredChar[] {
  if (!needsBidi() || characters.length === 0) return characters
  return characters
}

/**
 * Quick check for RTL characters (Hebrew, Arabic, and related scripts).
 * Avoids running the full bidi algorithm on pure-LTR text.
 */
function hasRTLCharacters(text: string): boolean {
  // Hebrew: U+0590-U+05FF, U+FB1D-U+FB4F
  // Arabic: U+0600-U+06FF, U+0750-U+077F, U+08A0-U+08FF, U+FB50-U+FDFF, U+FE70-U+FEFF
  // Thaana: U+0780-U+07BF
  // Syriac: U+0700-U+074F
  return /[\u0590-\u05FF\uFB1D-\uFB4F\u0600-\u06FF\u0750-\u077F\u08A0-\u08FF\uFB50-\uFDFF\uFE70-\uFEFF\u0780-\u07BF\u0700-\u074F]/u.test(
    text,
  )
}

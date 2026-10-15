// Inline markup of the help's text: `…` is code (a path, a file name, a tag). An unpaired backtick stays text.

export interface InlineSegment {
  text: string;
  code: boolean;
}

/** The text cut into plain and code pieces (empty pieces left out). */
export function inlineSegments(text: string): InlineSegment[] {
  const out: InlineSegment[] = [];
  const push = (t: string, code: boolean) => {
    if (t) out.push({ text: t, code });
  };
  let rest = text;
  for (;;) {
    const open = rest.indexOf("`");
    const close = open < 0 ? -1 : rest.indexOf("`", open + 1);
    if (close < 0) {
      push(rest, false);
      return out;
    }
    push(rest.slice(0, open), false);
    push(rest.slice(open + 1, close), true);
    rest = rest.slice(close + 1);
  }
}

/** The text as it reads (the code marks removed): what the help's search looks in. */
export function plainText(text: string): string {
  return inlineSegments(text)
    .map((s) => s.text)
    .join("");
}

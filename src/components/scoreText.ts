// Which ABC text the score editor stands for (render, 「この譜面で再生成」, ABC export, staff view).

export interface ScoreTextState {
  /** the score was changed in the editor since it was taken in */
  dirty: boolean;
  /** a score is parsed */
  hasScore: boolean;
  /** the text the current score was taken in from (or last emitted) */
  source: string;
  /**
   * serializeAbc of the current score ("" when it cannot be serialized), or a function giving it: it is then
   * called only when the serialized text is the answer (an unedited score is never serialized).
   */
  serialized: string | (() => string);
  /** the text tab's contents */
  text: string;
}

/**
 * An unedited score is passed on as the text it was taken in from, not re-serialized: serializing normalizes
 * the tokens (a SheetSage2 "full" transcription's split rests `z6z2` become `z8`), and YuE2 must receive the
 * stored score verbatim, as the official cli.py reads it. Only a real edit sends the serialized score.
 */
export function currentScoreAbc(s: ScoreTextState): string {
  if (s.hasScore && !s.dirty && s.source.trim()) return s.source;
  return (typeof s.serialized === "function" ? s.serialized() : s.serialized) || s.text;
}

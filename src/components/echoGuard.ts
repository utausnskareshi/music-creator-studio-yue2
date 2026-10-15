// Controlled-component guard for the score editor: a page may feed the editor's own output back as its `abc`
// prop (EditPage: <ScoreEditor abc={abc} onAbcChange={setAbc} />). That echo must not be treated as new
// input, or the load effect would reset the edit state and wipe the notices set right after an edit.

export interface EchoGuard {
  /** Record the text the editor passes to onAbcChange. */
  emit(abc: string): void;
  /**
   * true when `abc` is the editor's own last output coming back. Any other value is new input from the
   * parent and forgets the last output, so the same text brought in again later is loaded normally.
   */
  isEcho(abc: string): boolean;
}

export function createEchoGuard(): EchoGuard {
  let last: string | null = null;
  return {
    emit(abc) {
      last = abc;
    },
    isEcho(abc) {
      if (last !== null && abc === last) return true;
      last = null;
      return false;
    },
  };
}

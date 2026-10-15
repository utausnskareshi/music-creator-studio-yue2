// Why a page's controls are unavailable while its own work runs. A page disables every control that would
// conflict with the running work (a second flow asking its questions over the first one's, a result landing
// on a form that moved on meanwhile, a tool reading settings that change under it) and shows the reason in
// the control's tooltip. Text editing is never locked: typing is not a process.

/** Work a page may be in the middle of, in the order the tooltip names them when several overlap. */
export type LockReason =
  /** the AI draft of lyrics and style is being written (作曲) */
  | "writing"
  /** the instrumental's score is being planned (作曲) */
  | "planning"
  /** a generate flow is between its button and api.generate: questions, estimates, the send itself */
  | "sending"
  /** the audio is being transcribed (カバー / 耳コピ) */
  | "transcribing"
  /** vocals are being separated (ボーカル分離) */
  | "separating"
  /** synced-lyrics timing is being detected: separation then alignment (書き出し) */
  | "aligning"
  /** the file is being written (書き出し) */
  | "exporting"
  /** an AI edit request is waiting for its reply (AI 編集) */
  | "llmWaiting"
  /** the lyrics editor converts the lyrics to hiragana, or checks its hiragana version before discarding it (作曲 / カバー) */
  | "converting";

// The conversion last: it takes a few seconds at most (the first dictionary load).
const ORDER: readonly LockReason[] = ["writing", "planning", "sending", "transcribing", "separating", "aligning", "exporting", "llmWaiting", "converting"];

/** Tooltip of a control disabled for the reason. */
export const LOCK_HINT: Record<LockReason, string> = {
  writing: "歌詞とスタイルの作成中は実行できません。完了するか、横の「キャンセル」で取り消してください",
  planning: "インストゥルメンタル版の譜面を計画中は実行できません。完了するか「キャンセル」で取り消してください",
  sending: "生成の送信中です。確認が終わるまでお待ちください",
  transcribing: "転写中は変更できません。完了するか「キャンセル」で取り消してください",
  separating: "分離中は変更できません。完了するか「キャンセル」で取り消してください",
  aligning: "タイミングの自動検出中は変更できません。完了するか「キャンセル」で取り消してください",
  exporting: "書き出し中は変更できません",
  llmWaiting: "AI の応答を待っている間は実行できません。先に「キャンセル」で取り消してください",
  converting: "歌詞のひらがな化（ひらがな版を破棄する前の確認を含む）が終わるまでお待ちください",
};

/** The first (in ORDER) of the reasons that hold, or null when none does. */
export function lockReason(flags: Partial<Record<LockReason, boolean>>): LockReason | null {
  return ORDER.find((r) => flags[r]) ?? null;
}

/** The tooltip for `lockReason(flags)`; undefined when nothing is locked (the control keeps its own title). */
export function lockHint(flags: Partial<Record<LockReason, boolean>>): string | undefined {
  const r = lockReason(flags);
  return r ? LOCK_HINT[r] : undefined;
}

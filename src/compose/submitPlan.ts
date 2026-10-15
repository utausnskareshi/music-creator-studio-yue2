// The compose page's send decisions without React state, so they are unit-tested directly: the mode matched
// to a fixed score (no chords -> Melody, a chord score in Melody -> strip or Full), the advisory score check,
// the style tempo taken from the score's Q:, and the budget dialog. The page applies `formChanges` only once
// the plan is complete; a cancel at any dialog returns null and leaves the form as the user left it.
import type { ChoiceRequest } from "../components/ChoiceDialog";
import { irregularBarList, irregularBarsNotice } from "../components/scoreEditorState";
import { cloneScore } from "../abc/model";
import { parseAbcDetailed } from "../abc/parse";
import { serializeAbc } from "../abc/serialize";
import { hasSungVersion } from "../lyrics/hiragana";
import { styleBpm } from "../lyrics/styleBpm";
import { AcceptedAdvice, confirmScoreAdvice, scoreFindings } from "./scoreAdvice";
import { durationBudget, hasSungWords, mmss, rawHasChords, scoreMarginSeconds, statedAbcTempo, styleTempoSync } from "./rules";

export type Mode = "full" | "melody" | "off";

type Ask = <T extends string>(request: ChoiceRequest<T>) => Promise<T | null>;

/** The compose page's text for a section mismatch in the 「譜面の確認」 dialog. */
export const COMPOSE_MISMATCH_MESSAGE = "譜面と歌詞のセクションが対応していない可能性があります。";

/** Note when the form's lyrics have nothing to sing and no score is sent (an instrumental render can still let a
 * voice in now and then, so it is not promised either). Plain sentences: the toast joins notes with 。 and may add
 * the page's name in brackets. */
export const NO_WORDS_NOTE = "歌詞なしで生成します（歌なしになるとは限りません）。歌なしの曲は「インストゥルメンタル版を生成」で作ってください。それでもまれに声が混じることがあります";

export interface PlanOverrides {
  mode?: Mode;
  /** a score passed by the caller (the editor or the instrumental render) instead of the form's */
  abc?: string;
  style?: string;
  /** run the advisory checks on `abc` too (the editor's 「この譜面で再生成」; no mode matching) */
  adviseScore?: boolean;
  /** never send a budget below this */
  minMaxDuration?: number;
  /** notes of the caller, shown first */
  notes?: string[];
}

export interface PlanInput {
  /** the form's planning mode */
  formMode: Mode;
  /** the form's fixed ABC ("" when 「ABC 譜面を固定」 is off) */
  formAbc: string;
  formStyle: string;
  /** the text sent to the model */
  sung: string;
  /** the lyrics are the form's (not an override): the no-words note applies */
  formLyrics: boolean;
  over: PlanOverrides;
  durations: { auto: boolean; manual: number; limit: number; defaultMax: number; fallbackEstimate: number };
}

export interface PlanDeps {
  ask: Ask;
  estimateDuration: (text: string) => Promise<number>;
  acceptedAdvice: AcceptedAdvice;
}

/** Form changes the plan decided, as data (the page maps them onto its setters). */
export interface FormChanges {
  mode?: Mode;
  /** the chord-stripped score */
  abc?: string;
  /** the score's tempo, applied to the style field as it is then (withStyleBpm) and to the tempo chip */
  styleBpm?: number;
}

export interface SubmitPlan {
  mode: Mode;
  abc: string;
  style: string;
  maxDuration: number;
  notes: string[];
  formChanges: FormChanges;
}

/**
 * Plan one send. The advisory check runs for the form's own fixed score (with the mode matched to it) and for
 * a caller's score with `adviseScore`; the instrumental render passes neither and stays silent. The style
 * follows the score's stated Q: (the form's style field only when no style override was passed). Findings
 * confirmed in the 「譜面の確認」 dialog count as accepted at once, also when the budget dialog after it is
 * cancelled (confirmScoreAdvice). Null when the user cancelled a dialog.
 */
export async function planSubmission(input: PlanInput, deps: PlanDeps): Promise<SubmitPlan | null> {
  const { over } = input;
  let m: Mode = over.mode ?? input.formMode;
  let a = m === "off" ? "" : (over.abc ?? input.formAbc);
  let st = (over.style ?? input.formStyle).trim();
  const notes: string[] = [...(over.notes ?? [])];
  const formChanges: FormChanges = {};

  if (a.trim() && (over.abc === undefined || over.adviseScore)) {
    let findings = scoreFindings(a);
    const score = findings.parsed;
    const hasChords = score ? score.chords.length > 0 : rawHasChords(a);
    if (over.abc === undefined && over.mode === undefined) {
      if (!hasChords && m === "full") {
        m = "melody";
        formChanges.mode = "melody";
        notes.push("譜面にコードがないため Melody モードに切り替えました");
      } else if (hasChords && m === "melody") {
        // The stripped score is written from the meter's bar grid: after a bar shorter or longer than the meter (a
        // pickup, a lost beat), every later bar line moves, as in the score editor. Said before the choice and after.
        const irregular = score ? parseAbcDetailed(a).irregularBars : [];
        const choice = await deps.ask({
          title: "コード付きの譜面です",
          message: "Melody モードはコードのない譜面を前提にしています（公式: melody モードでも入力譜面のコードは自動では消えません）。どちらで生成しますか？",
          ...(irregular.length
            ? { details: [`小節の長さが拍子と合わない小節があります${irregularBarList(irregular)}。コードを削除すると、それより後の小節線は拍子どおりの位置に書き直されます（Full モードでは譜面をそのまま送ります）`] }
            : {}),
          choices: [...(score ? [{ value: "strip" as const, label: "コードを削除して Melody で生成", kind: "primary" as const }] : []), { value: "full" as const, label: "Full モードに切り替えて生成" }],
        });
        if (!choice) return null;
        if (choice === "strip" && score) {
          const s2 = cloneScore(score);
          s2.chords = [];
          // Without a Q: the parser assumed 120, and serializeAbc always writes one: the style's tempo goes in
          // instead (as in the instrumental render), and with none the written Q: is dropped again, so the
          // tempo sync below never copies the assumed 120 into the style (the native check reports the gap).
          // A Q: the parser did read ('Q:"Allegro" 1/4=96', which statedAbcTempo skips) is kept as it is.
          const noQ = !headerQRead(a);
          const styleTempo = styleBpm(st);
          if (noQ && styleTempo !== null) s2.bpm = styleTempo;
          a = serializeAbc(s2);
          if (noQ && styleTempo === null) a = a.replace(/^Q:.*\n/m, "");
          formChanges.abc = a;
          findings = scoreFindings(a);
          notes.push("譜面のコードを削除しました");
          const moved = irregularBarsNotice(irregular, true);
          if (moved) notes.push(moved);
        } else {
          m = "full";
          formChanges.mode = "full";
        }
      }
    }
    const advice = await confirmScoreAdvice({ abc: a, sung: input.sung, findings, accepted: deps.acceptedAdvice, ask: deps.ask, mismatchMessage: COMPOSE_MISMATCH_MESSAGE });
    if (!advice.ok) return null;
    notes.push(...advice.notes);
  }

  // The ABC is the plan the audio follows: the style's tempo is brought in line with its Q: (only a Q: the
  // score really has; without one the parsers assume 120, and the native check reports the missing Q:).
  if (a.trim()) {
    const sync = styleTempoSync(st, statedAbcTempo(a));
    if (sync) {
      st = sync.style;
      if (over.style === undefined) formChanges.styleBpm = sync.bpm;
      notes.push(sync.note);
    }
  }

  // decided from what is sung (the hiragana version when there is one), not from the kanji pane
  if (input.formLyrics && !a.trim() && !hasSungWords(input.sung)) notes.push(NO_WORDS_NOTE);

  const d = input.durations;
  const est = await deps.estimateDuration(input.sung).catch(() => d.fallbackEstimate);
  const budget = durationBudget({ auto: d.auto, manual: d.manual, limit: d.limit, defaultMax: d.defaultMax, abc: a, lyricEstimate: est });
  let maxDur = Math.min(d.limit, Math.max(budget.seconds, over.minMaxDuration ?? 0));
  if (budget.warning && budget.scoreSeconds !== null && maxDur < budget.scoreSeconds) {
    // the same margin as the automatic budget for this score
    const wider = Math.min(d.limit, scoreMarginSeconds(budget.scoreSeconds));
    const choice = await deps.ask({
      title: "曲長の上限が譜面の長さより短くなっています",
      message: budget.warning,
      choices: [...(wider > maxDur ? [{ value: "wider" as const, label: `上限を ${mmss(wider)} に広げて生成`, kind: "primary" as const }] : []), { value: "asis" as const, label: `${mmss(maxDur)} のまま生成` }],
    });
    if (!choice) return null;
    if (choice === "wider") maxDur = wider;
  }

  return { mode: m, abc: m !== "off" ? a : "", style: st, maxDuration: maxDur, notes, formChanges };
}

/** The header (before the first K:) has a Q: line with a number in it, which parseAbc reads as the tempo. */
function headerQRead(abc: string): boolean {
  for (const raw of abc.replace(/\r\n?/g, "\n").split("\n")) {
    const line = raw.trim();
    if (line.startsWith("K:")) return false;
    if (/^Q:.*\d/.test(line)) return true;
  }
  return false;
}

// ---------------------------------------------------------------------------------------------------------
// Double submits

/** A second press of the same generate button within this time is a double click, not a new request. */
export const SUBMIT_COOLDOWN_MS = 1000;

/**
 * Guard for the generate buttons. `begin(key)` fails while a send is in flight (its dialogs, estimate and
 * api.generate) and for SUBMIT_COOLDOWN_MS after a send of the same button was accepted (`accepted(key)`),
 * so a double click queues one job; deliberate queueing afterwards still works. `end()` in a finally.
 */
export class SubmitGuard {
  private busy = false;
  private last = new Map<string, number>();

  constructor(
    private readonly cooldownMs = SUBMIT_COOLDOWN_MS,
    private readonly now: () => number = Date.now,
  ) {}

  begin(key: string): boolean {
    if (this.busy) return false;
    const t = this.last.get(key);
    if (t !== undefined && this.now() - t < this.cooldownMs) return false;
    this.busy = true;
    return true;
  }

  accepted(key: string): void {
    this.last.set(key, this.now());
  }

  end(): void {
    this.busy = false;
  }
}

/** A click handler that ignores the second click of a double click (keyboard activation has detail 0). */
export function singleClick(fn: () => void): (e: { detail: number }) => void {
  return (e) => {
    if (e.detail > 1) return;
    fn();
  };
}

// ---------------------------------------------------------------------------------------------------------
// AI songwriting

/**
 * What an AI draft would replace that the user may want to keep: lyrics other than the page's default (or a
 * hiragana version, which may hold hand-fixed readings), a style that is neither the default nor the chip
 * composition (hand-written or edited), and a title typed into the title field. Lyrics, a style or a title
 * exactly as the last AI draft left them (`lastDraft`) are not at risk either: the usual "try another draft"
 * loop asks nothing.
 */
export function draftReplaces(i: {
  lyrics: string;
  defaultLyrics: string;
  sungLyrics: string | null;
  style: string;
  defaultStyle: string;
  composedStyle: string;
  /** the title field ("" or omitted: nothing to lose) */
  title?: string;
  lastDraft?: { lyrics: string; style: string; title?: string } | null;
}): { lyrics: boolean; style: boolean; title: boolean } {
  const norm = (s: string) => s.replace(/\r\n?/g, "\n").trim();
  const draftLyrics = i.lastDraft && norm(i.lastDraft.lyrics) !== "" ? norm(i.lastDraft.lyrics) : null;
  const draftStyle = i.lastDraft && norm(i.lastDraft.style) !== "" ? norm(i.lastDraft.style) : null;
  const draftTitle = i.lastDraft?.title && norm(i.lastDraft.title) !== "" ? norm(i.lastDraft.title) : null;
  // an emptied hiragana pane holds no readings (hasSungVersion): nothing to lose there
  const lyrics = (norm(i.lyrics) !== "" && norm(i.lyrics) !== norm(i.defaultLyrics) && norm(i.lyrics) !== draftLyrics) || hasSungVersion(i.sungLyrics);
  const style = norm(i.style) !== "" && norm(i.style) !== norm(i.defaultStyle) && norm(i.style) !== norm(i.composedStyle) && norm(i.style) !== draftStyle;
  const title = norm(i.title ?? "") !== "" && norm(i.title ?? "") !== draftTitle;
  return { lyrics, style, title };
}

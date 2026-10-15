// When the advisory score checks (native dialect, sections vs lyrics) open the 「譜面の確認」 dialog, shared by
// the compose, cover and AI-edit pages. The checks never block (src/abc/native.ts): a finding the user already
// accepted for the same score (and sung text) is not asked again, and the untagged-lyrics hint is only a note.
import { compareSections, isUntaggedLyricsHint } from "../abc/consistency";
import { parseAbc } from "../abc/parse";
import { validateNativeAbc } from "../abc/native";
import type { Score } from "../abc/model";
import { rawHasChords } from "./rules";
import type { ChoiceRequest } from "../components/ChoiceDialog";

/** Start of the finding for a score the app parser rejects (scoreFindings). */
export const PARSER_FINDING = "アプリの譜面パーサーで解釈できません";

/**
 * Findings about the score alone, as the AI-edit page's render() lists them: the app parser's error (null
 * score) and the native check. Shared with apply() so an accepted finding is recognised by its exact text.
 */
export function scoreFindings(a: string): { parsed: Score | null; issues: string[]; nativeOk: boolean } {
  let parsed: Score | null = null;
  const issues: string[] = [];
  try {
    parsed = parseAbc(a);
  } catch (e) {
    issues.push(`${PARSER_FINDING}: ${e instanceof Error ? e.message : String(e)}（元の ABC をそのまま送り、コードの有無は文字列から判定します）`);
  }
  const native = validateNativeAbc(a);
  issues.push(...native.errors);
  return { parsed, issues, nativeOk: native.ok };
}

/** Whether the score `a` has chords (a render with it is Full, else Melody): the parsed score's, else a raw scan. */
export function scoreHasChords(a: string, findings: { parsed: Score | null } = scoreFindings(a)): boolean {
  return findings.parsed ? findings.parsed.chords.length > 0 : rawHasChords(a);
}

/**
 * The findings of the applied score `abc` (scoreFindings) that the AI-edit apply dialog really showed, so the
 * first 再生成 does not ask about them again but still asks about everything else. An unparsable reply's
 * dialog listed only the parser error: its native-check findings were never shown and stay unaccepted. A
 * native-check dialog listed `shown` for the reply's text: after a Q: rewrite only the findings whose text is
 * unchanged count.
 */
export function findingsAcceptedAtApply(abc: string, shown: readonly string[], unparsable: boolean): string[] {
  const { issues } = scoreFindings(abc);
  if (unparsable) return issues.filter((i) => i.startsWith(PARSER_FINDING));
  const seen = new Set(shown);
  return issues.filter((i) => seen.has(i));
}

export interface AdviceDecision {
  /** open the confirmation dialog */
  ask: boolean;
  /** findings listed in the dialog (all of them, hints included) */
  details: string[];
  /** hints shown in the post-send notice instead (only when no dialog opens) */
  notes: string[];
}

/**
 * Whether to ask about `issues`. Hints (lyrics without section tags) never open the dialog on their own; a
 * dialog opens when at least one other finding was not accepted before (`accepted`).
 */
export function adviceDecision(issues: string[], accepted?: ReadonlySet<string>): AdviceDecision {
  const hints = issues.filter(isUntaggedLyricsHint);
  const fresh = issues.filter((i) => !isUntaggedLyricsHint(i) && !accepted?.has(i));
  if (fresh.length === 0) return { ask: false, details: [], notes: hints };
  return { ask: true, details: issues, notes: [] };
}

/**
 * Findings the user chose to send (or apply) anyway, kept for the page's lifetime. Keyed by the exact score
 * text and sung text that are sent; findings about the score alone (the native check, accepted when an AI
 * edit is applied) are stored with `sung === null` and hold for any sung text. Any change to the score or the
 * sung text is a new key, so the user is asked again.
 */
export class AcceptedAdvice {
  private byKey = new Map<string, Set<string>>();

  private static key(abc: string, sung: string | null): string {
    return sung === null ? `${abc}\u0000*` : `${abc}\u0000=${sung}`;
  }

  get(abc: string, sung: string): ReadonlySet<string> {
    return new Set([...(this.byKey.get(AcceptedAdvice.key(abc, null)) ?? []), ...(this.byKey.get(AcceptedAdvice.key(abc, sung)) ?? [])]);
  }

  accept(abc: string, sung: string | null, issues: string[]): void {
    const k = AcceptedAdvice.key(abc, sung);
    const set = this.byKey.get(k) ?? new Set<string>();
    for (const i of issues) set.add(i);
    this.byKey.delete(k);
    this.byKey.set(k, set);
    // only the last few scores matter
    if (this.byKey.size > 20) this.byKey.delete(this.byKey.keys().next().value as string);
  }
}

type Ask = <T extends string>(request: ChoiceRequest<T>) => Promise<T | null>;

/** The 「譜面の確認」 message for a non-native score (the same on every page). */
export const NON_NATIVE_MESSAGE = "譜面が YuE2 のネイティブ記法（公式 abc_tools の検査）と異なります。生成が崩れる可能性があります。";

/**
 * The advisory score check before a send, shared by the compose, cover and AI-edit pages: the findings of
 * scoreFindings(abc) plus, for a parsed score, the section comparison with the sung text; the 「譜面の確認」
 * dialog when a finding was not accepted before (`mismatchMessage` is the page's own text for a section
 * mismatch, citing the guidance that fits it). A confirmed dialog records the findings as accepted at once,
 * even if a later dialog of the same send is cancelled (sending the same score again does not ask again).
 * `ok` is false when the user cancelled; `notes` are hints for the post-send notice.
 */
export async function confirmScoreAdvice(i: {
  abc: string;
  sung: string;
  findings: { parsed: Score | null; issues: string[]; nativeOk: boolean };
  accepted: AcceptedAdvice;
  ask: Ask;
  mismatchMessage: string;
}): Promise<{ ok: boolean; notes: string[] }> {
  const { parsed, nativeOk } = i.findings;
  const issues = [...i.findings.issues];
  if (parsed) issues.push(...compareSections(parsed, i.sung));
  const advice = adviceDecision(issues, i.accepted.get(i.abc, i.sung));
  if (!advice.ask) return { ok: true, notes: advice.notes };
  const nonNative = !nativeOk || !parsed;
  const go = await i.ask({
    title: "譜面の確認",
    message: nonNative ? NON_NATIVE_MESSAGE : i.mismatchMessage,
    details: advice.details,
    choices: [{ value: "send", label: nonNative ? "非ネイティブ記法のまま送信" : "このまま送信", kind: "primary" }],
  });
  if (!go) return { ok: false, notes: [] };
  i.accepted.accept(i.abc, i.sung, advice.details);
  return { ok: true, notes: advice.notes };
}

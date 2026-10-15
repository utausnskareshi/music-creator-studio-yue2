import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(() => Promise.resolve(() => {})) }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: vi.fn(), save: vi.fn() }));

import type { ChoiceRequest } from "../../components/ChoiceDialog";
import { statedAbcTempo, styleTempoSync } from "../../compose/rules";
import { styleBpm, styleBpmDiffers } from "../../lyrics/styleBpm";
import { unappliedScoreTextOk } from "../EditPage";

/** An ask() that answers from a script and records the questions. */
function scripted(...answers: (string | null)[]) {
  const asked: ChoiceRequest<string>[] = [];
  const ask = async <T extends string>(r: ChoiceRequest<T>): Promise<T | null> => {
    asked.push(r as ChoiceRequest<string>);
    return (answers.shift() ?? null) as T | null;
  };
  return { ask, asked };
}

/** The message of the one question unappliedScoreTextOk asks for `i` (cancelled). */
async function question(i: Omit<Parameters<typeof unappliedScoreTextOk>[0], "textDirty">): Promise<{ message: string; go: string }> {
  const s = scripted(null);
  expect(await unappliedScoreTextOk({ ...i, textDirty: true }, s.ask)).toBe(false);
  expect(s.asked).toHaveLength(1);
  expect(s.asked[0].title).toBe("未反映の ABC テキスト");
  return { message: String(s.asked[0].message), go: s.asked[0].choices[0].label };
}

describe("AI 編集's question about ABC text that is not applied", () => {
  it("is not asked while the editor holds no unapplied text, and goes on with 反映せずに続ける / 変更を破棄して適用", async () => {
    const none = scripted();
    expect(await unappliedScoreTextOk({ textDirty: false, action: "render", hasScore: true }, none.ask)).toBe(true);
    expect(none.asked).toHaveLength(0);
    expect(await unappliedScoreTextOk({ textDirty: true, action: "send", hasScore: true }, scripted("go").ask)).toBe(true);
    expect((await question({ action: "render", hasScore: true })).go).toBe("反映せずに続ける");
    expect((await question({ action: "apply", hasScore: true, replyHasScore: true })).go).toBe("変更を破棄して適用");
  });

  it("names the applied score a render or a send uses", async () => {
    expect((await question({ action: "render", hasScore: true })).message).toContain("反映済みの譜面で生成します");
    expect((await question({ action: "send", hasScore: true })).message).toContain("AI には反映済みの譜面を送ります");
  });

  it("does not promise an applied score when there is none (the render plans one again or stays without one, the AI gets none)", async () => {
    const planned = (await question({ action: "render", hasScore: false })).message;
    expect(planned).not.toContain("反映済みの譜面で生成します");
    expect(planned).toContain("反映済みの譜面がない");
    expect(planned).toContain("譜面を再計画して生成します");
    const off = (await question({ action: "render", hasScore: false, offRender: true })).message;
    expect(off).toContain("譜面なしで生成します");
    const send = (await question({ action: "send", hasScore: false })).message;
    expect(send).not.toContain("反映済みの譜面を送ります");
    expect(send).toContain("AI には譜面なしで送ります");
  });

  it("names the tempo dialog's Q: change when the reply itself has no score", async () => {
    expect((await question({ action: "apply", hasScore: true, replyHasScore: true })).message).toContain("提案の譜面を適用すると、テキストの変更は失われます");
    const q = (await question({ action: "apply", hasScore: true, replyHasScore: false })).message;
    expect(q).not.toContain("提案の譜面");
    expect(q).toContain("譜面の Q: を変更すると、テキストの変更は失われます");
  });
});

// The page's async guards (no DOM test setup here): read from the source, so removing one fails a test.
const PAGE = readFileSync(join(fileURLToPath(new URL("..", import.meta.url)), "EditPage.tsx"), "utf8");

/** The body of the arrow function declared by `decl` (from its first "{" to the matching "}"). */
function body(decl: string): string {
  const at = PAGE.indexOf(decl);
  expect(at, decl).toBeGreaterThan(-1);
  const open = PAGE.indexOf("{", PAGE.indexOf("=>", at));
  let depth = 0;
  for (let i = open; i < PAGE.length; i++) {
    if (PAGE[i] === "{") depth++;
    else if (PAGE[i] === "}" && --depth === 0) return PAGE.slice(open, i + 1);
  }
  throw new Error(`unbalanced body of ${decl}`);
}

/** Positions of every match of `re` (global) in `code`. */
const positions = (code: string, re: RegExp) => Array.from(code.matchAll(re), (m) => m.index);

/** The opening tag of the <button> whose content matches `label` (from `<button` up to the content). */
function buttonAttrs(label: RegExp): string {
  const at = PAGE.search(label);
  expect(at, `button content ${label}`).toBeGreaterThan(-1);
  return PAGE.slice(PAGE.lastIndexOf("<button", at), at);
}

describe("AI 編集's guards against late results", () => {
  it("drops a reply after every wait for the LLM once its request was cancelled or the conversation changed", () => {
    const send = body("const send = async (");
    const begin = send.indexOf("conv.begin(");
    const commit = send.indexOf("setTurns((t) => [...t, turn])");
    expect(begin).toBeGreaterThan(-1);
    expect(commit).toBeGreaterThan(begin);
    const waits = positions(send.slice(begin, commit), /\bawait\b/g).map((p) => p + begin);
    // the first request and the automatic re-ask
    expect(waits.length).toBeGreaterThanOrEqual(2);
    waits.forEach((w, k) => {
      const next = k + 1 < waits.length ? waits[k + 1] : commit;
      expect(send.slice(w, next), `the stale() check after the wait at ${send.slice(w, w + 40)}`).toContain("if (stale()) return;");
    });
    // a failed request of a dropped conversation adds no error turn either
    expect(send.slice(send.indexOf("} catch (e) {", commit))).toMatch(/^\} catch \(e\) \{\s*if \(!stale\(\)/);
  });

  it("applies a reply only to the song it was made for, and only into the form the apply started from", () => {
    const apply = body("const apply = async (");
    const firstWait = apply.search(/\bawait\b/);
    // refused before any question when another song was loaded since the reply arrived
    const songCheck = apply.indexOf("!== convSong.current");
    expect(songCheck).toBeGreaterThan(-1);
    expect(songCheck).toBeLessThan(firstWait);
    // after the last wait (questions, the hiragana rebuild) and before the first write into the form
    const write = apply.indexOf("setAbc(nextAbc)");
    expect(write).toBeGreaterThan(-1);
    const lastWait = Math.max(...positions(apply.slice(0, write), /\bawait\b/g));
    const checks = apply.slice(lastWait, write);
    expect(checks).toContain("conv.gen !== startGen");
    expect(checks).toContain("convSong.current !== startSong");
    expect(checks).toContain("formNow.current");
  });

  it("asks about unapplied ABC text whenever the apply changes the score, before the hiragana rebuild", () => {
    const apply = body("const apply = async (");
    const asks = positions(apply, /unappliedTextOk\("apply"/g);
    expect(asks).toHaveLength(1);
    const line = apply.slice(apply.lastIndexOf("\n", asks[0]), apply.indexOf("\n", asks[0]));
    // the reply's score, or the tempo dialog's Q: change of a reply without one
    expect(line).toMatch(/nextAbc !== abc/);
    expect(asks[0]).toBeGreaterThan(apply.indexOf("replaceAbcTempo("));
    // never after the (first, slow) dictionary load: a 送信 or song-load question opened during it would be
    // replaced by it (one question at a time) and cancelled without a word
    const rebuild = apply.indexOf("await toHiragana(");
    expect(rebuild).toBeGreaterThan(-1);
    expect(asks[0]).toBeLessThan(rebuild);
    const tail = apply.slice(rebuild, apply.indexOf("setAbc(nextAbc)"));
    expect(tail).not.toMatch(/\bask\(|unappliedTextOk\(/);
    expect(positions(tail, /\bawait\b/g)).toHaveLength(1);
    // text typed during the rebuild refuses the apply instead (the text the user agreed to drop does not)
    expect(apply.slice(asks[0], rebuild)).toMatch(/const textDirtyOk = scoreTextDirty\.current;/);
    const typed = tail.match(/if \(([^)]*scoreTextDirty\.current[^)]*)\)\s*return showToast\(/);
    expect(typed?.[1]).toMatch(/nextAbc !== abc/);
    expect(typed?.[1]).toMatch(/!textDirtyOk/);
  });

  it("loads a planned score only with the editor's unapplied ABC text in view (rules.ts plannedScoreLoad)", () => {
    expect(PAGE).toMatch(/plannedScoreLoad\([^)]*textDirty: scoreTextDirty\.current/);
    expect(PAGE).toMatch(/d === "kept"/);
  });

  it("moves the replies to the song 「この譜面で再生成」 queued (適用 refuses a reply made for another song)", () => {
    const render = body("const renderNow = async (");
    const sent = render.indexOf("await api.generate(");
    expect(sent).toBeGreaterThan(-1);
    // the conversation continues with the new song, and its replies so far can still be applied to it
    const conv = render.indexOf("setConv(song.id);", sent);
    expect(conv).toBeGreaterThan(sent);
    const select = render.indexOf("selectSong(song.id);", conv);
    expect(select).toBeGreaterThan(conv);
    expect(render.slice(conv, select)).toContain('setTurns((ts) => ts.map((t) => (t.role === "assistant" ? { ...t, songId: song.id } : t)));');
    // what the re-stamp answers: a reply records its song, and 適用 compares it with the conversation's
    expect(body("const send = async (")).toMatch(/const turn: Turn = \{ role: "assistant",[^\n]*songId: convSong\.current\b/);
    expect(body("const apply = async (")).toContain('if ((t.songId ?? null) !== convSong.current) return showToast("error", "この提案は別の曲に対するものなので適用できません");');
    expect(body("const setConv = (")).toContain("convSong.current = id;");
  });

  it("キャンセル takes its instruction out of the conversation, and puts a typed one back into an empty box", () => {
    const cancel = body("const cancelSend = (");
    // only while a request is pending (conv.cancel() makes its late reply stale)
    expect(cancel).toMatch(/const id = conv\.cancel\(\);\s*if \(!id\) return;/);
    expect(cancel).toContain("api.llmCancel(id)");
    // the user turn send added last for it
    expect(cancel).toContain('setTurns((t) => (t.length > 0 && t[t.length - 1].role === "user" ? t.slice(0, -1) : t));');
    // typed into the box (not a chip or the melody re-ask), and not over what was typed since
    expect(cancel).toContain("const sent = sentInstruction.current;");
    expect(cancel).toContain("if (sent?.fromInput) setInput((cur) => (cur.trim() ? cur : sent.text));");
    const send = body("const send = async (");
    const begin = send.indexOf("conv.begin(requestId)");
    const userTurn = send.indexOf('setTurns((t) => [...t, { role: "user", text: instruction }]);');
    const record = send.indexOf("sentInstruction.current = { text: instruction, fromInput: Boolean(opts.fromInput) };");
    expect(begin).toBeGreaterThan(-1);
    expect(userTurn).toBeGreaterThan(begin);
    expect(record).toBeGreaterThan(begin);
    // both before the first wait for the LLM (a キャンセル can come at any time after conv.begin)
    expect(Math.max(userTurn, record)).toBeLessThan(send.indexOf("await edit("));
  });

  it("keeps 会話をリセット locked while 適用 rebuilds the hiragana version (the reply would be dropped)", () => {
    const reset = buttonAttrs(/会話をリセット\s*<\/button>/);
    expect(reset).toMatch(/disabled=\{[^}]*\bbusy\b/);
    expect(reset).toMatch(/disabled=\{[^}]*\bconverting\b/);
    expect(body("const resetConversation = (")).toMatch(/\bconverting\b/);
  });
});

describe("AI 編集's tempo question (「テンポが譜面と異なります」)", () => {
  it("is asked only when the style can follow the score's tempo (styleBpmDiffers, the sync's own check)", () => {
    const apply = body("const apply = async (");
    const dialog = apply.indexOf('title: "テンポが譜面と異なります"');
    expect(dialog).toBeGreaterThan(-1);
    const conds = Array.from(apply.slice(0, dialog).matchAll(/if \((sb !== null[^\n]*)\) \{/g), (m) => m[1]);
    expect(conds).toEqual(["sb !== null && styleBpmDiffers(r.style, bpm)"]);
  });

  it("is not asked for a Q: whose tempo the style cannot take (it offered 「スタイルを譜面の 0 BPM に合わせる」, which did nothing)", () => {
    for (const q of ["0.4", "1000000000000000000000"]) {
      const bpm = statedAbcTempo(`X:1\nM:4/4\nL:1/8\nQ:1/4=${q}\nK:C\nV:Vocal\nC8|\n`);
      expect(bpm, q).not.toBeNull();
      // the style names a tempo of its own, so the old check (sb !== Math.round(bpm)) asked
      expect(styleBpm("pop, 120 BPM"), q).not.toBe(Math.round(bpm!));
      expect(styleBpmDiffers("pop, 120 BPM", bpm!), q).toBe(false);
      expect(styleTempoSync("pop, 120 BPM", bpm), q).toBeNull();
    }
    // a tempo the style can take is still asked about
    expect(styleBpmDiffers("pop, 120 BPM", 96)).toBe(true);
  });
});

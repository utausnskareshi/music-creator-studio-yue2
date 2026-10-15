import { describe, expect, it } from "vitest";
import { REQUESTED_TITLE_MAX_CHARS } from "../../config/rules";
import { parseSongDraft, songSchema, systemPrompt, userMessage } from "../songwriter";

describe("parseSongDraft", () => {
  const meta = { seconds: 12.3, provider: "local", attempts: 1 };

  it("carries the request's timing, provider and number of tries (one unless the backend says otherwise)", () => {
    const content = JSON.stringify({ title: "t", lyrics: "[Verse]\n波", style: "pop, 100 BPM", selections: {}, explanation: "" });
    expect(parseSongDraft(content, { seconds: 70.2, provider: "local" })).toMatchObject({ seconds: 70.2, provider: "local", attempts: 1 });
    expect(parseSongDraft(content, { seconds: 130.5, provider: "local", attempts: 2 }).attempts).toBe(2);
  });

  it("maps a well-formed reply to lyrics, style and chip selection", () => {
    const content = JSON.stringify({
      title: "夏の終わり",
      lyrics: "[Verse]\n波の音が\n\n[Chorus]\nもう一度\n",
      style: "Japanese, ballad, warm female vocal, piano, strings, melancholic, 72 BPM",
      selections: { language: "Japanese", genres: ["ballad", "unknown-genre"], vocal: "female vocal", voice: ["emotional"], instruments: ["piano", "strings"], moods: ["melancholic"], bpm: 72 },
      explanation: "切ない夏の終わり。",
    });
    const d = parseSongDraft(content, meta);
    expect(d.title).toBe("夏の終わり");
    expect(d.lyrics.startsWith("[Verse]")).toBe(true);
    expect(d.style).toContain("72 BPM");
    expect(d.selection.groups.genre).toEqual(["ballad"]); // unknown values dropped
    expect(d.selection.groups.vocal).toEqual(["female vocal"]);
    expect(d.selection.bpm).toBe(72);
    expect(d.provider).toBe("local");
  });

  it("strips code fences and falls back to chips when style is missing", () => {
    const content = "```json\n" + JSON.stringify({ title: "", lyrics: "[Verse]\nla", style: "", selections: { language: "English", genres: ["rock"], vocal: "male vocal", voice: [], instruments: ["electric guitar"], moods: ["energetic"], bpm: 140 }, explanation: "" }) + "\n```";
    const d = parseSongDraft(content, meta);
    expect(d.style).toBe("English, rock, male vocal, electric guitar, energetic, 140 BPM");
  });

  it("reads the object out of surrounding text and reports unreadable replies in Japanese", () => {
    const body = JSON.stringify({ title: "", lyrics: "[Verse]\nla", style: "pop, 100 BPM", selections: {}, explanation: "" });
    expect(parseSongDraft(`以下が結果です。\n${body}\n以上です。`, meta).style).toBe("pop, 100 BPM");
    const truncated = body.slice(0, 40);
    let err: unknown = null;
    try {
      parseSongDraft(truncated, meta);
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toContain("JSON として読めませんでした");
    expect((err as Error & { cause?: unknown }).cause).toBeInstanceOf(SyntaxError);
    expect(() => parseSongDraft("[1, 2]", meta)).toThrow(/JSON として読めませんでした/);
    expect(() => parseSongDraft("申し訳ありませんが、お手伝いできません。", meta)).toThrow(/JSON として読めませんでした/);
  });

  it("caps the chip lists, clamps the tempo and follows the tempo the style states", () => {
    const reply = (selections: Record<string, unknown>, style = "") => JSON.stringify({ title: "", lyrics: "[Verse]\nla", style, selections, explanation: "" });
    const many = { language: "Japanese", genres: ["pop", "rock", "ballad", "jazz", "pop"], vocal: "female vocal", voice: ["clear", "powerful", "breathy", "husky"], instruments: ["piano", "synth", "strings", "drums", "bass", "brass"], moods: ["bright", "calm", "hopeful", "dramatic"], bpm: 300 };
    const d = parseSongDraft(reply(many), meta);
    expect(d.selection.groups.genre).toEqual(["pop", "rock", "ballad"]);
    expect(d.selection.groups.voice).toHaveLength(3);
    expect(d.selection.groups.inst).toHaveLength(5);
    expect(d.selection.groups.mood).toHaveLength(3);
    expect(d.selection.bpm).toBe(220);
    expect(d.style.endsWith("220 BPM")).toBe(true);
    expect(parseSongDraft(reply({ ...many, bpm: 12 }), meta).selection.bpm).toBe(40);
    expect(parseSongDraft(reply({ ...many, bpm: 0 }), meta).selection.bpm).toBe(0);
    // the style text names the tempo that is sent
    expect(parseSongDraft(reply({ ...many, bpm: 100 }, "Japanese, pop, 104 BPM"), meta).selection.bpm).toBe(104);
  });

  it("rejects empty lyrics", () => {
    expect(() => parseSongDraft(JSON.stringify({ lyrics: "", style: "x", selections: {}, title: "", explanation: "" }), meta)).toThrow();
  });

  it("has no instrumental vocal value and still parses old drafts that used it", () => {
    const s = songSchema() as { properties: { selections: { properties: { vocal: { enum: string[] } } } } };
    expect(s.properties.selections.properties.vocal.enum.some((v) => /instrumental/i.test(v))).toBe(false);
    const old = JSON.stringify({ title: "", lyrics: "[Verse]\nla", style: "J-pop, instrumental, no vocals", selections: { language: "Japanese", genres: ["J-pop"], vocal: "instrumental, no vocals", voice: [], instruments: ["piano"], moods: ["calm"], bpm: 90 }, explanation: "" });
    const d = parseSongDraft(old, meta);
    expect(d.selection.groups.vocal).toEqual([]);
    expect(d.style).toBe("J-pop, instrumental, no vocals");
    expect(systemPrompt("ja", "short")).toContain("インストゥルメンタル版を生成");
  });

  it("keeps the draft title to one line of at most REQUESTED_TITLE_MAX_CHARS characters, as the backend stores it", () => {
    const title = (t: string) => parseSongDraft(JSON.stringify({ title: t, lyrics: "[Verse]\nla", style: "pop, 100 BPM", selections: {}, explanation: "" }), meta).title;
    expect(title("夏の\n終わり")).toBe("夏の 終わり");
    expect(title(" 夏の\r\n\t 終わり \n")).toBe("夏の 終わり");
    // only line breaks and other control characters are replaced: a full-width space and a run of spaces stay
    expect(title("桜　舞う")).toBe("桜　舞う");
    expect(title("Love  Song")).toBe("Love  Song");
    // counted in code points (an emoji is one character), with no space left at the cut
    expect(Array.from(title("あ".repeat(REQUESTED_TITLE_MAX_CHARS + 12)))).toHaveLength(REQUESTED_TITLE_MAX_CHARS);
    expect(title("🎵".repeat(REQUESTED_TITLE_MAX_CHARS + 1))).toBe("🎵".repeat(REQUESTED_TITLE_MAX_CHARS));
    expect(title(`${"a".repeat(REQUESTED_TITLE_MAX_CHARS - 1)} b`)).toBe("a".repeat(REQUESTED_TITLE_MAX_CHARS - 1));
    // the limit is named in the schema (not as maxLength: not every provider's strict mode takes it)
    const s = songSchema() as { properties: { title: { description: string } } };
    expect(s.properties.title.description).toContain(`${REQUESTED_TITLE_MAX_CHARS} 文字以内`);
  });

  it("schema enumerates the chip vocabulary", () => {
    const s = songSchema() as { properties: { selections: { properties: { genres: { items: { enum: string[] } } } } } };
    expect(s.properties.selections.properties.genres.items.enum).toContain("city pop");
  });
});

describe("the lyrics language and the length of a draft", () => {
  type LangSchema = { properties: { selections: { properties: { language: { enum: string[] } } } } };
  const langEnum = (s: unknown) => (s as LangSchema).properties.selections.properties.language.enum;
  const reply = (language: string, style = "Chinese, ballad, 70 BPM") => JSON.stringify({ title: "t", lyrics: "[Verse]\n星", style, selections: { language, genres: ["ballad"], vocal: "female vocal", voice: [], instruments: ["piano"], moods: ["calm"], bpm: 70 }, explanation: "" });

  it("asks for the lyrics language's chip in the schema (any chip for another language)", () => {
    expect(langEnum(songSchema("ja"))).toEqual(["Japanese"]);
    expect(langEnum(songSchema("en"))).toEqual(["English"]);
    expect(langEnum(songSchema("zh"))).toEqual(["Mandarin"]);
    expect(langEnum(songSchema("other"))).toEqual(["Japanese", "English", "Mandarin", "Korean"]);
    expect(langEnum(songSchema())).toEqual(langEnum(songSchema("other")));
  });

  it("sets the language chip from the lyrics language; for another language only a chip the style names", () => {
    const meta = { seconds: 1, provider: "local" };
    // a model that picked another chip (as Qwen3 did for Mandarin and Spanish lyrics)
    expect(parseSongDraft(reply("Japanese"), { ...meta, language: "zh" }).selection.groups.lang).toEqual(["Mandarin"]);
    expect(parseSongDraft(reply("Japanese"), { ...meta, language: "other" }).selection.groups.lang).toEqual([]);
    expect(parseSongDraft(reply("Japanese"), { ...meta, language: "en" }).selection.groups.lang).toEqual(["English"]);
    // without the request, the model's chip (an older caller)
    expect(parseSongDraft(reply("Korean"), meta).selection.groups.lang).toEqual(["Korean"]);
    // the other chips stay
    expect(parseSongDraft(reply("Japanese"), { ...meta, language: "other" }).selection.groups.genre).toEqual(["ballad"]);
    // another language that the vocabulary has (Korean lyrics are "other"): the model's chip when the style names it
    expect(parseSongDraft(reply("Korean", "Korean, pop, 120 BPM"), { ...meta, language: "other" }).selection.groups.lang).toEqual(["Korean"]);
    expect(parseSongDraft(reply("Korean", " korean , pop"), { ...meta, language: "other" }).selection.groups.lang).toEqual(["Korean"]);
    expect(parseSongDraft(reply("Korean", "Spanish, Latin, 128 BPM"), { ...meta, language: "other" }).selection.groups.lang).toEqual([]);
    // without a style text the chip has nothing to agree with (the style is then built from the chips)
    expect(parseSongDraft(reply("Korean", ""), { ...meta, language: "other" }).selection.groups.lang).toEqual([]);
  });

  it("names the language word and the structure rules in the prompt, and the length again in the user message", () => {
    expect(systemPrompt("zh", "standard")).toContain('style の最初の語（言語）と selections.language は "Mandarin" にする');
    expect(systemPrompt("other", "short")).toContain("歌詞の言語の英語名（例: Spanish）");
    expect(systemPrompt("other", "short")).toContain("selections.language は、歌詞の言語が語彙にあればその語にする");
    for (const length of ["short", "standard", "long"] as const) expect(systemPrompt("ja", length)).toContain("構成のセクションの数・順番・各セクションの行数を必ず守る");
    expect(systemPrompt("ja", "short")).toContain("構成（長さ: 短め（約 1 分））: [Verse] 4 行 → [Chorus] 4 行");
    expect(userMessage("  女性ボーカルで切ないラブソング \n", "short")).toBe("曲のイメージ:\n女性ボーカルで切ないラブソング\n\n長さ: 短め（約 1 分）。構成: [Verse] 4 行 → [Chorus] 4 行（合計 8〜10 行、約 1 分）");
    expect(userMessage("x", "long")).toContain("長さ: 長め（約 4 分）。構成: [Intro]");
  });
});

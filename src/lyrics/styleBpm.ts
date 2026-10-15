// Tempo in the style prompt ("..., 96 BPM"). The official skill asks for the same tempo in the ABC (Q:1/4=96)
// and in the style (generation-and-covers.md: "Put tempo and meter in the ABC and describe them consistently
// in the style"); the ComfyUI tokenizer gives the model both. When a fixed ABC is sent, the ABC is the plan the
// audio follows, so the style is brought in line with it, never the other way round without asking.

// "96 BPM", "88bpm", "140-BPM" or a range "60-70 BPM" / "60~70 BPM" / "60〜70 BPM" (also the dashes ‐ – — ― − and
// the full-width ～ － a Japanese IME types; a range is one tempo statement and is replaced whole), also written the
// other way round ("BPM 140", "BPM:140", "BPM140", "bpm=140", "BPM＝140", "BPM-140", "BPM ‐ 140", "BPM≒140",
// "BPM: ~140", "BPMは140", "BPMが140", "BPMを140くらいに", "BPMも140", "BPMで140", "BPMは、140", "BPM約140",
// "BPMはおよそ140", "BPM around 140", "a BPM of 140", "BPM (140)", "BPM [140]"), in full-width characters
// ("１４０ ＢＰＭ") and spelled out ("140 beats per minute", "140 beats-per-minute"). A single "NN BPM" is a whole
// number of any length (with its decimals): every tempo withStyleBpm writes ("8 BPM", "1200 BPM" for an odd Q:) is
// read back, so the sync with a score's Q: does not append it again on every send. A range before BPM keeps 2-3
// digits, so a meter or a label number is never read as a tempo ("4/4 - 120 BPM", "Track 1 – 120 BPM"). "NN BPM" is
// the tempo wherever it stands.
// "BPM NN" is read only when the style has no "NN BPM", and only as a tempo of 10-299: a drum machine's "808" or
// "909" after BPM is no tempo ("medium BPM 808 drums", "高BPM 808ベース", "trap, BPM 909"), and the sync must not
// overwrite it. Nor is it read after a Latin word joined to BPM by a dash (DASHED_WORD: "low-BPM 120 bass"), where
// BPM is a modifier; a Latin word attached to BPM makes one word with it ("uptempoBPM 120"). A word of another script
// attached to BPM is no modifier: Japanese puts no spaces between words ("テンポはBPM120", "女性ボーカルBPM128",
// "80年代BPM120", "高BPM 140" name a tempo). After a word and spaces, BPM starts a tag of a space-separated list
// ("J-POP 女性ボーカル BPM120", "ロック　ＢＰＭ１４０", "rock BPM: 140", "high BPM 140") and its tempo is read. A
// decade, a meter, a decimal, a word joined by a dash, a range end out of 10-299 or a number below 40 with a word
// after it (COUNT) after BPM is no tempo either ("BPM 90s", "BPM 90年代", "BPM 12/8", "BPM 96.5x", "BPM 12-string",
// "BPM 100-300", "高BPM 16ビート", "high BPM 16 step", "medium BPM 32 bars"), nor is an amount of change (change:
// "BPMが10%アップ", "BPMを50上げて", "BPMを50落として"): what the number names is read, not what stands before BPM.
const ALNUM = "[0-9０-９A-Za-zＡ-Ｚａ-ｚ_]";
const DIGIT = "[0-9０-９]";
const NUM = String.raw`${DIGIT}+(?:[.．]${DIGIT}+)?`;
const NN = `${DIGIT}{2,3}`;
/** a tempo written after BPM: 10-299 (never "808" or "909") */
const TEMPO = `(?:[12１２]${DIGIT}{2}|[1-9１-９]${DIGIT})`;
/** a dash: the hyphens - ‐ ‑, the dashes ‒ – — ―, the minus sign −, the tildes ~ 〜 ～ and the full-width － */
const DASH = "[-‐‑‒–—―−~〜～－]";
/**
 * a hyphen that joins a number to BPM ("140-BPM", "１４０－ＢＰＭ"; also the figure dash and the minus sign: "140‒BPM",
 * "140−BPM") and the words of "beats-per-minute"
 */
const HYPHEN = "[-‐‑‒−－]";
/** "BPM", also spelled out ("140 beats per minute", "140 beats-per-minute") */
const WORD = String.raw`(?:[BＢ][PＰ][MＭ]|beats(?:\s+|${HYPHEN})per(?:\s+|${HYPHEN})minute)`;
const LETTER = String.raw`[\p{L}\p{M}_]`;
const LATIN = "[A-Za-zＡ-Ｚａ-ｚ]";
/** spaces within a line (a line break starts an item, as a comma does) */
const HSPACE = String.raw`[^\S\n\r\u2028\u2029]`;
/**
 * after a number below 40 (BPM_MIN, the slowest tempo the slider and an AI song draft set): a word on its line,
 * attached to the number or after spaces or a dash. The number counts what the word names ("16ビート", "16 beat",
 * "32 bars", "16 step", "16 notes", "12 string", "16分", "12拍", "16-ビート") and is no tempo, whatever the word is. A
 * number below 40 that ends its item is a tempo ("trap, BPM 30", "BPM 30, drone"), and a number of 40-299 is one
 * whatever word follows ("BPM128 ビート強め", "hip hop BPM 90 beats", "BPM140分厚いベース"), other than an amount of
 * change (change: a percentage, or a word of raising or lowering after a number below 100).
 */
/** an arrow of raising or lowering after a number ("BPMが20↑", "BPMを20↓"): it counts a change too */
const ARROW = "[↑↓⤴⤵⬆⬇]";
const COUNT = String.raw`(?<=(?<!${DIGIT}|[.．])[1-3１-３]${DIGIT}(?:[.．]${DIGIT}+)?)${HSPACE}*(?:${DASH}${HSPACE}*)?(?:[\p{L}\p{N}]|${ARROW})`;
/**
 * "about" before a tempo: 約, ≒, ≈, a tilde, (お)およそ, 大体, だいたい or an English word ("BPM≒140", "BPM: ~140",
 * "BPM（約140）", "BPMはおよそ140", "BPM around 140", "BPM approx. 140")
 */
const ABOUT = String.raw`(?:[約≒≈~〜～]|お?およそ|大体|だいたい|around|about|approx(?:imately|\.)?|roughly)`;
/**
 * between BPM and the tempo after it: a colon, an equals sign, a dash, a particle (は, が, を, も, で, also with a
 * reading comma: "BPMは140", "BPMが140くらいの疾走感", "BPMを140くらいに", "BPMも140", "BPMで140", "BPMは、140") or
 * "of" ("a BPM of 140"), then "about" (ABOUT: "BPM: ~140", "BPM：～140", "BPMは約140", "BPMはおよそ140",
 * "BPM around 140"). After を, が or も (CLAUSE_LEAD) BPM is the object or subject of the verb that follows the number
 * ("BPMを 50 上げる"); after the others (TAG_LEAD) the number ends a tag or states the tempo ("BPMは70 遅くて切ない").
 */
const CLAUSE_LEAD = String.raw`\s*[をがも][、，]?\s*(?:${ABOUT}\s*)?`;
const TAG_LEAD = String.raw`\s*(?:(?:[:=：＝]|[はで][、，]?|of|${DASH})\s*)?(?:${ABOUT}\s*)?`;
/**
 * a word of raising or lowering a tempo: 上げる, 上がる, 下げる, 下がる, 引き上げる, 引き下げる, 落とす, 落ちる, 速く, 遅く,
 * 早く, 速める, 早める (also 速めます, 速めよう, 速めなさい), 遅らせる, 増やす, 増す, 減らす, the verbs of 上昇, 低下, 増加, 減少, 加速
 * and 減速 (上昇させる, 低下する), アップ, ダウン, プラス, マイナス, also in hiragana (あげる, あがる, さげる, さがる, ひきあげる,
 * ひきさげる, おとす, おちる, はやく, おそく, はやめる, ふやす, へらす). 落ち only as a form of the verb, not 落ち着く, 落ち込む or 落ちサビ
 * ("BPM 70 落ち着いたバラード", "BPM90落ちサビ" name a tempo), おと only as おとす, not おとなしい, はやく not as はやくち
 * (早口: "BPM90はやくちラップ"), ふや and へら only as ふやす and へらす (not ふやける, へらへら), the nouns 上昇 and 加速 only
 * as verbs ("BPM90上昇感"), and the katakana words only as a word of their own, not starting a longer one
 * ("BPM 80 ダウンテンポ", "BPM 90 マイナスワン音源").
 */
/**
 * the end of an imperative: no hiragana after it but a particle (上げろよ, 上げろって, 上げろや, 上げろと, and the
 * conditional 上がれば: an amount too) or a drawn-out sound (上がれぇ, 上がれええ, 上げろお), and not 目 or 腰 (引け目,
 * 引け腰). 上がれる, 落とせない, 増やせる, 上がれた and 引けを取らない are other forms that start alike: they describe
 * what follows (a tag).
 */
const IMP_END = "(?!(?![よっやぉぇばとえお])[ぁ-ゖ]|[目腰])";
const CHANGE_WORD = String.raw`(?:(?:引き?|ひき)?[上下あさ]げ|[上下あさ]が|落と|おと(?:[しすせ]|そう)|[落お]ち(?:[るてたまろ]|よう|よ${IMP_END}|なさい)|速く|遅く|早く|はやく(?!ち)|おそく|(?:[速早]|はや)め(?:[てるろ]|ま[すしせ]|よう|よ${IMP_END}|なさい)|遅ら[さしすせ]|増や|ふや(?:[さしすせ]|そう)|増[しすせそ]|減ら|へら(?:[さしすせ]|そう)|(?:上昇|低下|増加|減少|加速|減速)(?:[さしす]|せ(?![ずぬ]))|(?:アップ|ダウン|プラス|マイナス)(?![ァ-ヿ]))`;
/**
 * between an amount and its word of raising or lowering: "about" (also 位 for くらい, 近く, 強 and 弱), "only" (だけ,
 * ばかり), "each", "or more" or "as much as" (not ちょっと or あまり: they are adverbs too, "BPM 90 ちょっと上がる曲")
 */
const HEDGE = "(?:くらい|ぐらい|位|ほど|程度?|前後|近く|強|弱|だけ|ばかり|ずつ|以上|以下|も)";
const CHANGE_NOUN = "(?:上昇|低下|増加|減少|加速|減速|アップ|ダウン|プラス|マイナス)";
/**
 * a word of raising or lowering written as a verb that ends its word: the て form (上げて, 上がって, 落として, 落ちて,
 * 遅らせて, 増やして, 減らして, 速くして, 遅くなって, 速めて, アップして, 上昇させて), also in hiragana and with 引き
 * (あげて, 引き下げて), the dictionary form followed by no letter but a sentence-final よ, ぞ or ね (DICT_END: 上げる,
 * 上げるよ, 下がる, 落とす, 落ちる, 増やす, 速くする, 早める, アップする, 加速させる), or a polite, volitional or imperative
 * form (上げます, 下げません, 上げよう, 上げろ: CHANGE_POLITE, CHANGE_VOLITIONAL, CHANGE_IMPERATIVE). A form that describes
 * the next word ("上がる曲", "加速するサビ", "落ちる系"), another form ("落とした感じ") or an adjective ("遅くて切ない",
 * "早くない") is none: it can start a tag.
 */
const CHANGE_TE = String.raw`(?:(?:引き?|ひき)?[上下あさ]げて|[上下あさ]がって|[落お]として|[落お]ちて|遅らせて|[増ふ]やして|[減へ]らして|増して|(?:[速遅早]|はや|おそ)く(?:して|なって)|(?:[速早]|はや)めて|${CHANGE_NOUN}(?:させて|して))`;
const CHANGE_DICT = String.raw`(?:(?:引き?|ひき)?[上下あさ]げる|[上下あさ]がる|[落お]とす|[落お]ちる|遅らせる|[増ふ]やす|[減へ]らす|増す|(?:[速遅早]|はや|おそ)く(?:する|なる)|(?:[速早]|はや)める|${CHANGE_NOUN}(?:させる|する))`;
/** the end of a dictionary form: no letter after it, but the sentence-final よ, ぞ or ね (上げるよ; not 上がるような曲) */
const DICT_END = String.raw`(?!(?![よぞね](?!${LETTER}))${LETTER})`;
/**
 * the polite, volitional and imperative forms of these verbs (上げます, 下げました, 落としましょう, 速くします, 上げません,
 * アップします, 上げなさい; 上げよう, 落とそう, 増そう, 速くなろう; 上げろ, 上げよ, 落とせ, 速くしろ, 加速せよ): they never
 * describe a word after them
 */
const POLITE = "(?:ま(?:す|した|しょう|せん)|なさい)";
const CHANGE_POLITE = String.raw`(?:(?:(?:引き?|ひき)?[上下あさ]げ|[上下あさ]がり|[落お]とし|[落お]ち|遅らせ|[増ふ]やし|[減へ]らし|増し|(?:[速遅早]|はや|おそ)く(?:し|なり)|(?:[速早]|はや)め|${CHANGE_NOUN}(?:させ|し))${POLITE})`;
const CHANGE_VOLITIONAL = String.raw`(?:(?:引き?|ひき)?[上下あさ]げよう|[上下あさ]がろう|[落お]とそう|[落お]ちよう|遅らせよう|[増ふ]やそう|[減へ]らそう|増そう|(?:[速遅早]|はや|おそ)く(?:しよう|なろう)|(?:[速早]|はや)めよう|${CHANGE_NOUN}(?:させよう|しよう))`;
const CHANGE_IMPERATIVE = String.raw`(?:(?:(?:引き?|ひき)?[上下あさ]げ[ろよ]|[上下あさ]がれ|[落お]とせ|[落お]ち[ろよ]|遅らせ[ろよ]|[増ふ]やせ|[減へ]らせ|増せ|(?:[速遅早]|はや|おそ)く(?:しろ|なれ|せよ)|(?:[速早]|はや)め[ろよ]|${CHANGE_NOUN}(?:させ[ろよ]|しろ|せよ))${IMP_END})`;
const CHANGE_VERB = String.raw`(?:${CHANGE_TE}|${CHANGE_POLITE}|${CHANGE_VOLITIONAL}|${CHANGE_IMPERATIVE}|${CHANGE_DICT}${DICT_END})`;
/**
 * In a clause (after を, が or も: CLAUSE_LEAD) BPM is the object or subject of what follows its number, so more words
 * make the number an amount: the adverbs and adjectives 高く, 低く, 速い, 遅い, 早い, 速めに, 遅めに, 高める, 低めに
 * ("サビでBPMを50ほど高く", "BPMも40低く", "BPMが50速い", "BPMを50速めに"), the nouns 上昇, 低下, 増加, 減少, 加速, 減速, 増
 * and 減 ending their word ("BPMが50加速", "BPMを60減速", "BPMを50増"; not "BPMが90上昇感"), 足す and 引く ("BPMを50足して"),
 * also polite, volitional or imperative (高めます, 引きなさい, 高めよう, 足そう, 引こう, 高めろ, 高めよ, 足せ, 引け: IMP_END), and an arrow
 * ("BPMが50↑"). "BPMが60おちついた雰囲気" and "BPMが90の曲" still name a tempo.
 */
const CLAUSE_CHANGE = String.raw`(?:${CHANGE_WORD}|(?:[高低]|たか|ひく)(?:く|め(?:[にてるろ]|ま[すしせ]|よう|よ${IMP_END}|なさい))|(?:[速遅早]|はや|おそ)(?:い|めに)|(?:上昇|低下|増加|減少|加速|減速|[増減])(?!${LETTER})|足(?:[しすそ]|せ${IMP_END})|引(?:[いくこ]|け${IMP_END}|き(?:ま[すしせ]|なさい))|${ARROW})`;
/**
 * A verb after a reading comma in a clause: CHANGE_VERB and the verbs of the words CLAUSE_CHANGE adds (高くして,
 * 低くなって, 高めて, 高くする, 高める, 足して, 足す, 引いて, 引く, their polite forms 高くします, 高めます, 足します, 引きます,
 * their volitional forms 高くしよう, 高くなろう, 高めよう, 足そう, 引こう and imperative forms 高くしろ, 高くせよ, 高めろ, 高めよ, 足せ, 引け),
 * not their other forms ("高く伸びるサビ" describes it).
 */
const CLAUSE_VERB = String.raw`(?:${CHANGE_VERB}|(?:[高低]|たか|ひく)(?:く(?:して|なって)|めて)|(?:(?:[高低]|たか|ひく)(?:く(?:する|なる)|める)|足す|引く)${DICT_END}|足して|引いて|(?:(?:[高低]|たか|ひく)(?:く(?:し|なり)|め)|足し|引き)${POLITE}|(?:[高低]|たか|ひく)(?:く(?:しよう|なろう)|めよう)|足そう|引こう|(?:(?:[高低]|たか|ひく)(?:く(?:しろ|なれ|せよ)|め[ろよ])|足せ|引け)${IMP_END})`;
/**
 * after a number after BPM: a percentage, whatever the size of the number ("BPMが10%アップ", "BPMは20％遅め",
 * "BPM 50 percent faster", "BPM 100%"), or after a number below 100 a word of raising or lowering (CHANGE_WORD), also
 * after hedges (HEDGE) ("BPMを50上げて", "サビだけBPMが40上がる", "BPMを50落として", "BPMが50速くなる",
 * "BPMを40増やして", "BPMが50アップ", "BPMを50くらい上げて", "BPMを40ほど下げて", "BPMを50以上も落として"). The number
 * is an amount of change, no tempo. In a clause (CLAUSE_LEAD: `clause`) spaces separate no tags ("BPMを 50 上げる",
 * "BPMが40 上がる"). After a tag (TAG_LEAD) a space separates the tags of a list, and Japanese writes an amount
 * attached to its number, so the word is an amount when it is attached to the number and its hedges
 * ("サビでBPM50アップ", "BPM 50くらい上げて"), after a hedge after a space (a hedge starts no tag: "BPM 50 くらい上げて",
 * "BPM 50 程度アップ"), or when it is a verb after a space (CHANGE_VERB: "BPM 50 上げて", "Cメロ BPM 60 下げる",
 * "BPM 50 速くして", "BPM 50くらい 上げて"). Any other word after a space starts a new tag and the number before it is
 * a tempo ("BPM 70 遅くて切ない", "BPM 80 ダウン系", "BPM 90 上げ曲", "BPM 90 落ちサビ", "BPM 90 上がる曲",
 * "BPM 70くらい 落とした感じ", "BPMは70 遅くて切ない"), also a bare アップ or ダウン ("BPM 80 アップ!", so
 * "サビで BPM 50 アップ" names 50). A raise or drop of 100 BPM or more is no realistic amount: after a tempo of 100 or
 * more such a word describes the song ("BPM128 アップな曲調", "BPM 140 上がる曲", "BPM 140 速くて重い"). Another word
 * between them names the tempo raised or lowered to ("BPMを80に落として", "BPMを80まで下げて" name 80). (A plus sign
 * before the number is never read: "BPM +10"; nor a multiple: "BPM 2倍" is below 10; nor a number below 40 with a word
 * after it, spaced or not: COUNT, "サビでBPM 10 上げる".) In a clause the words of CLAUSE_CHANGE count too, and after a
 * reading comma or an exclamation mark a verb (CLAUSE_VERB: "BPMを40程度、上げて", "BPMを20!上げて"); any other word
 * after one starts the next tag ("BPMが66、遅い", "BPMが90、加速するサビ" name a tempo). `bracket`: the number stood in
 * brackets, which close before the word (in a clause only: "BPMを（20）上げて", "BPMが【20】アップ"; in a tag list the
 * brackets end the tag but before a verb or a hedge, BRACKET_VERB: "BPM（80）ダウン系").
 */
const change = (clause: boolean, bracket = false) => {
  const amount = clause
    ? String.raw`${HSPACE}*(?:${HEDGE}${HSPACE}*)*(?:${CLAUSE_CHANGE}|[、，!！]${HSPACE}*(?:${HEDGE}${HSPACE}*)*${CLAUSE_VERB})`
    : String.raw`(?:${HEDGE})*(?:${CHANGE_WORD}|${HSPACE}+(?:${HEDGE}${HSPACE}*)+${CHANGE_WORD}|${HSPACE}+${CHANGE_VERB})`;
  const close = bracket ? String.raw`\s*[)）\]］】]` : "";
  return String.raw`(?:${HSPACE}*(?:[%％]|percent|パーセント)|(?<=(?<!${DIGIT}|[.．])[1-9１-９]${DIGIT}(?:[.．]${DIGIT}+)?${close})${amount})`;
};
/**
 * a Latin word joined to BPM by a dash ("low-BPM", "low–BPM", "ｓｌｏｗ－ＢＰＭ"), other than the label "tempo"
 * ("tempo-BPM 120", "Ｔｅｍｐｏ－ＢＰＭ １２０" name 120). A spaced dash separates ("rock - BPM 120").
 */
const DASHED_WORD = String.raw`${LATIN}(?<!(?<!${LATIN})(?:tempo|ｔｅｍｐｏ))${DASH}`;
const plain = (s: string) => `(?:${s})`;
// A number before BPM starts at a word boundary, never inside "v120" or "1120" or after the point of "96.5", and
// never right after a number and a slash (the "8" of "12/8 BPM", the "4" of "4/4-BPM 120"; a slash after a word
// separates tags: "ロック/120BPM" is read); a number after BPM ends at one (not "90s", "96.5x", "12/8"; but
// "BPM140/ロック" is read). A hyphen joins a number of two digits or more to BPM, only without spaces and only a
// number of its own, not the end of a label ("140-BPM"; not "Track 1 - BPM 120", "Vol.2-BPM 120", "Vol.12-BPM 120"
// or "TR-808-BPM"). Only the groups of the matching form are set: one number, or the two ends of a range.
const forwardSource = (g: (s: string) => string) =>
  String.raw`(?<!${ALNUM})(?<!${DIGIT}[.．])(?<!${DIGIT}[/／])(?:${g(NN)}${HSPACE}*${DASH}${HSPACE}*${g(NN)}|${g(NUM)})(?:${HSPACE}*|(?<=(?<![.．]|${LETTER}${DASH}|${DIGIT})${DIGIT}{2,})${HYPHEN})${WORD}(?!${ALNUM})`;
/**
 * In a tag list, a number below 100 in brackets is an amount where it would be one without them (change(false)): before
 * a verb (CHANGE_VERB, attached or after spaces: "BPM（50）上げて" as "BPM 50 上げて"), and before a word of raising or
 * lowering after a hedge ("BPM（50）くらい上げて", "BPM（50） 程度アップ"). Any other word after the brackets starts a tag
 * ("BPM（80）ダウン系", "BPM（50）アップ").
 */
const BRACKET_VERB = String.raw`(?!(?<=(?<!${DIGIT}|[.．])[1-9１-９]${DIGIT}(?:[.．]${DIGIT}+)?\s*[)）\]］】])(?:${HSPACE}*${CHANGE_VERB}|(?:${HEDGE})+(?:${CHANGE_WORD}|${HSPACE}+${CHANGE_VERB})|(?:${HEDGE})*${HSPACE}+(?:${HEDGE}${HSPACE}*)+${CHANGE_WORD}))`;
// `ranges`: "BPM NN - NN" may be a range (BPM_RE); without them, only its first number is read (bpmMatch).
const tempoSource = (cap: boolean, ranges = true) => {
  const g = cap ? (s: string) => `(${s})` : plain;
  const single = g(String.raw`${TEMPO}(?:[.．]${DIGIT}+)?`);
  // (a range on one line: a line break ends an item, as a comma does)
  const range = String.raw`(?:${g(TEMPO)}${HSPACE}*${DASH}${HSPACE}*${g(TEMPO)}|${single})`;
  const tempo = ranges ? range : single;
  // (a "NN BPM" before this "BPM NN" would have matched first; the lookahead finds one after it). A tempo in brackets
  // is read with them ("BPM (140)", "BPM [140]", "BPM【140】" become "88 BPM"), and only alone in them; in a clause an
  // amount of change after them is no tempo either ("BPMを（20）上げて"). A range of amounts is no tempo, nor is its
  // first end alone ("BPM 50 - 60 上げて": a first end of 100 or more is no amount, "BPM 124 - 55% swing" names 124).
  const after = (clause: boolean) =>
    String.raw`(?:[(（[［【]\s*(?:${ABOUT}\s*)?${range}\s*[)）\]］】]${clause ? `(?!${change(true, true)})` : BRACKET_VERB}|${tempo}(?!${ALNUM}|年|[.．]${DIGIT}|[/／]${DIGIT}|${DASH}${ALNUM}|${COUNT}|${change(clause)}|(?<=(?<!${DIGIT}|[.．])[1-9１-９]${DIGIT}(?:[.．]${DIGIT}+)?)${HSPACE}*${DASH}${HSPACE}*${TEMPO}${change(clause)}))`;
  const reversed = String.raw`(?<!${ALNUM})(?<!${DASHED_WORD})${WORD}(?![\s\S]*${forwardSource(plain)})(?:${CLAUSE_LEAD}${after(true)}|${TAG_LEAD}${after(false)})`;
  return `${forwardSource(g)}|${reversed}`;
};
// ("u" for the letter classes of LETTER and COUNT)
export const BPM_RE = new RegExp(tempoSource(true), "iu");
// (sticky: read where BPM_RE found the pair, never at a later statement)
const BPM_FIRST_END_RE = new RegExp(tempoSource(true, false), "iuy");
/**
 * the end of an item after a tempo statement: spaces and periods, then a comma, a line break or the end of the text
 * (any number of periods: the StyleBuilder strips one before it looks for the tempo token; one class, linear time)
 */
const ITEM_END = new RegExp(String.raw`^(?:${HSPACE}|[.．。])*(?:[,，、\n\r  ]|$)`, "u");
/** A comma-separated style item that is only a tempo statement (one of BPM_RE's forms), its closing period as group 1. */
export const BPM_TOKEN = new RegExp(String.raw`^(?:${tempoSource(false)})(\.?)$`, "iu");

const tempoNumber = (s: string) => Number(s.replace(/[０-９．]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0)));
const matchNumbers = (m: RegExpExecArray) => m.slice(1).filter((x): x is string => x !== undefined).map(tempoNumber);

/**
 * The tempo statement styleBpm reads (BPM_RE's match). "BPM NN - NN" with a smaller second number is no range: a tempo
 * range goes up. Where the pair ends its item ("trap, BPM 140 - 70", "BPM 174-87") its first number is read and the
 * pair is replaced whole, as the StyleBuilder replaces a lone tempo token; where words follow, the second number counts
 * something else ("EDM, BPM 128 - 64 bars intro"): the first number alone, where it can stand alone ("BPM 140-70
 * half-time" names none). Always at the same place, never a later statement. ("NN - NN BPM" and a range in brackets
 * stay ranges.)
 */
export function bpmMatch(text: string): RegExpExecArray | null {
  const m = BPM_RE.exec(text);
  if (!m || m[1] !== undefined || /^[^0-9０-９]*[(（[［【]/.test(m[0])) return m;
  const n = matchNumbers(m);
  if (!(n.length === 2 && n[1] < n[0])) return m;
  if (ITEM_END.test(text.slice(m.index + m[0].length))) {
    // (the groups of the pair's ends follow each other: the second one is dropped)
    m[m.findIndex((x, i) => i > 0 && x !== undefined) + 1] = undefined as unknown as string;
    return m;
  }
  BPM_FIRST_END_RE.lastIndex = m.index;
  return BPM_FIRST_END_RE.exec(text);
}

/** `text` with the tempo statement bpmMatch finds replaced by `replacement` (unchanged when there is none). */
export function replaceBpm(text: string, replacement: string): string {
  const m = bpmMatch(text);
  return m ? text.slice(0, m.index) + replacement + text.slice(m.index + m[0].length) : text;
}

/** Tempo range of the tempo slider and of an AI song draft (a score's Q: may still name a tempo outside it). */
export const BPM_MIN = 40;
export const BPM_MAX = 220;

/**
 * The style's tempo: its first "NN BPM", else its first "BPM NN" (the middle of a range, rounded), or null when the style
 * names no tempo (or "0 BPM").
 */
export function styleBpm(style: string): number | null {
  const m = bpmMatch(style);
  if (!m) return null;
  // the matching form's tempo or range ends (the other forms' groups are unset)
  const n = matchNumbers(m);
  const bpm = Math.round(n.reduce((s, x) => s + x, 0) / n.length);
  return bpm > 0 ? bpm : null;
}

/**
 * The style with its tempo set to `bpm`: the tempo styleBpm reads (or its range) is replaced, otherwise ", NN BPM" is appended
 * (before a closing period, so free prose stays a sentence). Other wording is left untouched.
 */
export function withStyleBpm(style: string, bpm: number): string {
  const b = Math.round(bpm);
  if (bpmMatch(style)) return replaceBpm(style, `${b} BPM`);
  const base = style.replace(/[,\s]+$/, "");
  if (!base) return `${b} BPM`;
  if (base.endsWith(".")) return `${base.slice(0, -1).replace(/[,\s]+$/, "")}, ${b} BPM.`;
  return `${base}, ${b} BPM`;
}

/**
 * True when the style names a tempo that differs from `bpm` (rounded), or names none at all. False for a `bpm` that
 * rounds to no tempo withStyleBpm can write and styleBpm read back (below 0.5: "0 BPM"; beyond the safe integers:
 * "1e+21 BPM"), which an odd Q: can still state: the sync would rewrite the style again on every send.
 */
export function styleBpmDiffers(style: string, bpm: number): boolean {
  const b = Math.round(bpm);
  if (!Number.isSafeInteger(b) || b < 1) return false;
  const s = styleBpm(style);
  return s === null || s !== b;
}

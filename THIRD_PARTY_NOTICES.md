# サードパーティ ソフトウェア・モデルについて

Music Creator Studio YuE2 本体（このリポジトリ）は [Apache License 2.0](LICENSE)（Copyright 2026 歌うＬＩＮＥ彼氏。アプリのインストール先では `LICENSE.txt`）です。

## 1. セットアップでダウンロードするもの（アプリには同梱しません）

アプリは初回セットアップ時（と「セットアップをやり直す」で選んだとき）に、以下をユーザーの PC にダウンロードし、別プロセスとして実行または読み込みます。いずれも本アプリには同梱していません。

| コンポーネント | 用途 | ライセンス | 配布元 |
|---|---|---|---|
| YuE2-3B（BF16 / INT8）・YuE2-Vae | 音楽生成 | CC BY-NC 4.0 ＋ 個人クリエイター許諾（2026-09-16） | https://huggingface.co/Comfy-Org/YuE2 （原著: https://huggingface.co/m-a-p/YuE2-3B ） |
| SheetSage2 | 音声→ABC 転写（カバー / 耳コピ） | CC BY-NC 4.0（YuE2 の個人クリエイター許諾は、明示的には YuE2-3B / YuE2-Vae の重みだけが対象） | https://huggingface.co/m-a-p/SheetSage2 （Comfy-Org 経由で配布） |
| ComfyUI（Windows portable、Python / PyTorch 同梱） | 推論バックエンド | GPL-3.0（ComfyUI）、各同梱ライブラリのライセンス | https://github.com/Comfy-Org/ComfyUI |
| ffmpeg（BtbN win64 GPL ビルド） | 形式変換、ラウドネス正規化 | GPL-3.0 | https://github.com/BtbN/FFmpeg-Builds |
| 7-Zip 単体展開ツール（7zr.exe） | .7z の展開 | GNU LGPL（7-Zip。https://www.7-zip.org/license.txt ） | https://github.com/ip7z/7zip （7-Zip の公式リリース。https://www.7-zip.org/ ） |
| llama.cpp（llama-server） | ローカル LLM サーバー | MIT（配布物に含まれる OpenMP ランタイム libomp.dll は Apache-2.0 WITH LLVM-exception） | https://github.com/ggml-org/llama.cpp |
| CUDA ランタイム DLL（cudart / cuBLAS、llama.cpp 用） | llama.cpp を GPU で動かす | NVIDIA CUDA Toolkit EULA（再頒布可能なコンポーネント） | https://github.com/ggml-org/llama.cpp/releases （条件: https://docs.nvidia.com/cuda/eula/ ） |
| Qwen3-14B（GGUF） | AI 編集・作詞用の言語モデル | Apache-2.0 | https://huggingface.co/Qwen/Qwen3-14B-GGUF |
| python-audio-separator（onnxruntime・audioread などの依存ライブラリを含む） | ボーカル分離 | MIT（audio-separator・onnxruntime・audioread）。そのほかの依存ライブラリはそれぞれのライセンスで、Demucs の処理が使う diffq-fixed は CC BY-NC 4.0（非営利） | https://github.com/nomadkaraoke/python-audio-separator |
| ボーカル分離モデル（BS-Roformer はセットアップで取得。MelBand-Roformer・Demucs htdemucs_ft は初回使用時に audio-separator が取得） | ボーカル分離 | モデルごとの配布元の条件（公開されていないものもあります）。Demucs は MIT（https://github.com/facebookresearch/demucs ） | https://github.com/TRvlvr/model_repo （設定ファイル: https://github.com/nomadkaraoke/python-audio-separator のリリース、https://github.com/TRvlvr/application_data 。Demucs の重み: https://dl.fbaipublicfiles.com/demucs/ ） |
| MMS 強制アライメントモデル（torchaudio MMS_FA） | 同期歌詞のタイミング検出 | CC BY-NC 4.0 | https://dl.fbaipublicfiles.com/mms/torchaudio/ctc_alignment_mling_uroman/model.pt （説明: https://pytorch.org/audio/ ） |
| pykakasi / pypinyin | 日本語・中国語歌詞のローマ字化 | GPL-3.0-or-later / MIT | https://github.com/miurahr/pykakasi , https://github.com/mozillazg/python-pinyin |
| uroman 1.3.1.1（任意） | 日本語・中国語以外の歌詞（韓国語・ロシア語など）のローマ字化（同期歌詞の整列） | MIT 形式に謝辞の条件が付いたライセンス（Copyright (C) 2015-2020 Ulf Hermjakob, USC Information Sciences Institute。下記） | https://github.com/isi-nlp/uroman |

uroman のライセンスの条件により、次のとおり表示します: This project uses the universal romanizer software 'uroman' written by Ulf Hermjakob, USC Information Sciences Institute (2015-2020).

このほか、Microsoft Edge WebView2 ランタイムがない PC では、アプリのインストーラーが Microsoft からその入手用のプログラムを取得してインストールします（Windows 11 には標準で入っています。Microsoft のライセンス条項に従います）。

## 2. アプリに含まれるオープンソースソフトウェア

アプリの画面（npm パッケージ）と実行ファイル（Rust クレート）に組み込まれているオープンソースソフトウェアの一覧とライセンスの全文は、[THIRD_PARTY_LICENSES.txt](THIRD_PARTY_LICENSES.txt) にあります（アプリのインストール先にも同梱しています）。主なもの: Tauri 2（MIT / Apache-2.0）、React（MIT）、wavesurfer.js（BSD-3-Clause）、abcjs（MIT）、@tonejs/midi（MIT）、zustand（MIT）、lofty（MIT / Apache-2.0）、rusqlite（MIT）、reqwest（MIT / Apache-2.0）ほか。実行ファイルには Microsoft の WebView2 SDK のローダー（WebView2LoaderStatic.lib。Copyright (C) Microsoft Corporation）も組み込まれており、その表示も THIRD_PARTY_LICENSES.txt にあります。

日本語の歌詞のひらがな化には **kuromoji.js**（Apache-2.0。Copyright 2014 Takuya Asano、Copyright 2010-2014 Atilika Inc. and contributors）と、その辞書 **mecab-ipadic 2.7.0**（Copyright 2000, 2001, 2002, 2003 Nara Institute of Science and Technology）を使い、アプリに同梱しています。辞書の利用条件（ICOT の条件を含む）の全文は、THIRD_PARTY_LICENSES.txt の kuromoji の NOTICE にあります。

## 3. このリポジトリに含まれる第三者の著作物

- **`src/abc/native.ts`**: YuE2 の `skills/yue2-music/scripts/abc_tools.py`（https://github.com/multimodal-art-projection/YuE ）の検査処理（parse / parse_bar）を TypeScript に移植し、このアプリ向けに変更したものです。Apache License 2.0、Copyright (c) 2026 the YuE2 authors（ライセンスの全文は [LICENSE](LICENSE) と同じ Apache License 2.0）。
- **`src/abc/__tests__/native.test.ts`**: score() と検査の入力は、YuE2 の `tests/test_skill_abc_tools.py` を TypeScript（vitest）に移したものです。Apache License 2.0、Copyright (c) 2026 the YuE2 authors。テストにだけ使い、アプリには含まれません。
- **`src/abc/instrumental.ts`**: インストゥルメンタル版のスタイルの組み立て（先頭の “Instrumental”、4 つの否定語、既定の “Expressive instrumental music”）とセクションタグの歌詞（lyric_tags）は、YuE2 のエージェントスキルの `skills/yue2-music/instrumental/scripts/instrumental.py`（prepare()・lyric_tags()）を TypeScript に移したものです。ボーカルの音を伴奏の声部に移す処理は同じスキルの手順に沿ったこのアプリの実装で、声・言語の語を除く処理はこのアプリ独自のものです。MIT License、Copyright (c) 2026 yue2-music contributors（全文は下記）。
- **テスト用の譜面 `src/abc/__fixtures__/official_*.abc`**: YuE2 の例の譜面（`official_score.abc`・`official_melody.abc` は Apache License 2.0、Copyright (c) 2026 the YuE2 authors。`official_example_ins.abc` は MIT License、Copyright (c) 2026 yue2-music contributors）。ライセンスの全文と出典は、同じフォルダの `LICENSE-YuE2-Apache-2.0.txt`・`LICENSE-yue2-music-MIT.txt`・`SOURCES.txt` にあります。そのほかの譜面は、YuE2 で生成した曲の譜面（その曲を SheetSage2 で転写したものを含む）と、SheetSage2 の書き出し処理を合成データで動かした結果です（既存の録音の転写は含みません）。
- **テストのデータの一部の歌詞**（英語の 2 行 “Morning light across the window” / “City waking down below” と、その日本語の言い換え）: ComfyUI の YuE2 ワークフローテンプレート（https://github.com/Comfy-Org/workflow_templates ）の例の歌詞に基づきます。テストにだけ使い、アプリには含まれません。ライセンスは下記（Comfy Org）のとおりです。

YuE2 のエージェントスキル（yue2-music）のライセンス:

```
MIT License

Copyright (c) 2026 yue2-music contributors

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

ComfyUI のワークフローテンプレート（Comfy Org）のライセンス:

```
MIT License

Copyright (c) 2023-present Comfy Org

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

## 4. 商標について

本アプリは非公式のソフトウェアです。HKUST / M-A-P（YuE2・SheetSage2）、Comfy Org（ComfyUI）、NVIDIA、Alibaba Cloud（Qwen）、Meta（MMS）、Anthropic、OpenAI、Microsoft とは関係がなく、これらの承認も受けていません。各名称は、それぞれの会社・団体の商標または登録商標です。

## 5. 生成した音楽について

生成した音楽の権利と責任は利用者に帰属します。モデルの利用条件（特に商用利用）は、各配布元の最新の記載を確認してください。

# Music Creator Studio YuE2

Windows 11 向けのローカル音楽生成スタジオです。オープンソースの音楽生成モデル **YuE2**（HKUST / M-A-P）を **ComfyUI** のバックエンドで動かし、作曲・譜面編集・カバー・ボーカル分離・AI 編集・書き出し（同期歌詞付き）までを日本語 UI でひとつにまとめています。

> 対応環境: Windows 11、NVIDIA GPU（推奨 24GB VRAM。INT8 モデルで 12GB 程度から）、NVIDIA ドライバ 580.88 以上、空きディスク 40GB 以上。

## 主な機能

| 機能 | 内容 |
|---|---|
| 作曲 | 歌詞（`[Verse]` `[Chorus]` などのセクションタグ。公式サンプル由来の拡張タグ一覧と任意タグの挿入、通し番号付け）とスタイル（日本語チップから英語プロンプトを組み立て）から 48kHz ステレオの楽曲を生成。譜面の計画 Full / Melody / Off（モード）、シード、曲長の自動算出、バリエーション一括生成 |
| ピアノロール | 計画した（または転写・読み込んだ）ABC 譜面（Vocal / Ins の 2 声部、コード、セクション）を自作ピアノロールで編集し、「この譜面で再生成」。ABC テキスト、五線譜プレビュー、MIDI / ABC 入出力、移調、簡易試聴 |
| カバー / 耳コピ | 既存音源を SheetSage2 で ABC に転写（メロディのみ / コード込み）し、新しいスタイル・歌詞でゼロショットカバー |
| ボーカル分離 | audio-separator（BS-Roformer / MelBand-Roformer / Demucs）でボーカルと伴奏を WAV 出力 |
| AI 編集 | 「サビをジャズ風にリハーモナイズ」などの自然文で譜面・スタイル・歌詞を書き換え。ローカル llama.cpp（既定 Qwen3-14B）、Anthropic API、OpenAI 互換 API に対応。差分確認→適用→「この譜面で再生成」 |
| 書き出し | MP3 / M4A / FLAC / OGG / Opus / WAV、ビットレート、ラウドネス正規化、フェード、メタデータ、ジャケット。同期歌詞は MMS 強制アライメントで自動検出し、MP3 に SYLT+USLT、M4A に ©lyr、FLAC/OGG に LYRICS を埋め込み、.lrc も出力 |
| ライブラリ | 生成した曲、シード、パラメータ、譜面、生成時間、ピーク VRAM を SQLite で管理 |
| ヘルプ | 各画面の「？ ヘルプ」（F1）で、その画面の使い方と各入力項目の意味・範囲・既定値を表示（ヘルプ内の検索つき）。設定のヘルプにはアプリの前提条件・制限事項・トラブルシューティング・インストール / アンインストールも掲載 |

## インストール

1. [Releases](../../releases) から `Music Creator Studio YuE2_x.y.z_x64-setup.exe` をダウンロードして実行します（ユーザー単位インストール、管理者権限不要）。
2. 初回起動時のセットアップウィザードで、環境チェック → 保存場所 → ライセンス同意 → ダウンロード（ComfyUI 本体、YuE2 モデル、ffmpeg、llama.cpp など約 20〜30GB）を行います。ダウンロードは中断しても再開できます。
3. 「作曲」画面で歌詞とスタイルを入力し「生成する」を押すと、ComfyUI が自動起動して生成が始まります。

アンインストーラーは、アプリ本体に加えてダウンロードしたツール・モデル（データルート、既定 `C:\MCSYuE2`）と生成した楽曲フォルダを削除するかどうかを確認します。

使い方は [docs/USER_GUIDE.md](docs/USER_GUIDE.md) と、アプリの各画面の「？ ヘルプ」（F1）を参照してください。

## 開発

```bash
npm install
npm run tauri dev
```

- フロントエンド: React + TypeScript + Vite（`src/`）
- バックエンド: Rust / Tauri 2（`src-tauri/`）— ComfyUI プロセス管理、HTTP / WebSocket クライアント、ダウンローダ、ジョブキュー、SQLite、書き出し
- ComfyUI 用自作ノード: `comfy-nodes/mcs_yue2_nodes/`（32bit float WAV 保存、ボーカル分離、歌詞アライメント）
- テスト: `npm test`（型チェック + vitest）、`cargo test --manifest-path src-tauri/Cargo.toml --lib`。`comfy-nodes/` を変更したときは `npm run test:nodes`（ComfyUI の埋め込み Python を使うため、セットアップ済みのデータルートが必要。`MCS_DATA_ROOT` / `MCS_PYTHON` で指定可）
- インストーラーのスモークテスト: `pwsh -File tools/install_test.ps1 -Installer <setup.exe>`（一時フォルダへのサイレントインストール・起動・アンインストール。既存のインストールには触れず、設定とレジストリの記録は退避して元に戻す）
- ドキュメント: [docs/USER_GUIDE.md](docs/USER_GUIDE.md)（使い方ガイド）、[docs/DEVELOPMENT.md](docs/DEVELOPMENT.md)（開発者向け: 構成、テスト、E2E、リリース、ComfyUI の更新手順）、[CHANGELOG.md](CHANGELOG.md)（変更履歴）

リリースは `v*` タグの push で GitHub Actions（`.github/workflows/release.yml`）が NSIS インストーラーをビルドし、ドラフトリリースに添付します。CI では `npm test` と `cargo test --lib` を実行します（ffmpeg を使う結合テストとノードパックのテストは CI では実行されないため、リリース前にローカルで実行してください）。

## ライセンス

本アプリのコードは [Apache-2.0](LICENSE)（Copyright 2026 歌うＬＩＮＥ彼氏）です。アプリに組み込まれるオープンソースのライブラリ（npm パッケージ・Rust クレート）のライセンス全文は [THIRD_PARTY_LICENSES.txt](THIRD_PARTY_LICENSES.txt) にあり、インストーラーがアプリとともにインストールします。

アプリが初回セットアップでダウンロードする各ソフトウェア・モデルはそれぞれのライセンスに従います。特に **YuE2 モデルの重みは CC BY-NC 4.0（個人クリエイター許諾付き）** で、個人の創作・収益化は可能ですが法人利用には別途ライセンスが必要です。詳細は [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) を参照してください。

同期歌詞の整列（任意のコンポーネント）では uroman を使います。This project uses the universal romanizer software 'uroman' written by Ulf Hermjakob, USC Information Sciences Institute (2015-2020).

本アプリは非公式のソフトウェアです。YuE2 の開発元（HKUST / M-A-P）、Comfy Org（ComfyUI）、NVIDIA、Anthropic、OpenAI などの各社・各団体とは関係がなく、これらの承認も受けていません。各名称は、それぞれの会社・団体の商標または登録商標です。

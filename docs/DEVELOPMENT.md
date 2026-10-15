# 開発者向けガイド

## 構成

```
src/                          画面（React + TypeScript、Vite）
src-tauri/                    Rust / Tauri 2: ComfyUI のプロセス管理、HTTP / WebSocket クライアント、
                              ダウンローダ、ジョブキュー、SQLite、書き出し
  windows/hooks.nsh           アンインストーラーのフック（NSIS）
  src/e2e/                    実 ComfyUI と llama-server での E2E（テストのビルドだけに入る）
comfy-nodes/mcs_yue2_nodes/   自作の ComfyUI ノードパック（Python。インストーラーに同梱し、セットアップで ComfyUI に入れる）
tools/                        ビルドと試験の補助（kuromoji 辞書のコピー、ライセンス一覧の作成、E2E のドライバ、
                              インストーラーの試験）
docs/USER_GUIDE.md            使い方ガイド
.github/workflows/release.yml v* タグの push で試験とインストーラーのビルドを行い、下書きのリリースに添付
```

## 準備と起動

- Node.js 24、Rust（stable、`x86_64-pc-windows-msvc`）、WebView2 ランタイム。
- `npm install` のあと `npm run tauri dev`（`predev` が kuromoji の辞書を `public/kuromoji` にコピーします）。

## テスト

- `npm test`: 型チェック（アプリ `tsconfig.json`・設定ファイル `tsconfig.node.json`・テスト `tsconfig.test.json`）と vitest。
  - 公式の `abc_tools.py` との突き合わせ（`src/abc/__tests__/writeback.test.ts`）は、環境変数 `YUE2_ABC_TOOLS` に YuE2 の `skills/yue2-music/scripts/abc_tools.py` を、`MCS_YUE2_PYTHON` に Python を指定したときだけ実行します（指定がないと飛ばします）。
- `cargo test --manifest-path src-tauri/Cargo.toml --lib`
  - `export.rs` の ffmpeg を使う結合テストは、データルート（既定 `C:\MCSYuE2`、または `MCS_TEST_DATA_ROOT`）の `runtime\ffmpeg` がないと「SKIPPED (no ffmpeg under …)」と出して飛ばします（`MCS_REQUIRE_FFMPEG=1` か `MCS_TEST_DATA_ROOT` を指定すると、飛ばさずに失敗します）。
  - フォルダのアクセス権で拒否されることを確かめるテスト（`src-tauri/src/setup.rs` の `acl_for_tests` を使うもの）は、テスト用のフォルダに権限を明示的に設定し、このプロセスのバックアップ・復元の特権を外してから確かめます。それでも拒否されない、管理者として実行した環境（GitHub の実行環境など）では「SKIPPED (this elevated program …)」と表示して、その確認を飛ばします（通常のユーザーで実行すると、拒否されないことは失敗になります）。
- `cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets -- -D warnings`
- ノードパック: `npm run test:nodes`（ComfyUI の埋め込み Python でパックの構文を確認し、`comfy-nodes/tests/test_mcs_yue2_nodes.py` を実行します。セットアップ済みのデータルートが必要で、`MCS_DATA_ROOT` / `MCS_PYTHON` で指定できます）。
- アンインストーラーのフック: `npm run test:nsis-hooks`（`src-tauri/windows/hooks.nsh` の関数を試験用のフォルダで確かめます。makensis は `npm run tauri build` が `%LOCALAPPDATA%\tauri\NSIS` に取得したものを使います）。
- E2E（実 ComfyUI。既定 `127.0.0.1:8198`）: 手順は `src-tauri/src/e2e/mod.rs` の先頭にあります。アプリ自身が組み立てるグラフを ComfyUI で実行し（`tools/e2e_comfy_driver.mjs`）、結果をアプリの読み取り処理に通して確かめます。ローカル LLM の E2E（llama-server）は `src-tauri/src/e2e/llm_e2e.rs` の先頭を参照してください。
- インストーラーのスモークテスト: `pwsh -File tools/install_test.ps1 -Installer "src-tauri\target\release\bundle\nsis\Music Creator Studio YuE2_x.y.z_x64-setup.exe"`
  - まだない一時フォルダにショートカットなしでサイレントインストール（`/S /NS /D=…`）して起動し、`uninstall.exe /S` で削除します。既存のインストールには触れず、インストーラーが製品ごとに持つレジストリの記録（アンインストールの登録、前回のインストール先）とアプリの設定（`HKCU\Software\MusicCreatorStudioYuE2`、`%APPDATA%\MusicCreatorStudioYuE2`）は事前に退避して最後に元に戻します。アプリの起動中は実行しません。詳細はスクリプトの先頭のコメントにあります。

## ライセンス表示

- アプリに組み込まれる npm パッケージと Rust クレートのライセンス全文は `THIRD_PARTY_LICENSES.txt` にあり、インストーラーが `LICENSE`（`LICENSE.txt`）・`THIRD_PARTY_NOTICES.md` とともにインストール先に入れます（`src-tauri/tauri.conf.json` の `bundle.resources`）。
- 依存を追加・更新したら `npm run licenses`（`tools/third-party-licenses.mjs`）で作り直してコミットしてください。ロックファイルと合っていないと `npm test` が失敗します。
- パッケージが自分では含まない表示（ライセンスファイルのないクレートのリポジトリのライセンス、静的にリンクされる Microsoft の WebView2 SDK のローダー、kuromoji のブラウザ版に含まれる process / path など）は `tools/third-party-licenses/` に置き、スクリプトの `EXTRA` に登録しています。依存を更新したときは、新しい依存にも同じものがないか確認してください。
- セットアップでダウンロードするもの（モデル・ComfyUI・ffmpeg など）と、このリポジトリに含まれる第三者の著作物は `THIRD_PARTY_NOTICES.md` に書きます。

## 版の上げ方とリリース

1. `package.json` の `version`（`tauri.conf.json` はここから読みます）と、`src-tauri/Cargo.toml` の `[package] version`（`Cargo.lock` も）を同じ版にします。`CHANGELOG.md` に変更を書きます。
2. ffmpeg の結合テストとノードパックのテストは CI では動かないため、リリースの前にローカルで実行します。
3. 新しいリポジトリや、ワークフローを変えたときは、タグの前に main を push し、Actions の「release」→「Run workflow」（main）で試験とビルドだけを実行して成功を確かめます（インストーラーは実行の Artifacts に残り、リリースは作られません）。
4. タグ `v<版>` を push すると、`.github/workflows/release.yml` が `npm test` と `cargo test --lib` を実行し、NSIS インストーラーをビルドして、そのタグの下書きのリリースに添付します。続けてアンインストーラーのフック試験を実行し、失敗したときはジョブが失敗します（その実行の下書きは公開しないでください）。タグ・`package.json`・`Cargo.toml` の版が一致しないと失敗します。失敗したテストは、その実行の Annotations（GitHub にサインインしなくても見られます）にも表示されます。
5. 下書きのリリースを確認して公開します。

## ComfyUI を更新するとき（v0.37.0 から上げるとき）

1. 新しい版の公式 YuE2 ワークフローテンプレート（https://github.com/Comfy-Org/workflow_templates ）を確認し、ノード名・入力名・既定値・モデルのファイル名の変化を調べます。
2. 新しい版の ComfyUI の `GET /object_info` で、`YuE2GenerateABC` / `YuE2GenerateMusic` / `EmptyYuE2LatentAudio` / `KSampler` / `SaveAudioAdvanced` / `LoadAudio` の入力名と既定値を `src-tauri/src/workflow.rs` と比べます。自作ノード（`MCS_*`）が読み込まれることも確認します。
3. `src-tauri/src/setup.rs` の `comfyui_version!()` マクロの版（`COMFYUI_VERSION` とダウンロード URL が決まります）と、ComfyUI コンポーネントの `size` と `sha256` を新しいリリースの値にします。`src/config/rules.ts` の `TESTED_COMFYUI_VERSION` と `docs/USER_GUIDE.md` の版の記述も直します（rules.ts との一致は `cargo test` が検査します）。
4. 新しい版のサーバーに対して E2E を実行します。

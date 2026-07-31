# README-KANJI — この fork の野口さん専用セットアップ

fork: `n-kanji/mulmoterminal`（upstream: `receptron/mulmoterminal`）
カスタマイズはブランチ `kanji` に載っている。main は upstream 追従用にクリーンに保つ。

## 1分クイックスタート

**http://localhost:34567 を開くだけ**（launchd 常駐なので常に生きている。ログイン時自動起動・落ちても10秒で復活）。

1. ツールバーの「+」→ プリセットチップ（orosy-v2 が先頭、使用実績順）の「▶」で新セッション
2. セルの枠色 = 状態: 青=作業中/完了、琥珀=要対応（許可待ち・入力待ち）、無色=idle。要対応はチャイムも鳴る
3. セルをズームすると左に全セッションのロースター（AI サマリー + 自分の最後のプロンプト + 返答）
4. claude-peers は iTerm2 のペインと同一ネットワーク。確認プロンプトは自動通過する

## 常駐サービスの操作

```
launchctl kickstart -k gui/501/com.kanji.mulmoterminal   # 再起動（設定変更後に）
launchctl bootout gui/501/com.kanji.mulmoterminal        # 停止（常駐解除）
launchctl bootstrap gui/501 ~/Library/LaunchAgents/com.kanji.mulmoterminal.plist  # 再開
tail -f ~/.mulmoterminal/server.log                       # ログ
```

- plist: `~/Library/LaunchAgents/com.kanji.mulmoterminal.plist`（PATH 明示・WorkingDirectory=$HOME 必須 — cwd=/ だと mkdir /data で死ぬ）
- 手動で試したい時: `mterm` / `mterm --no-open`（`~/bin/mterm`）
- `~/bin/claude-mulmo` … MulmoTerminal が spawn する claude の wrapper。iTerm2 の zsh 関数と同じく `--dangerously-load-development-channels server:claude-peers` を付ける

## 野口さん環境の設定（2026-07-30 仕上げ）

- **フォント**: HackGen Console NF（全角=半角×2、罫線が崩れない）— グローバル設定 `fontFamily`
- **色分けバッジ**: 主要9プロジェクトの `.mulmoterminal.json`（orosy-v2=青 / home=グレー / team-docs=ティール / voicewriter=紫 / cc-notify=琥珀 / fleet-watch=シアン / mulmoterminal=緑 / 大阪玩具=橙 / swf-v0=ピンク）。`~/.gitignore_global` に追加済みなので各リポジトリは汚れない
- **プリセット**: 直近7日の実利用順（orosy-v2 45セッション/週が先頭）
- **prRepos**: spacengine/orosy-v2, team-docs, voicewriter, claudecode-notify（横断 PR/Issue ビュー対象）
- 見た目の追加調整は MulmoTerminal 内の Claude セッションで `/mulmoterminal-config`（対話設定・keymap もこれで安全に書ける）

## iTerm2 モード（2026-07-31・CEO 指示で全面改修）

グリッドを iTerm2 の縦分割の操作モデルに純化した:

1. **縦カラム専用レイアウト** — 段積み（2x2 等）を廃止。全ペインがフルハイトの縦カラムで、
   増えるたび列が割れる（1ページ最大8列、超えたら次ページ）。27インチ 4K で
   1スレッドあたりの可読行数を最大化するため（`gridLayout.ts` / `gridTabs.ts`）
2. **自動ズーム廃止** — セル追加時にズームへ閉じ込めない。ズーム中に追加すると
   むしろズーム解除してカラムに戻る（`addCell` / `insertCellAfter`）
3. **プリセット常駐ストリップ** — ツールバー直下に全プリセットのチップが常駐。
   **1クリックで新カラムが開き claude が自動起動**（ランチャー画面を経由しない。
   `addCellWithCwd` + TerminalCell `autoLaunch`）
4. **ペイン常時ステータス行** — 各カラムのヘッダー下に「状態語（色付き）+ AI サマリー +
   最後の指示」を常時1行表示。claudecode-notify Status pane の各ペイン内蔵版
5. **不要ボタン非表示** — Chat（単一ビュー）/ Worklog / スマホ連携（RemoteHost）。
   PR ビューは温存。`AppToolbar.vue` の `IT2_MODE` フラグで一括制御（false で戻せる）
6. **Claude アプリ風テーマ（第2弾・2026-07-31）** — デフォルトテーマ「Claude」新設
   （アプリ実物から目合わせした温チャコール #262624・テラコッタ #d97757・くすみ ANSI16）。
   xterm 行間 1.35 + 端末パディングで日本語長文の可読性をアプリに寄せた。
   他テーマに戻すのは ⚙ → THEME
7. **ドラッグ&ドロップ** — ①セルヘッダーを掴んで列を並び替え（スプライス移動。
   auto ソート中にドロップすると manual に切替）②プリセットチップも D&D で並び替え
   （サーバー設定に永続化）。ファイルドロップ（パス挿入）とは独自 MIME で区別済み
8. **プリセットストリップの「＋」** — OS のフォルダ選択ダイアログ → 選んだディレクトリで
   即・新カラム起動。起動したディレクトリは自動でプリセットに記録される
9. **ステータス行にモデル表示** — 各ペインの常時ステータス行の右端に「モデル · ctx %」
   （例: Fable · ctx 30%）。狭いカラムでもどのモデルで動いているか常に見える

## この fork 独自のカスタマイズ（ブランチ kanji）

1. **claude-peers 連携** — 素の MulmoTerminal は `claude` を直接 spawn するため、
   zsh 関数で付けていた claude-peers チャネルが失われる。CLAUDE_BIN wrapper で復元した。
   グリッドから起動したセッションは iTerm2 のペインと同じ peers ネットワークに参加する
   （list_peers で見える・send_message が届く）。
2. **dev-channels 確認プロンプトの自動通過** — `server/session/channel-consent.ts`（新規）。
   claude-peers フラグ付き起動は毎回「I am using this for local development / Exit」の
   確認で止まるため、spawn 直後の PTY 出力を監視して自動で Enter を送る。
   - オプトイン: 環境変数 `MULMOTERMINAL_AUTOCONFIRM_CHANNELS`（mterm が設定）に
     一致するチャネルリストの時だけ発火。他のチャネルでは人間の確認待ちのまま。
     **単一チャネルリスト前提**（カンマ区切り複数は表示揺れで不発になり得る）
   - 監視は **TUI 起動（または 30 秒）で武装解除**される。起動後にこのプロンプトの
     文言をファイル表示しても誤 Enter は飛ばない（code-reviewer 検算の指摘で修正済み）
   - claude はこのプロンプトを単語ごとにカーソル移動で描画するため、
     エスケープ列をスペース化して照合している（詳細はソースコメントと spec 参照）
   - 発火時はサーバーログに `[consent] auto-confirming ...` が残る
   - テスト: `test/server/session/channel-consent.spec.ts`
3. 設定: `~/.mulmoterminal/config.json` にディレクトリプリセット（orosy-v2 ほか）を整備済み。
   見た目・色・通知音などは MulmoTerminal 内の claude セッションで `/mulmoterminal-config`
   と打つと対話的に設定できる。

## 既知の制限

- **単一ビュー（/chat）のセッションでは claude-peers の MCP ツールが載らない**。
  上流仕様で単一ビューは `--strict-mcp-config`（GUI MCP のみ）で起動するため。
  チャネル（メッセージ注入）は生きるが、そのセッション自身から list_peers 等は呼べない。
  グリッドのセッションは制限なし（通常 MCP がフルに載る）。
- グローバル設定はサーバ起動時に一度だけ読まれる。config.json を手で編集したら mterm を再起動する。

## upstream 追従（アップデート手順）

```
cd ~/Projects/tools/mulmoterminal
git fetch upstream
git checkout kanji
git rebase upstream/main        # カスタマイズは channel-consent 周りの小差分のみ
npx -y yarn@1.22.22 install --frozen-lockfile
npx -y yarn@1.22.22 build
```

conflict はほぼ `server/session/spawn-claude.ts` の import と scanner 1 行に限られるはず。
検証: `npx -y yarn@1.22.22 test test/server/channel-consent.spec.ts`

※ この Mac には yarn 本体が入っていない（corepack も無し）。`npx -y yarn@1.22.22` を使う。

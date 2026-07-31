# iTerm2 環境インベントリ — MulmoTerminal 移行のための棚卸し

**読む深さ等級:** 📗使い捨て（移行チェックリストを作るための材料。判断材料として消費したらアーカイブでよい）
**生成モデル:** Claude Opus 5 (`claude-opus-5[1m]`) / 調査補助: Sonnet サブエージェント 2 体
**作成日:** 2026-07-31
**目的:** 野口さんの iTerm2 + tmux + claudecode-notify 環境が提供している利便性を洗い出し、MulmoTerminal が 100% 代替するために必要なものを特定する

---

## 0. 実測サマリー（2026-07-31 時点の実環境）

移行の議論を「想定」でなく実測から始めるための現況。

| 項目 | 実測値 |
|---|---|
| tmux サーバー（ユーザー用） | socket `default`。`workspace-1`（18 ペイン）+ `workspace-2`（12 ペイン）= **計 30 ペイン稼働中** |
| ペインの内訳 | 1 プロジェクト = **CC ペイン（39桁 × 69行）+ Status ペイン（39桁 × 12行）** の縦ペア。これが横に 9 列 / 6 列並ぶ |
| tmux サーバー（MulmoTerminal 用） | socket `mulmoterminal`（`-L` で**完全分離**）。`mt-<uuid>` セッションが **7 本稼働中** |
| 現在の状態 | **iTerm2 環境と MulmoTerminal が並行稼働している**（移行前の二重運用中） |
| tmux バージョン | 3.6a |
| iTerm2 プロファイル | `Default` 1 個のみ（複数プロファイル運用なし） |

**最重要の構造的発見:** MulmoTerminal は `tmux -L mulmoterminal` という**専用ソケット**でセッションを立てる（`server/infra/tmux.ts:6`、「ユーザーの tmux セッション・キーバインド・ステータスバーに一切触れない」という設計意図がコメントに明記）。この分離は upstream の正しい設計だが、**野口さん環境では既存の自動化ツール群が `default` ソケットを前提に全ペインを走査している**ため、移行するとそれらが「エラーも出さず、ただ何も見つけなくなる」。詳細は §5・§9。

---

## 1. claudecode-notify（中核。iTerm2 環境の利便性の大半はここ）

`/Users/kanjinoguchi/Projects/tools/claudecode-notify/`（Swift・30 ファイル・約 11,000 行）。メニューバー常駐アプリ + HTTP サーバー（:19460）+ Claude Code hook CLI の三位一体。

### 1-1. Status pane（ペアペイン）

| 機能名 | 何が便利か | 実装の場所 | MulmoTerminal 代替時に必要になるもの |
|---|---|---|---|
| Status pane 本体 | 各 CC ペインの真下に 12 行の相棒ペインが常駐し、**mission（なぜここにいるか）/ current_task（今なにをしているか）** を常時表示。15-24 並列時の「このペイン何やってたんだっけ」＝大目的ドリフトを解決する、この環境の**最大の発明** | `scripts/render-status.sh`（2 秒ループで描画）、`Services/StatusPaneWriter.swift` | **済（形を変えて実装済み）** — fork の「ペイン常時ステータス行」（各カラムのヘッダー直下に 状態語 + AI サマリー + 最後の指示 を 1 行表示、README-KANJI §36-4）。**ただし mission（長期の大目的）に相当する層がない** — AI サマリーは「今」しか表さない。§9 の要判断 A |
| CC_PAIR_ID 発行 | CC ペインと Status ペインを紐づける UUID。`tmux send-keys` でシェルに `export CC_PAIR_ID=<uuid>` を注入 | `Services/TmuxDetector.swift:764-772`、`scripts/tmux-workspace.sh` | MulmoTerminal が同等の環境変数を注入するか、**CLAUDE.md 側のルールを書き換えるか**の二択。§9 要判断 A |
| pane-registry | `TMUX_PANE → pair_id` の逆引き表。手動 split / ccc / Triad 起動など CC_PAIR_ID が伝搬しない経路でも紐づけを回復する | `Services/PaneRegistry.swift` → `~/.claude/panes/pane-registry.json` | CC_PAIR_ID 方式を捨てるなら不要 |
| mission / current_task ファイル | CC 本体が heredoc で直接書く。TodoWrite の `in_progress` は hook が自動ミラー | `~/.claude/panes/<pair_id>.json`（CLAUDE.md の応答前ゲートで書き込みが**強制**されている） | 同上。**CLAUDE.md に「応答前に必ず書け」という強制ルールがある**ため、移行時はルール本文の改訂が必須 |
| telemetry sidecar | CC の協力ゼロで state（active/idle/ended）・last_prompt・last_tool・履歴 3 件を観測記録 | `Services/TelemetryWriter.swift` → `<pair_id>.telemetry.json` | **済** — MulmoTerminal は activity-state / activity-hook / last-turn を自前で持つ（`server/session/`） |
| モデル名表示 | Status ペインに `🤖 Fable 5` のように現在のモデルを表示。どのペインが opus でどれが sonnet か一目で分かる | `~/.claude/statusline-command.sh`（CC 標準の statusLine hook が `<pair_id>.model` に書く）→ render-status.sh が読む | **済** — fork のステータス行右端に「モデル · ctx %」（README-KANJI §36-9） |
| 鮮度の色分け | updated_at を相対時刻で色分け（緑 <5分 / 黄 <30分 / 赤 stale）。放置ペインが一目で分かる | `scripts/render-status.sh` の `render_freshness()` | **未** — MulmoTerminal のセル枠色は状態（作業中/要対応/idle）を表すが、「**最後に動いてから何分経ったか**」の stale 感は表現していない |
| ペインタイトル同期 | CC が OSC で流すタスク名を拾って tmux ボーダーに出す | `render-status.sh` 冒頭 | 不要（Web 側はヘッダーに直接書ける） |

### 1-2. 通知

| 機能名 | 何が便利か | 実装の場所 | MulmoTerminal 代替時に必要になるもの |
|---|---|---|---|
| macOS 通知 | 承認待ち・完了を Sosumi/Ping 音付きで通知。5 分クールダウン | `Services/NotificationManager.swift` | ブラウザ通知 + fork のアテンションチャイム（実装済み）。**音の種類の作り分けは要確認** |
| iPhone push（Bark） | ローカル 127.0.0.1:19462 経由で APNs に直送（第三者中継なし）。**外出先で承認待ちに気づける** | `Services/BarkNotifier.swift` + `HookProcessor.swift`（GUI 非依存の冗長経路） | **済（別方式）** — MulmoTerminal は Web Push を持つ。ただし fork の IT2_MODE で RemoteHost ボタンを**非表示にしている**（README-KANJI §36-5）ので、スマホ経路が実質切れていないか要確認。§9 要判断 C |
| GitHub PR 監視 | `gh pr list` を 60 秒ポーリングし、merged / changes_requested を通知 + CC の stdout に流し込む | `Services/GitHubPRMonitor.swift` | **済** — fork の PR ビュー（prRepos 4 リポ設定済み）。ただし「**CC の会話に割り込んで教える**」経路は MulmoTerminal 側になさそう |

### 1-3. Guard（コマンド承認）

| 機能名 | 何が便利か | 実装の場所 | MulmoTerminal 代替時に必要になるもの |
|---|---|---|---|
| iPhone からの承認 UI | 危険コマンドの承認を**スマホから yes/no** できる。承認は tmux にキーストロークを送って解決 | `Guard/GuardStore.swift`、`Resources/guard/approval.html`、`Services/TmuxKeySender.swift` | MulmoTerminal は Web UI から入力を送れるので原理的には可能。**ただし承認先のペイン特定が `default` ソケット前提**（§5） |
| 認証バイパス設計 | `/guard/*` だけトークン不要。**リクエスト ID 自体を使い捨てトークンにする**（URL を知る＝承認権限） | `WebServer/APIHandler.swift`、`WebServer/AuthManager.swift` | 移行時にこの設計を引き継ぐか判断。MulmoTerminal 側の認証モデルと衝突しないか要確認 |
| 5 分で自動失効 | 放置された承認要求が残り続けない | `GuardStore.cleanup()` | 同等の TTL が必要 |

### 1-4. Workspace API / tmux オーケストレーション

localhost:19460。**CLAUDE.md が「別プロジェクトへのシームレス分岐」の手順として直接叩くよう指示している**（`POST /api/workspace/add`）ので、移行時は CLAUDE.md の該当セクションも書き換えが必要。

| 機能名 | 何が便利か | 実装の場所 | MulmoTerminal 代替時に必要になるもの |
|---|---|---|---|
| 列（プロジェクト）追加 API | Claude 自身が「別ペインで新しいセッションを立ち上げますか?」と提案し、**自分で新ペインを生成できる** | `POST /api/workspace/add`（`WebServer/APIHandler.swift`）、`Services/TmuxDetector.swift` の `addColumnImpl` | **要新設** — MulmoTerminal に「エージェントが自分で新カラムを開く」外部 API があるか要確認。なければ CLAUDE.md の該当手順が死ぬ |
| レイアウト自動修復 | 30 秒ごとに Status ペインを失った孤児 CC を検出して再生成 | `TmuxDetector.swift:1250` `healMissingStatusPanes` | fork のカラムモデルでは構造的に発生しない（ステータスは行内蔵）→ **不要** |
| ワークスペース永続化 | tmux レイアウトの指紋を 30 秒ごとに取り、変化があれば `~/.config/workspace-N.yaml` に保存。**マシン再起動後も同じ 9 プロジェクト構成が戻る** | `Services/WorkspaceManager.swift:112-166`、`~/.config/workspace-1.yaml` / `workspace-2.yaml` | **済（別方式）** — MulmoTerminal の cwdPresets + tmux セッション永続化。ただし「**前回の並び順そのまま復元**」の粒度は要確認 |
| worktree 管理 | worktree 作成 / マージ / 孤立検出 | `Services/WorktreeManager.swift`、`BranchRecycler.swift` | **済** — MulmoTerminal の一発 worktree + PR 機能 |
| サブエージェント退避 | Agent Team が生む一時ペインを隠しウィンドウに逃がし、レイアウトを壊さない | `TmuxDetector.swift` `evacuateAgentTeamPanes` | fork のカラムモデルでは不要 |
| capture / sync / force | 全 CC に一斉送信、ペイン内容の取得 | `POST /api/workspace/force`, `/capture/{paneId}` | **要確認** — 「全セッションに同じ指示を投げる」は多ペイン運用で効く。MulmoTerminal に相当機能があるか |

### 1-5. macOS ネイティブ機能（移行で失われるが、代替の要否が分かれる）

| 機能名 | 何が便利か | 実装の場所 | 移行時の扱い |
|---|---|---|---|
| メニューバーアイコン | 承認待ち件数がバッジ + 点滅で常時見える | `MenuBarApp.swift` | **要検討** — ブラウザのタブを見ていない時に気づけるか。fork は動的 favicon を持つ（`useDynamicFavicon.ts`）が、タブが裏なら見えない |
| グローバルホットキー `Ctrl+Cmd+C` | どのアプリにいても最優先の待ちセッションへ即ジャンプ | `HotkeyManager.swift`（Carbon API） | **要検討** — ブラウザは OS グローバルホットキーを取れない。Chrome `--app` モードなら Cmd+Tab 相当で代替 |
| Autofocus | 入力待ちになった瞬間、**タイピング中でなければ**自動でそのペインにフォーカスを移す | `AutofocusManager.swift`（CGEventTap でタイピング検出） | **要検討** — Web 側でセル自動フォーカスは可能だが「OS 全体でタイピング中か」は取れない |
| Floating Panel | 最前面に最大 8 セッションを常時表示 | `FloatingPanel.swift` | ブラウザの別ウィンドウで代替可 |
| TCC 回避のプロセス解決 | macOS 26 の「他アプリのデータ」同意ダイアログ地獄を libproc で回避 | `Services/AppProcResolver.swift` | **移行で問題が消滅** |
| Hook 自動セットアップ | `~/.claude/settings.json` の 7 イベント登録漏れ・パス不整合を起動毎に自動修復（backup 付き） | `Services/HookSetup.swift`、`install.sh` | **要検討** — MulmoTerminal も hook を使う（`server/session/hook-settings.ts`）。**両者が同じ settings.json を奪い合わないか**が移行時のリスク。§9 要判断 D |

**登録済み hook 7 種**（`SessionStart` / `SessionEnd` / `UserPromptSubmit` / `PreToolUse` / `PostToolUse` / `Stop` / `Notification`）はすべて `~/.local/bin/claudecode-notify hook` を呼ぶ。移行時はここを外すか共存させるかの判断が要る。

### 1-6. 誤解の訂正（CLAUDE.md の記述と実装の乖離）

- **`[auto-save]` メッセージは claudecode-notify の機能ではない。** リポジトリ全体を検索してもこの文字列は 0 件。CLAUDE.md には「PostToolUse hook（claudecode-notify 内蔵の autosave 機構）」と書かれているが、実装は存在しない。`WorkspaceManager.startAutoSave()` は**名前が同じだけの別物**（tmux レイアウトを yaml に保存するだけ）。
  → **移行チェックリストに載せる必要はない（元から動いていない）。ただし CLAUDE.md 側の記述は誤りなので訂正候補。**
- **トークン数・コスト表示は claudecode-notify にはない。** Status pane に出ている「Context: XX%」は Claude Code 標準の statusLine hook（`~/.claude/statusline-command.sh`）の出力。→ **MulmoTerminal の方が上位互換**（token ⇡in ⇣out・推定 $ を持つ）。

---

## 2. tmux 設定

**重要:** 設定ファイルが 2 本あり、**実際には両方が効いている混成状態**。

- `~/.tmux.conf` — claudecode-notify ワークスペース用（ペインボーダー色・レイアウト自動リセット）
- `~/.config/tmux/tmux.conf` → `~/.smux/tmux.conf` へのシンボリックリンク — smux 由来（キーバインド全般）

実測では **root テーブルの `M-*` バインド（smux 由来）が生きており**、`pane-border-format` は起動後に `tmux-colorize-panes.sh` が実行時上書きしている（`~/bin/tmux-colorize-panes.sh:76`）。つまり「どちらが正か」ではなく**両方 + 実行時スクリプト**の三層。

| 機能名 | 何が便利か | 実装の場所 | MulmoTerminal 代替時に必要になるもの |
|---|---|---|---|
| **Option+ijkl ペイン移動** | prefix 不要で上下左右にペイン移動。**端で止まる（wrap しない）**ので迷子にならない | `~/.smux/tmux.conf:21-24` | **要設定** — MulmoTerminal は keymap 機構を持つ（`common/keymap.ts`, `src/composables/activeKeymap.ts`）。`/mulmoterminal-config` で書ける。**移行時に最優先で移植すべき筋肉記憶** |
| Option+n / w / o / m | 新ペイン（tiled）/ ペイン kill / レイアウト切替 / 新ウィンドウ | `~/.smux/tmux.conf:27-36` | 同上。カラムモデルでは意味が変わるものもあるので取捨選択が要る |
| Option+u / h | 次 / 前のウィンドウ（端で止まる） | `~/.smux/tmux.conf:34-35` | fork のページ切替（1 ページ 8 列・超えたら次ページ）に対応付ける |
| Option+g → Option+y | ペインをマークして入れ替え | `~/.smux/tmux.conf:30-31` | **済** — fork の D&D 並び替え（README-KANJI §36-7）が上位互換 |
| Option+Tab スクロールモード | copy-mode に入り i/k で 2 行ずつ、I/K で半ページ | `~/.smux/tmux.conf:39-43` | **要設定** — Web 側はマウス/トラックパッドスクロールが自然だが、キーボードスクロールの筋肉記憶がある |
| ドラッグで自動コピー | マウスで選択したら即クリップボードへ。**macOS の pbcopy 破損問題を回避するため一旦ファイル経由**という苦労つき | `~/.tmux.conf:12-14` + `~/.config/tmux/copy-to-clipboard.sh` | **移行で問題が消滅**（ブラウザの選択コピーが素直に効く）。ただし OSC 52 の扱いは fork が既に手当て済み（`server/infra/tmux.ts:33-39`） |
| copy-mode の誤爆キー封じ | トラックパッドの誤入力で `Jump Backward:` 等の黄色プロンプトが出るのを防ぐため f/F/t/T/g/,/; を全部 unbind | `~/.tmux.conf:23-36` | **移行で問題が消滅** |
| プロジェクト別ペイン色 | リポジトリごとに 8 色を自動割り当て。**どの列がどのプロジェクトか色で分かる** | `~/bin/tmux-colorize-panes.sh`（client-attached / after-split-window / pane-exited で発火） | **済** — fork の `.mulmoterminal.json` バッジ色（主要 9 プロジェクトに設定済み） |
| レイアウト自動リセット | ディスプレイ切替時に yaml 定義どおりの列幅へ復元。**幅 200 桁未満（モバイル）ではスキップ** | `~/bin/tmux-reset-layout.sh`（client-attached hook） | **済** — Web のグリッドは CSS で自動追従 |
| prefix + L | レイアウト + 色の手動リセット | `~/.tmux.conf:70` | 不要になる見込み |
| スクロールバック 10,000 行 | | `~/.smux/tmux.conf:46` | **要設定** — xterm.js の scrollback 設定を合わせる |
| tmux-resurrect / continuum | プラグインは入っているが `@continuum-restore 'off'`（claudecode-notify が管理するため無効） | `~/.tmux.conf:73-76` | 不要 |

---

## 3. zsh 設定（`~/.zshrc` 103 行 / `~/.zprofile`）

| 機能名 | 何が便利か | 実装の場所 | MulmoTerminal 代替時に必要になるもの |
|---|---|---|---|
| **`claude()` 関数ラッパー** | すべての `claude` 起動に `--dangerously-load-development-channels server:claude-peers` を自動付与。**ペイン間通信が常に効く状態を担保** | `~/.zshrc:8-10` | **済** — `~/bin/claude-mulmo`（CLAUDE_BIN wrapper）で再現済み。fork 独自カスタマイズの目玉 |
| dev-channels 確認プロンプト | 上記フラグ付き起動は毎回「I am using this for local development / Exit」で止まる | （iTerm2 では人間が Enter） | **済** — `server/session/channel-consent.ts`（fork 新規実装）が自動 Enter。TUI 起動 or 30 秒で武装解除する安全設計 |
| `cc` / `cct` / `cc6` / `workspace` エイリアス | `cct` = Agent Teams モード、`workspace` = tmux-workspace.sh | `~/.zshrc:61-65` | **要検討** — `cct`（`CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1 --teammate-mode tmux`）は **tmux 前提**。MulmoTerminal 上で Agent Teams をどう起動するか |
| `yolo` エイリアス | `claude --dangerously-skip-permissions` | `~/.zshrc:5` | ランチャー設定に入れると便利 |
| 1Password キー自動ロード | **対話シェル かつ tmux の外 かつ 未ロード** の時だけ発火。tmux ペイン内では発火しない（TCC ダイアログ地獄と stdin 消費の回避） | `~/.zshrc:34-44` | **要注意** — MulmoTerminal が spawn するシェルが「対話 / tmux 外」判定でどちらに転ぶかで挙動が変わる。`op read` が stdin を食う既知の罠（memory `zshrc-op-read-eats-stdin`）と直結 |
| SSH 時の tmux 自動アタッチ | SSH ログイン時に `cc-*` / `claude` セッションがあれば自動アタッチ | `~/.zshrc:76-83` | Mac mini 運用に関わる。移行対象外だが影響確認は要る |
| Playwright のペイン別ブラウザ | tmux ペインごとに独立ブラウザセッション（複数 CC の並行利用対応） | `~/.zshrc:85-` | **要確認** — ペイン識別に何を使っているか（`TMUX_PANE` なら MulmoTerminal でも取れる） |

---

## 4. iTerm2 本体の設定

調査の結論: **カスタマイズは薄い。** 移行で本当に再現すべきものは 4 点だけ。

| 機能名 | 何が便利か | 実装の場所 | MulmoTerminal 代替時に必要になるもの |
|---|---|---|---|
| フォント `HackGen35ConsoleNF-Regular 12` | Nerd Font 合成の日本語対応等幅。**全角 = 半角 × 2 で罫線が崩れない** | plist `Normal Font` | **済** — fork のグローバル `fontFamily` に HackGen Console NF 設定済み |
| 行間 1.15 / 字間 1.0 | 日本語長文の可読性 | plist | **済** — fork は xterm 行間 1.35 + 端末パディングでアプリ寄せ（README-KANJI §36-6） |
| 3 本指スワイプ | 左右 = 前後タブ / 上下 = 前後ウィンドウ | plist `PointerActions` | **要検討** — ブラウザではトラックパッドの水平スワイプが「戻る/進む」に取られる。Chrome `--app` モードなら回避できるか要検証 |
| `⌘⌥⌃⇧O/R/F` | Open Profiles / Reset / Toggle Full Screen | plist `NSUserKeyEquivalents` | ほぼ使っていない見込み。Reset は移行で不要に |
| iTerm2 内蔵 AI（gpt-5.5） | 自然言語 → コマンド生成 | plist `AITermAPI` | **要判断** — 使用実態が不明。Claude Code があるので優先度は低い |
| Python API 有効 | ただし Scripts / DynamicProfiles は**空**（AutoLaunch 未使用） | plist `EnableAPIServer` | secure-input-guard だけが使用（§6） |
| スクロールバック 10,000 行 / 透過なし / 25 行 | | plist | xterm.js 側で合わせる |

**再現不要と判定したもの:** プロファイルは `Default` 1 個のみ、プロファイル内キーマップは**空**、グローバルキーマップ改造なし、ホットキーウィンドウ**未設定**、Shell Integration **未導入**。

---

## 5. tmux-monitor（承認待ちスキャン + 自動承認）🔴 移行で最も壊れやすい

`/Users/kanjinoguchi/Projects/tools/tmux-monitor/monitor.sh`（launchd 常駐・PID 1585・2 分間隔）

| 機能名 | 何が便利か | 実装の場所 | MulmoTerminal 代替時に必要になるもの |
|---|---|---|---|
| 承認待ちの全ペインスキャン | `tmux list-panes -a` → `capture-pane -p` で `"Do you want to proceed?"` を検出。**30 ペイン全部を人間が見回らなくていい** | `monitor.sh` | 🔴 **要改修** — `tmux list-panes -a` は**デフォルトソケットしか見ない**。MulmoTerminal は `-L mulmoterminal` の別ソケット → **移行すると監視対象が 0 件になり、エラーも出ずに沈黙する**（memory `feedback_launchd-path-silent-failure` と同型の事故） |
| 3 段階 SAFE 判定 | ①パターンマッチ（UNSAFE 優先: rm/sudo/git reset/DROP 等） ②日本語説明文の語彙判定（「削除」「デプロイ」→ UNSAFE） ③ローカル Ollama `gemma3:4b` に判定させ、迷ったら UNSAFE | `monitor.sh` の `SAFE_PATTERNS` / `UNSAFE_PATTERNS` | ロジック自体は移植不要（そのまま使える）。**入力源だけ差し替え** |
| 自動承認 | `tmux send-keys -t <pane> Enter` | `monitor.sh` | ソケット指定（`-L mulmoterminal`）を足すか、MulmoTerminal の入力 API を叩く形に変える |
| 統計蓄積 | `logs/stats.json` | | そのまま |

**最小の修正案:** `monitor.sh` が両ソケットを走査するようにする（`for sock in default mulmoterminal; do tmux -L "$sock" list-panes -a ...`）。二重運用期間中も片方だけ見て安心する事故を防げる。

---

## 6. smux / tmux-bridge（ペイン間通信）

| 機能名 | 何が便利か | 実装の場所 | MulmoTerminal 代替時に必要になるもの |
|---|---|---|---|
| tmux-bridge | 異種エージェント連携（Codex CLI 等）・プロセスログ監視・クロスプロジェクト通信。`list` / `read` / `message` / `name` | `~/.smux/bin/tmux-bridge`（v2.0.0） | **たぶん動く** — `detect_socket()` が `TMUX_BRIDGE_SOCKET` 環境変数 → `$TMUX` → ペイン所有者スキャンの順で自動解決する（`tmux-bridge:38-60`）。**要実測検証** |
| read guard | ペインに書く前に必ず読ませる強制（`/tmp/tmux-bridge-read-<pane>` のフラグファイル） | `tmux-bridge` の `require_read()` | そのまま |
| claude-peers（別系統） | 同一リポの CC 同士のリアルタイム通知。MCP 経由 | `mcp__claude-peers__*` | **済** — fork の CLAUDE_BIN wrapper で MulmoTerminal 起動セッションも同じ peers ネットワークに参加（README-KANJI §64-1）。**既知の制限: 単一ビュー（/chat）では MCP ツールが載らない**（`--strict-mcp-config` のため） |

⚠️ `/tmp` 直下のフラグファイルは**マルチペインで消える**既知の罠（memory `feedback_shared-tmp-multipane-cleanup`）。移行と無関係に潜在バグ。

---

## 7. 周辺ツール（launchd 常駐）

| ツール | 何が便利か | 実装の場所 | 移行時の扱い |
|---|---|---|---|
| **ss-watcher**（PID 1577 稼働中） | `~/Desktop` を fswatch で監視し、スクショが出たら**パスをクリップボードに入れて通知**。Cmd+V でパスを貼れる。CEO が評価している機能（memory `feedback_ss-watcher`: 削除禁止） | `~/bin/ss-watcher.sh` | **そのまま存続** — ターミナルが Web かどうかと無関係な独立デーモン |
| **claude-command-guard** | PreToolUse hook で Bash の危険度を Ollama 分類 → ネイティブポップアップ or iPhone の早い方で承認 | `~/Projects/tools/claude-command-guard/guard.py` + `popup.swift` | ロジックは hook なので**そのまま動く**。ポップアップ（Swift/AppKit）は Web モーダルへの置き換えを検討 |
| **clipboard-sync**（PID 1560） | 複数 Mac 間で LAN クリップボード同期（AES-256） | `~/Projects/tools/clipboard-sync/clipsyncd.py` | **そのまま存続**（ターミナル非依存） |
| **iterm-fda-watchdog** | iTerm2 更新でコード署名ハッシュが変わり **FDA 権限が孤児化する**のを検知し、手順書 `FIX-NOW.md` を生成して通知（自動修復は SIP で不可） | `~/Projects/tools/iterm-fda-watchdog/watchdog.sh` | 🎉 **移行で問題ごと消滅** → 停止・廃棄候補 |
| **secure-input-guard** | iTerm2 が握りっぱなしにする secure input を、**iTerm2 自身の Python API でメニューを ON→OFF させて**解放（外部注入は SIP で不可）。Logi マウスのボタンが突然死ぬ原因（memory `logi-buttons-dead-secure-input`） | `~/Projects/tools/secure-input-guard/iterm2_secure_input.py` | 🎉 **移行で問題ごと消滅** → 停止・廃棄候補。**移行の隠れた最大メリットの一つ** |
| **claudebar** | メニューバーに Claude 利用状況を表示 | `~/Projects/tools/claudebar/` | 要検討（MulmoTerminal のコスト表示と重複しないか） |
| tmux-snapshot | tmux ペインのスナップショット / 復元 | `~/Projects/tools/tmux-monitor/snapshot.sh`, `restore.sh` | ソケット問題は §5 と同じ |
| cli-health | 全 CLI の self-test 一括実行 | `~/bin/cli-health` | 移行無関係 |

---

## 8. すでに fork で実装済みのもの（再掲・二重作業の防止）

`README-KANJI.md` によれば以下は**完了済み**。移行チェックリストに「やること」として再掲しないこと。

1. launchd 常駐（`com.kanji.mulmoterminal`・PID 40219 稼働中・落ちても 10 秒で復活）
2. claude-peers 連携（CLAUDE_BIN wrapper）+ dev-channels 確認プロンプトの自動通過
3. フォント HackGen Console NF / Claude アプリ風テーマ / 行間 1.35
4. 主要 9 プロジェクトの色バッジ・プリセット（実利用順）・prRepos 4 リポ
5. **iTerm2 モード**（縦カラム専用レイアウト・自動ズーム廃止・プリセット常駐ストリップ・ペイン常時ステータス行・不要ボタン非表示・D&D 並び替え・モデル · ctx % 表示）
6. tmux バックエンドによるセッション永続化（専用ソケット `-L mulmoterminal`）
7. keymap 機構（`common/keymap.ts` ほか。`/mulmoterminal-config` で対話設定可）

---

## 9. 🔴 移行チェックリスト作成にあたっての要判断・未解決事項

推奨案つきで列挙する。

**A. Status pane の「mission」層をどうするか（最重要）**
fork のステータス行は AI サマリー（＝今なにをしているか）を出すが、iTerm2 環境の Status pane が持っていた **mission（なぜここにいるか＝長期の大目的）** に相当する層がない。CLAUDE.md はこの mission を「**応答前に必ず書け**」という強制ゲートにしており、15-24 並列時の大目的ドリフト対策の中核。
→ **推奨: MulmoTerminal 側にセッション単位の手動 mission フィールドを足し、CLAUDE.md の書き込み先を `~/.claude/panes/<pair_id>.json` からそこへ差し替える。** 理由: AI サマリーは「今」しか表せず、mission の役割を代替できない。拒否権あり（mission 自体が不要と判断するなら CLAUDE.md の該当ゲートごと削除する選択もある）。

**B. tmux-monitor のソケット分離（サイレント故障リスク）**
§5 のとおり、移行すると自動承認が**エラーを出さずに沈黙する**。二重運用中の今も MulmoTerminal 側 7 セッションは監視外。
→ **推奨: 移行作業の最初に `monitor.sh` を両ソケット走査に直す。** 理由: 移行後に気づくと「なぜか承認が溜まる」の原因究明に時間を取られる。過去に同型の事故あり（launchd PATH 欠落で 850 回サイレント故障）。

**C. スマホ経路（Bark / RemoteHost）の実態確認**
claudecode-notify は Bark で iPhone に直送していた。MulmoTerminal は Web Push + RemoteHost を持つが、**fork の IT2_MODE で RemoteHost ボタンを非表示にしている**。
→ **推奨: 移行前に「外出先で承認待ちに気づけるか」を実機で 1 回試す。** 理由: 気づかないまま移行すると、外出中に全セッションが止まる。

**D. hook の二重登録リスク**
claudecode-notify は起動毎に `~/.claude/settings.json` の hook 7 種を自動修復する（`HookSetup.swift`）。MulmoTerminal も hook を使う（`server/session/hook-settings.ts`）。**両者が同じファイルを奪い合う可能性**がある。
→ **推奨: 移行の実行順として「claudecode-notify を停止 → settings.json を確認 → MulmoTerminal 側 hook を確定」の順にする。** 理由: 同時稼働中の今、既に片方が片方を上書きしている可能性があり、実測で確認が要る。

**E. CLAUDE.md の改訂範囲**
移行で無効になる記述が最低 4 箇所ある。
- 「ペインステータスの更新（claudecode-notify Status pane）」セクション全体（応答前ゲートを含む）
- 「別プロジェクトへのシームレス分岐」の `curl POST /api/workspace/add` 手順
- 「`[auto-save]` が来たら HANDOVER.md を更新」（**そもそも実装が存在しない** — §1-6）
- Environment Constraints の iTerm2 前提記述
→ **推奨: 移行完了時に `/revise-claude-md` を 1 回通す。** 理由: 個別に直すと漏れる。

**F. 未確認事項（移行チェックリスト作成前に潰すべき）**
- MulmoTerminal に「**エージェント自身が新カラムを開く**」外部 API があるか（CLAUDE.md のシームレス分岐が依存）
- 「**全セッションに一斉送信**」に相当する機能があるか（claudecode-notify の `/api/workspace/force`）
- tmux-bridge が `-L mulmoterminal` ソケットを自動検出できるか（**実測検証が必要**）
- `cct`（Agent Teams・`--teammate-mode tmux`）を MulmoTerminal 上でどう起動するか
- `~/.zshrc` の 1Password 自動ロードが、MulmoTerminal が spawn するシェルで発火するか（`op read` の stdin 消費の罠）
- iTerm2 の 3 本指スワイプ相当を Chrome `--app` モードで代替できるか

---

## 10. 移行で「失われるもの」と「消滅する問題」の総括

**失われる（代替の要否を判断すべき）**
メニューバーの常時可視性 / グローバルホットキー `Ctrl+Cmd+C` / OS 全体のタイピング検出つき Autofocus / エディタウィンドウの前面化（AX API）/ 3 本指スワイプ

**問題ごと消滅する（移行の隠れたメリット）**
iTerm2 の FDA 権限孤児化（TCC）/ secure input 握りっぱなしによる Logi マウス突然死 / macOS 26 の「他アプリのデータ」同意ダイアログ / tmux の pbcopy 破損回避のファイル経由コピー / トラックパッド誤入力による copy-mode 誤爆 / ディスプレイ切替時のレイアウト崩れ

**そのまま存続（移行と無関係）**
ss-watcher / clipboard-sync / claude-command-guard の判定ロジック / cli-health / 各種 launchd ジョブ

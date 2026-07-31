# 04 — 現状実装インベントリ（MulmoTerminal / kanji fork）

**生成モデル:** Claude Opus 5 (claude-opus-5[1m])
**対象:** `/Users/kanjinoguchi/Projects/tools/mulmoterminal`, branch `kanji`
**調査日:** 2026-07-31 / 読む深さ: 📗使い捨て（ギャップ分析の入力データ。判断は 05 以降で行う）
**目的:** 「iTerm2 完全代替」の要求定義に対するギャップ分析の土台。**いま何ができるか**だけを事実ベースで列挙する。何が足りないかは書かない（それは次のドキュメントの仕事）。

---

## 0. 一行サマリー

この fork は「PTY を Web に出す端末エミュレータ」ではなく、**Claude Code のセッション監視盤（コックピット）**として作られている。端末そのものの機能（xterm.js）は upstream のまま薄く、価値の大半は**セッションの状態検出・並べ替え・要対応通知**の層にある。iTerm2 の「端末としての機能」（タブ、ペイン分割の自由度、検索、プロファイル、キーバインド）はほぼ手つかずで、逆に iTerm2 にない監視機能が厚い。

---

## 1. 実行環境と起動系（現状の運用形態）

| 項目 | 現状 |
|---|---|
| 常駐 | launchd `com.kanji.mulmoterminal`（ログイン時自動起動・落ちて10秒で復活）。ログ `~/.mulmoterminal/server.log` |
| アクセス | `http://localhost:34567` をブラウザで開く（Chrome の app-mode window 想定。README-KANJI の記述より） |
| 手動起動 | `~/bin/mterm` / `mterm --no-open` |
| claude の起動 | `CLAUDE_BIN` → `~/bin/claude-mulmo`（wrapper）。`--dangerously-load-development-channels server:claude-peers` を付与し iTerm2 ペインと同じ claude-peers ネットワークに参加させる |
| 技術スタック | Vue 3 + Vite（`src/`）/ Express + node-pty（`server/`）/ 共有 `common/` / xterm.js / tmux（永続化）/ Vitest |
| プロセス構造 | 1 サーバープロセスが全 PTY を保持。ブラウザは WebSocket クライアントに過ぎない（= ブラウザを閉じてもセッションは死なない） |

**セッション永続化**は専用 tmux サーバー（`tmux -L mulmoterminal`、独自 conf）で行う。`tmux new-session -A -s mt-<id>` で「作成 or 再アタッチ」を1コマンドで実現しており、**サーバークラッシュ・`node --watch` リロードを跨いでセッションが生き残る**（`server/infra/tmux.ts`, `server/session/pty-spawn.ts:54-69`）。OSC 52（クリップボード）と OSC 8（ハイパーリンク）を tmux 越しに通す terminfo override 済み。

---

## 2. グリッド／ペイン UI（fork が最も手を入れた層）

### 2.1 レイアウトモデル（iTerm2 モード）

- **縦カラム専用**。`src/components/gridLayout.ts` の `LAYOUTS = ["1".."8"]`、`dims()` は常に `rows: 1`。段積み（2x2 等）は**意図的に廃止**（27" 4K で1スレッドあたりの可読行数を最大化するため、とコメントに明記）。
- **1ページ最大 8 カラム**（`MAX_CELLS = 8` = `PAGE_SIZE`）。**全体上限 64 セッション = 8ページ**（`MAX_TERMINALS = 64`, `gridTabs.ts:63`）。
- **ページング UI はページ番号ボタンのみ**（`GridView.vue:553-567`）。`1 2 3 …` の数字ボタンが並ぶだけで、ラベル・リネーム・並べ替えは無い。ズーム中はタブ行ごと非表示。
- ページはあくまで**1本のフラットな cell 配列のスライス**。セルを閉じると後続が前に詰まり、ページ境界を越えて流れ込む（`closeCell` → reflow）。**ページに「所属」する概念はない**。
- 状態は `localStorage` の `grid_v2` に永続化（`STATE_KEY`）。ブラウザのプロファイル依存。

### 2.2 ペイン（TerminalCell）の構造 — 現在3層

1. **左端の縦カラー帯**（3px）: `.mulmoterminal.json` の `badgeColor`。プロジェクト識別を垂直方向にゼロコストで持たせる（`stripeStyle`, TerminalCell.vue:893）
2. **行1 = 24px アイデンティティ行**: config 駆動の chips（git ブランチ、worktree diff、model/ctx、token usage、カスタム）+ `…`（ツールバー展開）+ ズーム/クローズ。**cwd とセッション ID は pixel から消え、hover title のみ**（`headerTitle`, :889）。ヘッダー自体が**ドラッグハンドル**（列並べ替え）
3. **行2 = 22px トリアージ行（fork 独自）**: ● + 状態語 + **AI サマリー**（最も明るいテキスト）+ 最後のプロンプト（幅に余裕がある時だけ `@[340px]/pane:inline`）+ 右端に **モデル名 · ctx%**（`ModelContextBadge`, :1167）

状態語は**介入語彙**（何をすべきか）で日本語固定: `要対応`(blocked) / `未読`(done) / `実行中`(working) / `待機`(idle)（`STRIP_LABEL`, :881）。枠色は `blocked=琥珀 + 2px リング` / `done=accent + リング` / `working=accent` / `idle=dir 色`。

**行3（Skill / 添付 / フォルダ / 音声 / タイムライン）は既定で隠され、`…` ボタンで per-cell 展開**。ズーム時は常時表示。削除ではなくワンクリック先に退避。

### 2.3 セルの種類

`gridTabs.ts` の `Cell` は4種を1つの型で表現:
- Claude セッション（デフォルト、`agent` 無し）
- Codex セッション（`agent: "codex"`）
- ランチャーセル（`launcher`: `$SHELL` または config の `launchers[]`）— 永続・再接続する
- コマンドセル（`command`: Run メニューの script）— **非永続**（リロードで消える）
- 空のランチセル（何も無い = 起動フォーム）

### 2.4 並べ替えと注意喚起

- **auto モード**: 安定ソートで `blocked → done → idle → working` の順に浮上（`RANK`, :405）。**working が最下位**なのが設計の肝（見る必要が無いから）。全ページを跨いでソートしてからページングするので、**3ページ目で許可待ちになったセルが1ページ目に浮いてくる**
- **manual モード**: ヘッダードラッグ（splice 移動、swap ではない）。auto 中にドロップすると manual に自動切替
- **ツールバーの集計**: 全ページ横断で `blocked / done / working` の数を色付きドットで表示（`gridStatusSummary`）
- **プリセットチップの琥珀バッジ**: そのディレクトリのペインが**どのページであれ** blocked なら件数が出る（`presetAlerts`, GridView.vue:357）

### 2.5 プリセットストリップ（fork 独自・32px の単一ヘッダー行に統合）

- 全プリセットがチップとして常駐。`▶` 1クリックで**新カラムを開いて claude を自動起動**（ランチャー画面を経由しない。`addCellWithCwd` + TerminalCell の `autoLaunch`）
- チップは**ドラッグで並べ替え**（サーバー config に永続化）。ホバー 250ms で `x`（プリセット削除）
- 末尾の `＋` で **OS のフォルダ選択ダイアログ** → 選んだディレクトリで即カラム起動（`/api/pick-file`）。起動したディレクトリは自動でプリセット登録される

### 2.6 ズームとコックピットロースター

- ズーム = 1ペインを拡大 + 左に**全セッションのロースター**（360px 固定幅）。1行 = 状態 + dir 色 + AI サマリー + 自分の最後のプロンプト + **エージェントの最新の返答** + PR フェーズ（draft / CI fail / ready / merged）+ work phase
- ロースターのデータは pub/sub ではなく **`GET /api/session/:id`（トランスクリプト読み）を 4 秒ポーリング**。行数は config の `cockpitLines`（summary 2 / prompt 2 / response 3 行）で調整
- ロースターとサムネイルフィルムストリップはツールバーのトグルで切替
- ズーム不変条件が5つコメントで明文化されている（`gridTabs.ts:235-262`）— 触るならここを読む必要がある

---

## 3. セッションエンジン（server/）

### 3.1 エージェント

`AgentKind = "claude" | "codex"`（+ 非エージェントの `"shell"`）。アダプタパターン（`server/agents/registry.ts`）。バイナリは `CLAUDE_BIN` / `CODEX_BIN` env で差し替え可能。

**claude の起動引数**（`claude-args.ts`）: `--resume|--session-id`, `--settings <json>`（フック定義 + provider env）, `--permission-mode`, `--model`, （単一ビューのみ）`--mcp-config --strict-mcp-config --allowedTools`, `--add-dir`。**初回プロンプトは CLI 引数ではなく起動後に入力欄へタイプ注入**する（tmux の new-session コマンド長制限回避）。

**プロバイダ差し替え**: `.mulmoterminal.json` の `provider`/`model` で Anthropic 互換の第三者バックエンド（OpenRouter 等）に向けられる。解決できない場合は**Anthropic に無言フォールバックせず拒否**する（`ProviderRefusedError`）。現在の config では `providers: []` = 未使用。

### 3.2 状態検出 — 「画面パース」ではなく「Claude Code のフック」

ここは誤解しやすいので明記する。**要対応/作業中の判定は screen scraping ではない。** Claude Code の hooks を `--settings` で注入し、`curl -X POST /api/hook` させている（`server/session/hook-settings.ts`）。

登録フック: `UserPromptSubmit` / `Stop` / `Notification` / `SessionStart` / `PreToolUse` / `PostToolUse` / `PostToolUseFailure`。

状態は**2つの独立したブール + イベント名**（`Activity` 型、`server/session/types.ts:8-13`）:

| 表示状態 | 条件 | 意味 |
|---|---|---|
| `working` 実行中 | `working=true` | ターン進行中 |
| `blocked` 要対応 | `waiting=true` かつ `event="Notification"` | 許可待ち・質問待ち |
| `done` 未読 | `waiting=true` かつ `event="Stop"` | 終わったが未確認 |
| `idle` 待機 | どちらも false | |

重要な設計: `Stop` でも**そのペインを実際に見ている（active）なら waiting を立てない**。`active` は「ソケットが繋がっている」ではなく「単一ビューで開いている or グリッドでフォーカス/ズームされている」。

派生状態として **work phase**（`planning` / `implementing`）もある。`Edit/MultiEdit/Write/NotebookEdit` が走ったら implementing、読み取り・検索・Bash だけなら planning（`server/session/workPhase.ts`）。ロースターに出る。

**screen-rows.ts の役割は別**: tmux `capture-pane -e` の出力を行 + dim 属性にパースし、Claude の**インラインのゴースト提案**（`❯ <dim text>`、Tab で確定するやつ）を検出する。スマホから提案を送るための機能で、状態判定には使われていない。

### 3.3 セッションの片付け（reap）

WS 切断で即殺さない。idle は 30 秒、**waiting（許可待ち）は 30 分**の猶予（`WAIT_REAP_GRACE_MS`、env で変更・`0` で無効）。`waiting` を `working` より先に判定する（`Notification` は `working` をクリアしないため、しないと永久にリークする）。

### 3.4 コスト・タイトル

- `server/session/cost.ts` にモデル別 $/1M トークン表（`claude-fable-5` / `opus-4-8` 等も prefix で入っている）。今日/今月をプロジェクト別に集計（`GET /api/cost`）
- **AI 生成のセッションタイトル**を `Stop` のたびに条件付きで再生成（`session-title.ts`）。これがロースターとステータス行の「AI サマリー」の正体

---

## 4. 通知・チャイム

**2系統が並存している。**

**A) 汎用の通知ベル**（`server/backends/notifier.ts`、`@mulmoclaude/core` 由来）: `info|nudge|urgent` × `fyi|action`。ツールバーのベルアイコン。**Claude セッションとは無関係**な、collection watcher 等のためのアプリ全体通知。

**B) セッション活動の push + チャイム**（こちらが実運用されているもの）:
- **種別は2つだけ**: `finished`（Stop）/ `waiting`（Notification）— `common/pushKinds.ts`
- **Web Push（スマホ）**: `pushEnabled` が master switch。**現在の config は `pushEnabled: false`** = スマホ通知は無効。RemoteHost/Firebase 未接続なら関数ごと no-op
- **チャイム（ブラウザ内）**: `src/composables/useAttentionSound.ts`。`sessions` pub/sub を購読し、クライアント側で working/waiting の**エッジ**を検出して鳴らす。既定は合成音（G5→C6 のサイン波2音）、`soundFile`（グローバル）または dir 別の音ファイルで差し替え可。初回クリック/キー入力で autoplay unlock
- **OS ネイティブ通知（macOS の通知センター）は実装されていない**。チャイムか Web Push の二択

---

## 5. 設定スキーマ（現状値つき）

### 5.1 グローバル `~/.mulmoterminal/config.json`

| キー | 意味 | 現在の値 |
|---|---|---|
| `cwdPresets` | プリセットチップ（label + path） | 10件（home / orosy-v2 / team-docs / voicewriter / cc-notify / swf-v0 / fleet-watch / 大阪玩具 / api-docs-site / mulmoterminal） |
| `fontFamily` | 全端末の CSS フォントスタック | `'HackGen Console NF', 'BIZ UDGothic', monospace` |
| `keymap` | キーボードショートカット | **`{}` = 全部未割り当て** |
| `prRepos` | 横断 PR/Issue ビューの対象 | 4リポジトリ |
| `launchers` | ランチャーセルで起動できる代替コマンド | `Shell = $SHELL` の1件のみ |
| `quickCommands` | スマホ用の定型文チップ | 4件（続けて / 検算 / PR / …） |
| `cockpitLines` | ロースター各行のクランプ行数 | summary 2 / prompt 2 / response 3 |
| `pushEnabled` / `pushKinds` | Web Push | **false** / `["finished","waiting"]` |
| `terminalSubmit` | Enter の意味（`cr` / `esc-cr`） | `cr` |
| `soundFile` | カスタムチャイム | null（内蔵音） |
| `worklogEnabled` / `worklogIntervalHours` | 定期 worklog 生成 | false / 6 |
| `providers` / `userMcpServers` / `buttons` / `chips` | 第三者プロバイダ / ユーザー MCP / ヘッダーボタン / チップ | 全て空 or null（= デフォルト） |
| `prWorkdirFooter` | PR に作業クローン注記 | true |

**⚠️ グローバル設定はサーバー起動時に一度だけ読まれる**。手編集したら `launchctl kickstart -k` が要る。

### 5.2 ディレクトリ別 `<project>/.mulmoterminal.json`

`name` / `badgeColor` / `headerColor` / `headerTextColor` / `cellColor` / `cellBorderColor` / `dotColor` / `buttonColor` / `theme` / `colors`(23 の xterm パレットキー) / `fontSize` / `fontFamily` / `sound` / `buttons` / `chips` / `skills`(Skill メニュー allowlist) / `provider` / `model` / `addDirs`(最大16)。

主要9プロジェクトに色分けバッジ設定済み。`~/.gitignore_global` に登録済みなので各リポジトリは汚れない。**このファイルへの Write を Claude がフックで検知して live reload する**（`tool-hook.ts` の `publishesDirConfig`）。

### 5.3 キーマップ — **7 アクション、現在すべて未割り当て**

`common/keymap.ts` の `KEYMAP_ACTIONS`:
`zoom-toggle` / `zoom-next` / `zoom-prev` / `next-attention` / `terminal-new` / `terminal-new-adjacent` / `terminal-close`

- 構文: `"Shift+PageUp"` 形式。修飾子 `shift/alt/option/ctrl/control/meta/cmd/command`
- **デフォルトは意図的にゼロ**（バインドした鍵は下の端末から奪われるため、ユーザーの明示的な選択に限る、という設計方針がコメントに明記）
- 4アクション（`zoom-next/prev`, `terminal-new-adjacent`, `terminal-close`）は**ズーム中しか効かない** — 非ズームのグリッドには「現在の端末」という概念が無いから（`gridShortcut.ts:34`）。ただし GridView は `focusedCellUid` を持っており、`zoom-toggle` と `next-attention` はそれを使う
- 捕捉は `window` の **capture phase**（xterm が自分の textarea で keydown を握る前に奪う）
- xterm の入力欄（`xterm-helper-textarea`）は「編集可能要素だから無視」の対象から明示的に除外されている

### 5.4 テーマ

`THEME_IDS = ["claude", "midnight", "nord", "daylight", "solarized"]`。fork が **`claude`（温チャコール #262624 + テラコッタ #d97757 + くすみ ANSI16）を新設してデフォルト化**。xterm 行間 1.35、端末パディング、テーマ連動の 6px スクロールバー + `color-scheme` も fork 側の追加。

---

## 6. IT2_MODE で隠されているもの／実は残っているもの

フラグは `src/components/AppToolbar.vue:113` の `const IT2_MODE = true;` 1箇所のみ。`false` にすれば全部戻る。**ガードしているのは3つだけ**:

| 隠したもの | URL 等で到達できるか |
|---|---|
| Chat（単一ビュー）ボタン | **できる** — `/chat` ルートは無傷。アドレスバーで直接叩けば GuiPanel / ToolsPane 込みで動く |
| Worklog ボタン | **できる** — 実体は wiki のタグフィルタ。`/wiki?tag=worklog` で同じ |
| RemoteHost（スマホ連携）コントロール | **できない** — ルートを持たないツールバー専用コンポーネント。DOM から消えるため `remoteHostView.ts` の自己修復・再接続も動かない。サーバー API (`/api/remote-host/*`) は生きているので curl は可能 |

**IT2_MODE と無関係に非表示なもの**（upstream の `inGrid` 分岐、#886）: Collections / Accounting / Wiki / ピン留めお気に入りは「グリッド表示中は隠す」が upstream の仕様。**PR ビューはグリッドで残している**（fork の明示的判断）。

つまり **実質的に失われている UI 導線は RemoteHost だけ**。他は URL 一発で戻る。

---

## 7. 存在するが（この運用では）眠っている upstream 機能

| 機能 | 実体 |
|---|---|
| 音声入力（on-device Whisper） | `server/backends/whisper.ts`。macOS のみ、初回にモデル DL。言語選択あり |
| 翻訳 | `server/session/translation-*.ts` + 専用ワーカーセッション |
| 画像生成 / artifacts / thumbnails | `image-gen.ts` / `artifacts.ts` / `thumbnailStore.ts` |
| Google Calendar / Google 連携 | `calendarPush.ts`, `google.ts`, `useGoogleLink.ts` |
| Wiki（グラフ・lint 付き） | `server/backends/wiki.ts`、`/wiki` 系4ルート |
| Collections / GUI パネル（Canvas） | エージェントが MCP 経由で「ドキュメント・フォーム・チャート・画像・HTML」を描く仕組み。**単一ビュー専用** |
| Accounting | `/accounting`。トークン・コストのビュー |
| Docker サンドボックス | `Dockerfile.sandbox` + `server/infra/sandbox.ts`。**単一ビューの対話セッションのみ**対象 |
| Codex エージェント | 完全実装（rollout id の追跡込み）。ランチャーから選べる |
| スケジューラ / feeds / worklog 自動生成 | `scheduler.ts`, `feeds.ts`, `worklog.ts`。worklog は config で off |
| プラグインレジストリ | `plugins-registry.ts` (client/server 両方) |
| クロストーク（他セルのターンを持ってくる） | `useCrossTalk.ts`。行3 に隠れている `💬` |
| タイムライン | 読み取り専用のツール実行履歴。行3 に隠れている |
| worktree / PR 操作 | セルから worktree 作成 → diff パネル → commit/push/PR。**これは生きていて PR ビューも残している** |
| ファイルパスのリンク化 | エージェントが出力したパスを拡張子で振り分けて開く（md はレンダリング、json は整形、csv は表、46拡張子は内蔵 Files ビュー） |

---

## 8. 拡張ポイント（新機能を足すならどこか）

### 8.1 ペインに UI 要素を足す
- **常時見せる情報** → `TerminalCell.vue:1141-1175` のステータス行。既に `flex` で dot / 状態語 / AI サマリー(flex-auto) / prompt(条件付き) / ModelContextBadge が並ぶ。要素を足すなら `flex-none` で右側へ、`@[340px]/pane:` のコンテナクエリで幅条件を付ける作法
- **config 駆動で足す** → 行1 の chips は `cellChips` でループしており、`builtin`（git/diff/ctx/usage）と `custom`（`.mulmoterminal.json` の `chips`）を分岐している。**サーバー設定だけで増やせる導線が既にある**（`server/config/header-config.ts` / `header-chips`）
- **ボタン** → `buttons`（グローバル + dir 別、id でマージ、`order` あり、`when: isGitRepo` のような条件付き）。デフォルト6種は `DEFAULT_BUTTONS`

### 8.2 キーバインドを足す
1. `common/keymap.ts` の `KEYMAP_ACTIONS` に文字列を1つ足す（コメントに「ここに足すだけで config が受け付ける」と書いてある）
2. ズーム不要なら `gridShortcut.ts:34` の `NEEDS_A_CURRENT_TERMINAL` から除外
3. `GridView.vue:480` の `runShortcut()` に分岐を足す
4. ユーザーの `config.json` の `keymap` に割り当てる（**現状 `{}` なので、何を足しても割り当てないと動かない**）

制約: **ブラウザが奪えないキーは実装不能**（`Cmd+T` `Cmd+W` `Cmd+N` `Cmd+Q` 等）。README も「a browser can never bind」と明記している。これが iTerm2 パリティの構造的な壁。

### 8.3 通知を足す
- 種別を増やす → `common/pushKinds.ts` の `PUSH_KINDS` に追加 + `DEFAULT_PUSH_KINDS` は**意図的に別リスト**（新種別が既存ユーザーに勝手に有効化されないため）
- トリガーを増やす → `server/session/activity-hook.ts` の `pushKindFor` / `activityHookEffects`
- 新しいフック種別を拾う → `server/session/hook-settings.ts` に登録 + `server/routes/hook-routes.ts` の fan-out に足す
- 音を変える → クライアント側 `useAttentionSound.ts`（サーバー往復なし）

### 8.4 複数ウィンドウ／ワークスペース（タブページ）
- **現状「ワークスペース」概念は無い**。あるのは①1本のフラットな cell 配列 ②8個ずつのページ ③`localStorage` の単一 `grid_v2` キー
- ページはラベルを持てない（数字のみ）。ページに属性を持たせるなら `GridState` の拡張 + `parseGridState` の永続化スキーマ変更（uid の振り直しロジックあり、要注意）
- 複数ブラウザウィンドウを開くと**同じ `grid_v2` を共有する**（同一オリジンの localStorage）。真の複数ウィンドウは未対応
- サーバー側のセッションレジストリはウィンドウを知らない（セッション id とアクティビティだけ）。ウィンドウ/ワークスペースを足すならクライアント側の状態モデルの話になる

### 8.5 グリッドのページング
- 追加は末尾へ（`addCell` / `addCellWithCwd`）、`insertCellAfter` は隣に挿す。どちらも**満杯なら自動で次ページ**（`page: pageCount(cells.length) - 1`）
- 閉じると reflow して前詰め。ページ間で端末が流れる
- ズーム中は `order` が**全ページの通し順**になる（不変条件 2）。ここを崩すとページ計算が全部壊れる旨がコメントで警告されている

---

## 9. スマホ連携・リモートアクセスの現状

- **RemoteHost 本体はサーバー側に完全実装**（`server/backends/remoteHost/` 配下に 30 ファイル超、spec 付き）: Firebase 経由の接続、セッション一覧、端末画面のミラー（`terminalScreen.ts`）、入力送信（`terminalInput.ts`）、添付ファイル、スキル一覧、クイックコマンド、Google カレンダー、健全性通知、自己修復リトライ
- **しかし UI 導線は IT2_MODE で消えている**（§6）。`RemoteHostControl.vue` はルートを持たないので URL でも開けない
- Web Push もこの Firebase セッションのトークンに依存するため、**RemoteHost 未接続 = スマホ通知は物理的に飛ばない**。`pushEnabled: false` と合わせて二重に無効
- `quickCommands`（続けて/検算/PR）は設定されているが、**それを使う画面（スマホ側）に到達できない**状態
- スクリーンパース（`screen-rows.ts`）の主目的は「スマホから Claude のゴースト提案を Tab 確定させる」ことで、これも同様に眠っている

---

## 10. fork 独自コードの全量（upstream との差分）

`upstream/main..kanji` = **8 コミット / 22 ファイル / +1093 -253 行**。触っている範囲は `src/components/`, `src/composables/`, `common/themeIds.ts`, `server/session/{channel-consent.ts, spawn-claude.ts}`, `test/`, `README-KANJI.md` のみ。**バックエンドは実質無改造**。

唯一のサーバー側追加が **`server/session/channel-consent.ts`**: claude-peers の dev-channels 同意プロンプト（「I am using this for local development / 2. Exit」）を自動で Enter する。
- env `MULMOTERMINAL_AUTOCONFIRM_CHANNELS` に一致するチャネル文字列がある時だけ発火（未設定なら完全な no-op）
- claude はこの文を単語ごとにカーソル移動で描くため、エスケープを空白化して正規化してから3条件（同意文 / "2. Exit" 行 / チャネル文字列の完全一致）を全て満たす時だけ発火
- **TUI 起動マーカー（`shift+tab to cycle`）検出、または 30 秒で武装解除**。起動後にこの文言をファイル表示しても誤 Enter は飛ばない（code-reviewer の指摘で追加された安全機構）
- 発火時は `[consent] auto-confirming ...` をサーバーログに残す

**既知の制限（README-KANJI 記載）**: 単一ビュー（`/chat`）のセッションは `--strict-mcp-config` で起動するため、**そのセッションから claude-peers の MCP ツールが呼べない**（チャネル受信は生きる）。グリッドのセッションは制限なし。

---

## 11. 検証済みの事実 / 未検証

**ソースを直接読んで確認した**: レイアウト定数（8列/64セッション）、状態判定がフック駆動であること、keymap が空であること、IT2_MODE のガード範囲が3箇所であること、config の全キーと現在値、channel-consent の動作、通知2系統の構造。

**未検証（ソースの記述を信じている）**: 実際のブラウザ挙動（描画・パフォーマンス・27" 4K での実際の可読性）、launchd 常駐が今この瞬間生きているか、RemoteHost サーバー API が実際に応答するか、Web Push の疎通。これらは実機確認が必要で、今回の静的調査の範囲外。

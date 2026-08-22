# MulmoTerminal 利用実態監査 → 拡張提案

**生成モデル:** 統合・分析: Claude Fable 5 (claude-fable-5) / 資料収集: Opus 5 サブエージェント4体
**読む深さ等級:** 📙要判断（提案の採否・順番だけ判断すればよい。付録はアーカイブ）
**日付:** 2026-08-22
**調査ソース:** memory 883ファイル（CHALLENGES.md 含む）/ ~/Projects/tools 31ツール / 本 repo の機能台帳（R1〜R20・非目標4件）/ 過去セッション 287 jsonl（ユーザー発言67件抽出）

---

## CEO フィードバック確定（2026-08-22・本人回答）

- **U6（読書モード）が本命に昇格**。「めっちゃ気になる。読みやすくなるならめっちゃありがたい」。追加の実痛点: 長文プロンプト後、途中の応答がログの山に埋まり、最終サマリーしか画面に残らない。前の応答を読むために毎回大量スクロールしている（スクショ実録あり）。→ 仕様は「最後の応答のレンダリング」でなく**ターン単位の会話ビュー**（ツールログを畳み、プロンプト/応答だけを Markdown で読む・前の応答へジャンプ）に拡張
- **U1（キャッチアップカード）は仕様再検討**。「ペインを開く」という動作が存在しない（ペインは開きっぱなし）。トリガーを stale ペインのホバー/フォーカス時に変更する必要あり。保留
- **U2（inbox+承認）は任意**。「最近承認待ちで困ったことはない。便利になるなら任せる」。**iPhone 承認は不要が確定** — モバイルの承認・継続ニーズは Claude Code ネイティブアプリに委譲し、MulmoTerminal では解決しない（非目標に追加相当）
- **U3・U4・U5 は却下**（「よくわからない」）
- 働き方ルール確定: 生成 .md は本人は読まない（Claude の辞書）。本人が読むのは「HTMLで起こして」と言ったものだけ → memory/feedback-md-for-ai-html-for-human.md

## 結論（3層）

### 今すぐ効く（quick win）

**U1. キャッチアップカード — 放置ペインの「目的/現在地/残り/確認ポイント」を聞かずに見る**
- 根拠: 直接発言。「数日放置したペインを再開するとき4点を毎回聞き直している（1セッション中に3回発生）」（preference-candidates 2026-08.md, 08-10）
- 中身: 一定時間 idle のペインをフォーカスした時、既存データだけでブリーフを出す — mission（R2）+ 最後のプロンプト/応答（R11 のコピー機構と同じログ由来）+ TodoWrite ミラー（live task 行）+ 状態語。ホバーカード（R14）の拡張として実装でき、LLM 呼び出し不要（決定論）。
- なぜ最初か: データ源が全部既にあり接続作業に近い。毎日の再開コストに直撃する。

### 本命フェーズ（既定路線の完成）

**U2. エスカレーション inbox（R20）+ 承認の一級市民化 — 1フェーズとして**
- 根拠: 3ソースが独立に同じ結論に収束。①backlog の R20「本命ビジョン・単独大型フェーズ」 ②memory 痛点の最頻出2テーマ（判断待ちペインの発見 / 承認で無言停止） ③自作ツール群の一貫パターン「注意の配分の自動化・承認摩擦ゼロ」（tmux-monitor / claude-command-guard / claudecode-notify は全部この穴を外から塞ぐ回避策）。
- 中身:
  - **承認検知を PTY で確実に**: tmux-monitor は2分ごとの画面スクレイプで承認待ちを「推測」しているが、MulmoTerminal は PTY を所有しており確実に検知できる。承認ダイアログで無言停止する Worker 問題（feedback_approval_proxy_proactive_detection.md）の根治。
  - **承認ポリシー**: セッション/ディレクトリ単位で SAFE 自動承認・危険のみ浮上（tmux-monitor の SAFE 判定と claude-command-guard のポリシーを製品機能に吸収。夜間の bash 常駐 monitor という運用回避策を廃止できる）。
  - **inbox はグリッド内**: 畳める「要判断」レーン or 上部バー。AI が処理できたものは畳まれ、CEO の判断が要るものだけカード（承認/質問/CI失敗）で浮上。カードから承認/拒否/一言返信。
  - **ガードレール（非目標に抵触しない設計）**: 別画面ダッシュボードにしない（2026-07-02 却下済み）。モバイルは新規開発せず既存 RemoteHost クイック返信と Web Push を再利用（2026-07-27「後回し」に整合）。コスト/失敗回数メトリクスは表示しない（2026-05-19「興味もない」）。
- U1 とも接続: inbox のカードを開くとキャッチアップカードで文脈が付く。

### 中期（inbox が立ってから効く）

**U3. 状態要約のローカル LLM 高速化** — 直接発言「更新の頻度が遅いのは…ローカルLLMを使ってようやくとか」（2026-08-17）。決定論側（TodoWrite ミラー）は済んでおり、残る鮮度ギャップは AI 要約のみ。repo 同梱の claude-ollama 経路が流用候補。
**U4. claudecode-notify のフック取り込み** — 推論（ツール重複分析より）。Claude Code フックイベントの取り込み口を持ち、MulmoTerminal 外のセッション（素の tmux / VS Code 等）も同じグリッドに並べる。port 19460 / tmux を三つ巴で触っている現状の整理にもなる。
**U5. R19: PR/CI 割り込み通知** — 既存 backlog。CI 失敗・merged を inbox のカード源として実装（claudecode-notify の GitHubPRMonitor 移植）。U2 の続編として自然。
**U6. R17: 読書モード** — 既存 backlog。最後の応答を Markdown レンダリングで読むトグル。「タイルのまま読む」（feedback-tile-first-workflow.md）の読みやすさを一段上げる。

### 検討して落とした案（重複・非目標抵触）

- **voicewriter 統合** — MulmoTerminal は既にオンデバイス Whisper 音声入力を持ち（POST /api/transcribe）、memory 上も MulmoTerminal への音声要望はゼロ。重複のため落とす。
- **フリート健全性タイル / メトリクス表示** — 「コスト・トークン・失敗回数の監視メトリクス表示」は明示的非目標（2026-05-19）。健全性は U2 の inbox カード（異常時のみ浮上）としてのみ扱う。
- **横断ダッシュボード / モバイル新規開発 / Cmd キー再現** — いずれも非目標として確定済み（05-requirements.md §2）。

### 推奨

**U1 を先行実装 → 次フェーズで U2（R20+承認統合）。U3〜U6 は U2 の後。** 理由: U1 は接続作業で即日効く。U2 は3ソースが収束した本命で、単独フェーズの重さ（Triad 級）。外す案・順番の変更だけ指示をください。

---

---

# 付録（調査の全過程・原文アーカイブ）

以下はサブエージェント4体の報告全文。会話クリア後もこのファイルだけで再現できるよう原文のまま収録。

## 付録A: 自作ツール棚卸し（audit-tools）

調査完了。~/Projects/tools/ 配下 31ディレクトリを走査（README.md / CLAUDE.md / スクリプト冒頭コメントのみ、コードは未読）。

### 1. ツール一覧（最終コミット日順）

| ツール | 一言 | 最終コミット |
|---|---|---|
| meeting-sync | 週次全社MTGのGeminiメモ(Google Docs)を team-docs に自動sync | 2026-08-22 |
| cli-tools | 「LLMに機械作業をさせない」決定論CLI群（retro等、`--json`/`--self-test`規約） | 2026-08-20 |
| mulmoterminal | ブラウザからClaude Codeの多ペインをグリッド運用（本件） | 2026-08-20 |
| claudecode-notify | macOSメニューバー+Webダッシュボード。全Claudeセッションの待ち状態を監視・iPhone対応 | 2026-08-10 |
| tmux-monitor | 全tmuxペインを2分巡回し承認待ちを検知・SAFE判定は自動承認するデーモン | 2026-08-06 |
| voicewriter | ローカル音声ディクテーション。喋り→Whisper→LLM整形→自動ペースト（Typeless代替・月$0） | 2026-08-04 |
| buzz | 人間とAIエージェントが同じ部屋で協働するセルフホストWorkspace | 2026-07-30 |
| discord-meeting-bot | Discord会議を録音→文字起こし→要約→team-docsへpush（Mac mini常駐） | 2026-07-30 |
| autopilot-template | 各プロダクトに「月次オートパイロット」を後付け（分析→実装→デプロイ→Slack通知まで自走） | 2026-07-27 |
| open-seo | Semrush/Ahrefs代替のOSS SEOツール（外部OSS） | 2026-07-21 |
| mac-mini-agent | Mac mini常駐AIエージェント基盤（夜間蒸留・提案・SNSドラフト） | 2026-07-10 |
| tesla-order-status | Tesla注文ステータス取得スクリプト（外部OSS） | 2026-06-14 |
| ACE-Step-1.5 | ローカル音楽生成モデル本体（bgmのバックエンド） | 2026-05-18 |
| agent-ops | サブエージェント/Tier2 AI従業員の運用基盤モノレポ（trust-gate・auto-heal・kb-harvest） | 2026-05-05 |
| trackpad-gestures | トラックパッドジェスチャのmacOSネイティブアプリ | 2026-04-23 |
| dotfiles | MacBook Proのdotfiles/Brewfileのプライベートバックアップ | 2026-04-11 |
| ai-website-cloner-template | 任意サイトをNext.jsで再構築するテンプレ（外部OSS） | 2026-03-30 |
| remotion-studio | Remotionによる動画生成スタジオ（プロダクト紹介動画） | 2026-03-23 |
| claude_code_agent_farm | Claude Codeを並列起動しコード改善する外部OSS | 2026-03-21 |
| claudebar | Anthropic API利用状況のメニューバーアプリ（Swift） | 2026-03-15 |
| fleet-watch | 自律AI群を監査する「フリート監督官」ペイン用CLAUDE.md（コード無し・常駐性をファイルに持たせる） | git外 |
| claude-command-guard | PreToolUseフックでbashをOllama要約→Macポップアップ+iPhoneで許可/拒否 | git外 |
| clipboard-sync | LAN内Mac間クリップボード同期デーモン（自作P2P・AES-256） | git外 |
| music-gen (`bgm`) | ローカル無料BGM生成CLI（画像の`gen`の音楽版） | git外 |
| watchdog3種 (iterm-fda / karabiner / mac-mini-outbox) | macOS権限失効・デーモン死・outbox新着を検知して通知/自動取り込み | git外 |

その他小物: secure-input-guard（iTerm2のsecure input掴みっぱなしを解く）、health-check、agent-md-updater、mouse-gestures-poc。
~/Projects/ 直下: orosy-v2（本業プロダクト）、orosy-unified-api、tier2-design、hermes-workspace、ads-data、firecrawl、clicky-agent-factory 等。

### 2. 自動化・可視化したがっている領域（5点）

1. 注意の配分そのものを自動化したい。15〜24ペイン並列が常態で希少資源は本人の目。claudecode-notify・tmux-monitor・fleet-watch・claudebar・mulmoterminal は全部「今どれが自分を待っているか」を答えるために作られている。
2. 承認の摩擦をゼロにしたい、しかも手元にいなくても。claude-command-guard（iPhoneから許可/拒否）、tmux-monitor（SAFEは無人承認）、autopilot-template（bypassPermissionsで月次自走）。方向は一貫して「危険なものだけ人間に上げ、残りは通す」。
3. バックグラウンドのサイレント失敗を検知したい。watchdog3種、health-check、agent-opsのauto-heal/trust-gate、mac-miniのsilent-failures.md。「クラッシュしてない≠成功」という規律がそのままツールになっている。
4. 喋ったこと・会議を構造化して自動配布したい。voicewriter、meeting-sync、discord-meeting-bot。終着点がいずれも team-docs / Slack という他人が読む場所で、記録より配布が目的。
5. 機械作業をLLMから取り上げ決定論に寄せたい。cli-toolsの`--json`/`--self-test`規約、gen/bgmのCLI化。LLMは「呼ぶ・読む・判断する」だけにする方針。

### 3. MulmoTerminal と重複・統合できそうなもの

最大の重複は claudecode-notify。両者とも「複数Claudeセッションの状態を色で示し、待ちを教え、iPhoneから見る」で、claudecode-notify 側にも Webダッシュボード（port 19460、SSE + PWA + Bearerトークン）まである。決定的な違いは情報源で、claudecode-notify は Claude Code のフック（SessionStart/Stop/Notification）が書く sessions.json を観測するだけ、MulmoTerminal は PTY を所有している。統合するなら「MulmoTerminal がフックイベント取り込み口を持ち、VS Code や Obsidian で動く非MulmoTerminalセッションも同じグリッドに並べる」が筋。逆に Status ペインは strip と完全に同じ役割なので、MulmoTerminal 内で完結させれば claudecode-notify 側の機能を減らせる。

tmux-monitor と claude-command-guard は MulmoTerminal に吸収するのが正しい形。tmux-monitor は2分ごとにペインを画面スクレイプして承認待ちを推測しているが、MulmoTerminal は PTY を持つのでプロンプトを推測でなく確実に検知できる。承認ポリシー（SAFE自動/UNSAFEは人間）をセッション単位設定として持たせ、モバイル通知に承認/拒否ボタンを足せば claude-command-guard の iPhone 承認まで一本化できる。現状この3つが独立に port 19460 と tmux を触っているのは、memory の port-34567 横取り事故と同種のリスク源でもある。

次に効きそうなのが voicewriter。モバイルからペインに指示を出すときキーボードが最大のボトルネックで、voicewriter は Whisper→LLM整形の完成したローカルパイプラインを持つため、MulmoTerminal の入力欄に通すのは新規開発でなく接続作業に近い。（注: 統合レビューで棄却 — MulmoTerminal 側に既にオンデバイス Whisper があり要望も未表明のため）

fleet-watch / health-check / watchdog群は「グリッドの1タイル」候補。常駐AIが死ぬ原因は「監視面を誰も見なくなること」と fleet-watch 自身が書いており、MulmoTerminal は一日中見ている唯一の画面なのでそこにフリート健全性タイルを置くのが構造的な解。cli-tools が全CLIに `--json` を義務づけているのでデータ源は揃っている。（注: メトリクス表示は非目標のため、inbox カード化のみ採用）

重複でなく競合として注意すべきは buzz。「人間とエージェントが同じ部屋で協働する」ビジョンは MulmoTerminal のグリッドと同じ問題を別レイヤー（会話UI）で解こうとしており、どちらに寄せるかは機能でなく方針の判断。

主な参照先: claudecode-notify/README.md、tmux-monitor/monitor.sh、claude-command-guard/guard.py、fleet-watch/CLAUDE.md、cli-tools/README.md、voicewriter/README.md（いずれも /Users/kanjinoguchi/Projects/tools/ 配下）

## 付録B: 既存機能インベントリと backlog（audit-mulmo）

### 最重要の前提: この repo は 2 層構造

`main` は upstream `receptron/mulmoterminal` 追従用のクリーンな状態、`kanji` ブランチに野口さん専用の「iTerm2 完全代替」改修が載っている。README.md と docs/ChangeLog.md は upstream の機能しか書いていないので、それだけを台帳にすると fork 側の R1〜R14 実装ぶんを新提案として重複起票する。

fork 側の正本:
- `README-KANJI.md`（fork の運用・カスタマイズ概要、2026-07-31 まで）
- `plans/kanji-it2-parity/05-requirements.md`（R1〜R20 の要求一覧・P0/P1/P2 区分・非目標）

コード側の網羅確認: fork 独自機能に `Fork-local (iTerm2 mode, R<n>)` マーカーコメントが全て付いており、`grep -rn "Fork-local" server/ src/ common/` で 80 箇所ほど列挙できる。

### 1. 機能インベントリ（[fork] 印は kanji ブランチ独自）

**セッション管理**
- Claude Code / Codex の 2 エージェントを PTY で駆動（`AgentAdapter` 抽象、`CLAUDE_BIN` / `CODEX_BIN` 差し替え可）
- tmux によるセッション永続化（サーバー再起動・クラッシュを跨いで生存、専用ソケット `-L mulmoterminal`）
- git worktree 分離起動（`agent/<slug>` ブランチ）+ diff パネル + commit / push / PR 作成
- OpenRouter 等 Anthropic 互換プロバイダ経由の他モデル起動（約27モデル、セル単位で上書き）
- `claude-ollama` — ローカル Ollama モデルで Claude Code を動かす同梱 CLI
- Docker サンドボックス実行（実験的・単一ビューのみ・macOS 限定）
- コスト / トークン / context% の計測（`/api/cost`、セッション・今日・今月）
- 定期実行スケジューラと dev worklog バッチ（全作業ディレクトリ横断で週次 wiki ページ生成）
- [fork R12] Fork ボタン — `--resume --fork-session` で会話を分岐した新カラムを 1 クリック起動
- [fork R2] pane ごとの mission 層（`PUT /api/session/:id/mission`、初回プロンプトから自動シード）

**グリッド・タイル表示**
- 多並列グリッド + ズーム + フィルムストリップ + cockpit roster（1セッション1行のテキスト要約リスト）
- 状態色分けの枠線とツールバー集計、注意チャイム
- [fork] iTerm2 モード — 縦カラム専用レイアウト（段積み廃止・1ページ最大10列）、自動ズーム廃止
- [fork R1] ワークスペース — ページの命名・ピン留め、`?ws=名前` で別ウィンドウ別ワークスペース
- [fork R6/R7] 状態語6値（承認待ち/質問/実行中/完了・未読/切断/シェル）+ 放置時間で dot が黄→赤
- [fork R14] 2行ステータスストリップ（行1=識別、行2=いま何をしているか）+ ホバーカード（全文表示・状態語の平易な説明・状態の継続時間）
- [fork R14] TodoWrite の in_progress を LLM なしでミラーする live task 行
- [fork R10] ペインのカスタム名、ヘッダードラッグで列並び替え、打鍵中のオートソート保留
- [fork] 常駐プリセットチップ（1クリックで新カラム+claude 自動起動、D&D 並び替え、削除 Undo 5秒、末尾の「＋」で OS フォルダダイアログ）
- [fork R3] 既定キーマップ（Alt+J/L=列移動, Alt+U/H=ページ, Alt+A=要対応へ, Alt+Z/N/W）
- [fork R13] スクロールバック 10,000 行 + 幅変更時の再折返し
- [fork] Claude デスクトップアプリ準拠テーマ（温チャコール #262624）、行間1.35、ホスト配信 Web フォント（`GET /api/fonts`、ブラウザ再起動不要）

**ペイン間連携**
- 他セルの最終ターンを取り込む「Bring another cell's turn here」（ログ由来・貼り付けのみで自動送信しない）
- [fork R8] エージェント自走 API — `POST /api/workspace/column`（新カラムを開く）/ `POST /api/broadcast`（全セッション一斉送信）
- [fork] claude-peers 連携（`CLAUDE_BIN` wrapper で dev-channel を復元）+ 確認プロンプトの自動通過
- [fork R11] 応答/プロンプトのワンクリックコピー + 選択即コピー（copyOnSelect）

**通知・モバイル**
- Web Push（`pushKinds` で finished / waiting を選択）、RemoteHost 経由のスマホ連携（画面閲覧・yes/no/continue 応答・スマホからのセッション起動・クイック返信チップ）
- ツールバーの通知ベル（未読バッジ・クリックでセッションへジャンプ）、カスタム通知音
- [fork R14] ブラウザが裏でも気づく OS 通知 + favicon バッジ + title (N) + 音の作り分け、5分クールダウン、可視+フォーカス時は抑制、通知クリックで該当セッションへ

**ファイル・添付**
- Files ビュー(CodeMirror 編集・Markdown プレビュー・パス封じ込め)
- ターミナル出力のファイルパスをクリック → 拡張子でルーティング（md=レンダリング / json=整形 / csv=表 / ソース46種=Files ビュー / その他=生バイト）
- ファイルドロップ・添付ボタンで絶対パス挿入（OS ダイアログ経由）
- [fork R10] Cmd+V 画像貼り付け（`POST /api/paste-image`）
- [fork R14] any-file attach — ドロップとヘッダーボタンが画像以外の全ファイルを受ける（`POST /api/attach-file`、MIME でなくファイル名で判定）

**音声**
- オンデバイス Whisper による音声入力（`POST /api/transcribe`、macOS 限定、口述言語の指定可）

**Collections・plugins**
- GUI パネル（Canvas）— MCP 経由で document / form / chart / image / html / collection / mulmoscript を描画（Shadow DOM 分離）
- Collections ブラウザ（カード・アクション実行でシード付き新セッション起動）、Google カレンダー push
- Wiki ビュー（index / ページ / グラフ / lint）、複式簿記 accounting、ユーザー独自 HTTP MCP サーバーの登録

**その他**
- Run メニュー（`script.json`）、Skill メニュー（`.claude/skills` を project/user 両スコープで発火）
- コマンドセルの ✦ Summarize（`claude -p` でエラー要約）
- 横断 PR/Issue ビュー（`gh` ログイン利用）
- ヘッダー設定（buttons / chips）— 内蔵チップは `dir` `git` `ctx` `usage` `status` `diff` `tools` の7種、ボタンは `shell` / `input` / `open` の3 run 型（open の宛先は url / reveal / files / view / terminal / pr / pickFile）、`when` で表示条件、`${dir}` 等の変数展開。buttons を書くと既定セットは全置換（マージではない）
- グローバル設定 `~/.mulmoterminal/config.json` の項目: cwdPresets / soundFile / prRepos / launchers / quickCommands / userMcpServers / buttons / chips / pushEnabled / pushKinds / notifyKinds[fork] / worklogEnabled / worklogIntervalHours / providers / terminalSubmit / keymap / prWorkdirFooter / cockpitLines / copyOnSelect[fork] / fontFamily
- ディレクトリ別設定 `.mulmoterminal.json`（名前バッジ・8色・テーマ・fontSize・fontFamily・sound・skills 絞り込み・addDirs）
- 同梱スキル `/mulmoterminal-config`（対話設定）と `/mulmoterminal-bug-report`（バグ報告前ゲート）
- ページズーム抑止、[fork] マウス側面ボタン（戻る/進む）の握り潰し

### 2. 直近3ヶ月の追加ハイライト

ChangeLog は 2026-07-02（0.6.0）〜07-27（2.1.1）に集中、それ以前は GitHub Releases のみ。8月以降は upstream リリースがなく、全て fork 側のローカル作業。

- 07月上旬〜中旬（upstream）: worktree/PR 動線、cockpit roster、プロバイダ経由の他モデル、Docker サンドボックス、音声入力
- 07-25〜26（upstream 1.9〜1.12）: Windows 対応の集中修正、ファイルパスの拡張子別ルーティング、設定の原子的書き込み、ループバック bind + 同一オリジンゲート
- 07-26〜27（upstream 2.0〜2.1.1）: ユーザー定義キーマップ、Push の種別選択、絵文字全廃→Material Symbols、起動時の既定ビューをグリッドに、ビュー別ツールバー、terminal font size/family
- 07-31（fork）: iTerm2 モード 4 ラウンド — 縦カラム専用化、自動ズーム廃止、常駐プリセットストリップ、ペイン常時ステータス行、Claude アプリ風テーマ、D&D
- 08-01 夜間（fork・Triad で Wave 0〜3 完走）: R1 ワークスペース / R2 mission / R3 既定キーマップ / R6+R7 状態語6値+鮮度 / R8 自走API / R10 積み残し一掃 / R11 コピー体験 / R12 Fork ボタン / R13 スクロールバック1万行 / R14 OS通知。テスト 4,678→5,027 件 green
- 08-14〜20（fork・operator フィードバック反映）: ペインヘッダー識別・iTerm2 風の 1px クローム、2行ステータスストリップ、ホスト配信 Web フォント、bold 階層の復元、ホバーカード + フォーカスで既読、live task 行、any-file attach、row1 に Fork ボタン、ファイル 4xx を読めるページで返す
- 08-17 の日本語 IME 不具合は Chrome の CDP アタッチ由来と判明（デバッグ経路は撤去済み）

### 3. 構想済みだが未実装のもの

信頼できる未実装リストは 05-requirements.md の P1 残 + P2 全部。ソース中に R15〜R20 の実装痕跡は 1 件もない。

- R9（30ペイン実証） — 27インチ4K実機で30セッション同時運用の負荷検証（メモリ・描画・チャイム誤爆）。Gate 2 で実施予定・未着手
- R15（外出時経路の実態確認） — 外出先で承認待ちに気づけるか。Bark 継続か RemoteHost 復活かの判断材料取りのみ
- R16（1Password / Agent Teams 動線） — spawn するシェルで `op read` 自動ロードと `cct` が壊れないかの検証
- R17（読書モード） — ペインの最後の応答を Markdown レンダリングで読むトグル
- R18（diff レビューの磨き込み） — worktree→diff→PR 動線を「エンジニアでない CEO が押せる」形に
- R19（PR/CI の割り込み通知） — CI 失敗・merged を検知してセッションの会話に流し込む（claudecode-notify の GitHubPRMonitor 移植）
- R20（エスカレーション inbox） — AI 監督役が処理できたものは畳まれ、CEO の判断が要るものだけカードで浮上。05 では「本命ビジョン」と位置づけ、単独の大型フェーズ扱い
- upstream 側: plans/feat-202-docker-sandbox-mcp.md（サンドボックスへの任意 MCP サーバー追加、"in progress"）

### 拡張案を作る際の注意 2 点

1. 明示的な非目標が 4 つ確定（05 §2、変更には CEO 承認が必要）: 横断ダッシュボード（別画面）2026-07-02 却下 / モバイル対応の新規開発 2026-07-27 後回し / コスト・トークン・失敗回数などの監視メトリクス表示 2026-05-19「興味もない」 / ブラウザが原理的に奪えないキー（Cmd+T/W/N/Q）の再現。設計3原則: 縦カラム多並列が主役 / 1カラムあたりの可読行数が最上位評価指標 / 状態は「自分が何をすべきか」の語彙で同じ画面の中に出す。
2. `R14` という記号が「要求 R14=気づける通知」と「8月の operator フィードバック反復ラウンド」の2つの意味で使われている。新しい設計メモは番号を再利用せず新採番にする（→ 本提案は U 系列を採用）。

## 付録C: memory 痛点・願望 30件（audit-memory）

調査範囲: `~/.claude/projects/*/memory/`（883ファイル）、`preference-candidates/2026-07,08.md`、`knowledgebase/orchestrator/`、`docs/orchestrator.md`

最頻出テーマは「15-24ペインの進捗把握と、判断待ちで止まっているペインの発見」。4年分の記録で一貫して「深刻度: 最高」と書かれ続けている唯一の課題。

### A. 多ペイン並列の認知限界・進捗把握（最頻出・深刻度最高）

1. 15-16ペイン同時運用で「各セッションが今何をやっているか」を把握し続ける認知負荷が全プロジェクトの進行速度を制限している（CHALLENGES.md 2026-04-04「人間がボトルネック」深刻度: 最高）
2. tmux のフラットな分割では15ペイン超で「どれが入力待ちか」が瞬時に分からない。人間の認知限界は15列程度で、それを突破する UI に強い関心（CHALLENGES.md 2026-05-09、cmux/dmux 評価）
3. 子ペインが判断待ちで止まっているのを、AI の報告でなく画面を見て自分が先に発見してしまう。「誰がどうやってるのか画面から分からない」（preference-candidates 2026-08.md 08-10）
4. 数日〜1週間放置したペインを再開するとき「目的/現在地/残り/自分でどこを確認するか」の4点を毎回聞き直している（1セッション中に3回発生）（preference-candidates 2026-08.md 08-10）
5. どのワークツリー/ペインがどのファイルを触っているか手動追跡しないと、新規タスクの並列起動可否を判断できない（docs/orchestrator.md）
6. ペインが OS 再起動等で消えると指揮系統ごと失われ、復旧は HANDOVER と JSONL の手動 grep 頼み（knowledgebase/orchestrator/global.md 08-19）
7. Worker を別ウィンドウに spawn すると監視画面外になり進捗が見えなくなる。必ず同一ウィンドウ内 split が必須という運用ルールになっている（feedback_worker_spawn_ceo_visibility_main_window.md）
8. 専用ダッシュボードは何度作っても見に行かなくなる。情報は毎日見る面（ペイン/Slack）へのプッシュでないと届かない（knowledgebase/orchestrator/global.md 07-22、feedback_ship-output-must-land-in-lived-stream.md）

### B. 判断待ち・承認で止まる

9. 承認ダイアログが出た Worker は自分でブロックされるため通知すら出せず、誰かが tmux capture で気づくまで無言で止まる（feedback_approval_proxy_proactive_detection.md）
10. 夜間・外出中は15秒ポーリングの承認代行 monitor を bash で常駐させて凌いでいる（10時間で承認10件以上を消化）＝本来 UI 側の機能であるべき運用回避策（feedback_background_approval_monitor_for_overnight_dev.md）
11. 承認代行が二経路（自動monitor と手動）並走すると同じダイアログに二重入力し、残留文字がプロンプト欄に溜まって次の指示を汚染する（feedback_approval_monitor_vs_manual_race_condition.md）
12. 本番デプロイ・push・外部送信は毎回その場のペインで CEO の明示承認が要り、往復コストになっている（feedback_supervisor_bash_approval_delegation.md、docs/orchestrator.md）
13. 承認待ち（PEND_REVIEW）が CEO 一人のレビュー速度に対して線形に増える。「自律ループ完成＝承認UIが次のボトルネック」（CHALLENGES.md 2026-05-10）
14. 毎朝の改善提案を読んで判断するのが面倒。「いちいち判断させるな、良いなら勝手にやっておいてくれ」（CHALLENGES.md 2026-04-04「承認疲れ」）
15. 判断待ちで手を止めさせるな。質問は HANDOVER 先頭に1行置いて、その間に別タスクを進めろ（「私はペインの表示でなく HANDOVER を見て気づく」）（preference-candidates 2026-08.md 08-10）

### C. 通知が届かない・見えない・ノイズ

16. Slack 通知は「誰が何をするか分からないと、うざいから止めろよとなる」。曖昧な通知は拒絶され、ペイン上のバッジ常設のほうが好まれる（preference-candidates 2026-07.md 07-09 / 2026-08.md 08-10）
17. 通知経路そのものが停止・Critical のまま誰にも気づかれず放置される（headless 実行の失敗がログ1行だけで通知ゼロ、翌日偶然発見）（knowledgebase/failures/global.md、CHALLENGES.md）
18. macOS 通知が集中モードや通知設定に握りつぶされて届かない（27回再通知しても見えていなかった実例。対策で音を鳴らすようにした）（logi-buttons-dead-secure-input.md 2026-08-20追記）

### D. 席を離れる・モバイル

19. 席を離れると全ての作業が止まる（深刻度: 高）。モバイル対応は3方式試して全滅で未解決（CHALLENGES.md 2026-04-04）
20. 公式リモートコントロールも Channels も「大量のペインのうちどのペインに話しかけるのか」が解決できず、マルチペイン環境では機能しない（CHALLENGES.md、feedback_channels-multi-pane.md）
21. iPhone でレビュー・承認する導線が無く、意思決定速度のボトルネックになっている（共有 URL の HTML レビューが提案されたまま保留）（CHALLENGES.md 2026-05-11）

### E. ペイン間の受け渡し・報告の信用

22. 他ペインの「送信済み・完了」報告をそのまま転記したら実際は未送信で、信頼を損ねた。状態語は毎回自分で裏取りが必要（feedback_pane_status_words_verify_before_relay.md）
23. ペイン間通信（claude-peers）が片方向で「Peer not found」になり届かず、確実な連絡はファイル経由に頼るしかない（knowledgebase/orchestrator/global.md 08-06）
24. 進捗が HANDOVER.md / 個別 HANDOVER / playbook に分散し、新しいセッションが古い情報を掴む事故が繰り返し起きる（feedback_progress_single_source.md）
25. 複数ペインが共有 `/tmp` に置いた中間成果物を、別セッションの掃除が消してしまう（feedback_shared-tmp-multipane-cleanup.md）

### F. MulmoTerminal の UI（直接言及・最優先）

26. 最大化（zoom）は絶対に使わない。タイルのまま読むので、既読化も重要ボタンも最大化に紐づけてはいけない（feedback-tile-first-workflow.md、preference-candidates 2026-08.md 08-17/08-22）
27. 表示面積の最大化が最優先。太い枠線・色付きハイライト・拡大演出・情報ゼロのラベル（Terminal / connected）・重複表示（ctx%二重）は即却下される（preference-candidates 2026-07.md 07-31 / 2026-08.md 08-22、HANDOVER-r14-ui-polish）
28. ホバーしないと意味が分からない UI・専門用語の状態語を嫌う。「何が表示されてるかよくわからない」（preference-candidates 2026-08.md 08-10/08-17）
29. 用途を狭く限定した機能設計そのものへの不満（添付が画像限定でマークダウンを渡せなかった →「そもそも全部のファイルを送れるようにしちゃダメなのか」）（preference-candidates 2026-08.md 08-19、HANDOVER-attach-anyfile）
30. PWA 運用で URL バーが無いため、不調時に DevTools や URL 入力を求められても操作できない。診断・復旧はワンクリックに落とし込む必要がある（chrome-cdp-ime-breakage.md、HANDOVER-404page-fork-header）

### 補足

- 実装時の運用地雷3つ: 反映には `npx yarn build` + `launchctl kickstart -k gui/501/com.kanji.mulmoterminal` が必須 / ヘッダーボタンは config の `buttons` がデフォルトを丸ごと置換 / ポート34567 は IPv6 側を横取りされうる
- 音声入力は VoiceWriter 側の課題として記録あり、MulmoTerminal への要望としては出ていない
- セッション検索・コンテキスト消失は一次被害の記録はあるが、ターミナル UI への機能要望としては未表明
- fork の「次フェーズ候補」にエスカレーション inbox が未着手として残っている（HANDOVER-mulmoterminal-{fork,it2parity,company-share}.md）

## 付録D: 過去セッションのユーザー生要望 20件（audit-sessions）

対象: 本プロジェクトの全287 jsonl（実質的な対話は 2026-08-14〜08-22 に集中、最古 2026-07-27）。新しい順。

1. 2026-08-22 — 使い方に合わせた拡張提案が欲しい（今回の依頼の発端）「過去の会話をバーっと監査して、このターミナルをもっとこういうアップデートできそうだよみたいな」
2. 2026-08-22 — フォークボタンの発見性が悪い「これ何をやってくれたんだっけ？フォークのボタンはどこにあるの？」（直後に「うわ、フォーク機能最高」）
3. 2026-08-20 — 展開矢印が不要、フォークボタンに置き換えたい「俺がペインを拡大することは現状ほとんどない」
4. 2026-08-20 — 3点メニューの整理「ターミナルという文言もいらないしコネクテッドもいらない…クリップボード被ってる」
5. 2026-08-20 — 見慣れない画面が突然出てアプリを落とす羽目に「もうめんどくさいんでならないようにしといて」
6. 2026-08-20 — ファイル添付の退行（D&D不可・写真限定）
7. 2026-08-19 — ＋で新規ペインを開くと赤い切断表示で Claude Code が起動しない
8. 2026-08-18 — 画像以外（md/PDF/Word）も全部ペインに投げたい「なんで写真に限定してるんだっけ?」
9. 2026-08-17 — 常時ステータス取得のコスト懸念
10. 2026-08-17 — 「最大化したら既読」トリガーを恒久的に禁止「ほとんどこのタイル上のまま読む」
11. 2026-08-17 — ステータスの更新頻度が遅い「これはローカルLLMを使ってようやくとか」
12. 2026-08-17 — ステータス行が1行しか見えず用を成さない（30点評価）
13. 2026-08-17 — 「完了未読」「質問」の意味がわからない
14. 2026-08-17 — 再起動ボタンが見当たらない
15. 2026-08-17 — PWA化していてURL欄がなく chrome://restart が打てない
16. 2026-08-17 — このターミナルでだけ日本語IME切り替えが効かない（→ Chrome CDP 由来と判明）
17. 2026-08-15 — フォントの太さ・濃さが不満（画面が白く重い）
18. 2026-08-14 — Chrome全体の再起動がつらい「このChromeだけを再起動する方法ってないよね?」
19. 2026-08-14 — ミッション常時表示が読めない／デザインが微妙
20. 2026-08-14 — ヘッダーにディレクトリ名とモデル、入力欄に添付ボタン、クリック誤爆と枠・色の調整

（1〜5 と 10 は本日までに実装済み。6〜8, 14〜20 も個別対応済み。未対応で残る本質は 11=状態鮮度、12/13 の残余=状態語の平易さ、9=コスト安心感）

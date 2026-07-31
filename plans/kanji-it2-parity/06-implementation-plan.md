# 06 — 実装計画 v3（iTerm2 完全代替 / kanji fork）

**生成モデル:** Claude Fable 5 (claude-fable-5)
**作成日:** 2026-07-31 / 読む深さ: 📗 使い捨て（Layer 2 と worker の作業指示書。CEO は読まなくてよい）
**前提:** `05-requirements.md` の R1〜R20。実装の入口はすべて `04-current-state.md` の実測に基づく。

## 体制

Triad。Layer 1（Supervisor）= 本セッション（Fable 5）: 要求の番人・検収・CEO 窓口。Layer 2（Implementation Orchestrator）= 別ペイン: Issue 消化の采配。Layer 3 = worktree ワーカー並列。
リポジトリ: `~/Projects/tools/mulmoterminal`（branch `kanji`、fork `n-kanji/mulmoterminal`）。Issue は fork リポジトリの GitHub Issues で管理。
**検収規律:** worker の self-report は信用しない。Layer 1 が grep / `yarn test` / Playwright 実画面で裏取りしてから close（CLAUDE.md Self-Verify Mandate）。UI 変更は必ず 27" 4K 相当の viewport スクショで確認。
**upstream 配慮:** 汎用性のある変更（keymap 既定値、状態語、通知）は upstream に還元し得る形（英語コメント・No emojis・spec 付き）で書く。kanji 専用（mission 層の CLAUDE.md 連携等）は分離を保つ。

## Wave 構成（依存順）

### Wave 0 — 事故防止と実態確認（実装前に必ず。Layer 1 直轄・worker 不要・半日）

| # | 作業 | 入口 | 検証 |
|---|---|---|---|
| W0-1 | monitor.sh 両ソケット走査化（R4 当面策） | `~/Projects/tools/tmux-monitor/monitor.sh`: `tmux list-panes -a` を `for sock in default mulmoterminal` ループに | MulmoTerminal セッションで擬似承認プロンプトを出し、2 分以内に検知されること |
| W0-2 | hook 共存の実測（R5） | `~/.claude/settings.json` を claudecode-notify 起動前後で diff。`HookSetup.swift` と `hook-settings.ts` の登録内容突合 | 両者の hook が共存 or 排他の結論を W0 レポートに記録 |
| W0-3 | R8 の API 有無確認 | `server/routes/` を全走査（04 §8 時点で workspace/add 相当は未発見 → 新設前提で仕様化） | 結論を Issue 本文に反映 |
| W0-4 | R13/R11/R16 の実測 | xterm.js reflow・選択コピー・`op read`・`cct` を実ブラウザで確認 | 各 5 分の手動テスト、結果を Issue 化 or クローズ |

### Wave 1 — P0 コア（並列 3 worker）

| Issue | 要求 | 実装の入口（04 実測） | 規模感 |
|---|---|---|---|
| I-1 ワークスペース（R1） | `GridState` にページ meta（label / pinned）を追加。`parseGridState` の永続化スキーマ拡張（uid 振り直し注意・`gridTabs.ts:235` の不変条件 5 つ遵守）。closeCell の reflow をページ内に閉じる pinned モード。URL クエリ `?ws=` で別ウィンドウ分離（localStorage キーの分割） | `src/components/gridTabs.ts` / `GridView.vue:553-567`（ページ UI） | 大 |
| I-2 mission 層（R2） | サーバーに `PUT/GET /api/session/:id/mission`。ステータス行（`TerminalCell.vue:1141-1175`）に mission を AI サマリーと分けて表示（幅は `@[340px]/pane:` 作法）。`~/.claude/panes/` 互換の書き込み CLI ラッパー（既存 CLAUDE.md ゲートの移行パス） | `server/routes/` + `TerminalCell.vue` | 中 |
| I-3 状態語 6 値 + 鮮度（R6+R7） | `Activity` 型（`server/session/types.ts:8-13`）に `Notification` の種別判定（permission か question か）を追加。`STRIP_LABEL`（TerminalCell.vue:881）を 6 値へ。`updated_at` からの経過で dot 色を鮮度化（`render_freshness()` のロジック移植） | `server/session/activity-hook.ts` / `TerminalCell.vue` | 中 |

### Wave 2 — P0 残り + 操作系（並列 3 worker）

| Issue | 要求 | 実装の入口 | 規模感 |
|---|---|---|---|
| I-4 キーマップ既定値（R3） | `DEFAULT_KEYMAP` を新設し config `{}` 時に適用: `Alt+J/L`=列移動（新アクション `focus-next/prev-column` を `KEYMAP_ACTIONS` に追加・`NEEDS_A_CURRENT_TERMINAL` から除外）、`Alt+A`=next-attention、`Alt+N`=terminal-new-adjacent、`Alt+U/H`=ページ切替（新アクション）。`focusedCellUid` ベース | `common/keymap.ts` / `gridShortcut.ts:34` / `GridView.vue:480` | 中 |
| I-5 エージェント自走 API（R8） | `POST /api/workspace/column`（cwd 指定で新カラム、`addCellWithCwd` をサーバー発火に）+ `POST /api/broadcast`（全セッション or フィルタへ一斉タイプ注入）。認証は既存 API と同格。CLAUDE.md 差し替え文面のドラフトも成果物に含める | `server/routes/` + WS 経由でクライアント `gridTabs` 操作 | 中 |
| I-6 通知（R14） | Notification API（ブラウザ通知）+ 音種別（waiting=Sosumi 系 / finished=Ping 系の作り分け）+ 5 分クールダウン + PWA manifest でバッジ。許可取得 UI は初回クリック時 | `src/composables/useAttentionSound.ts` 周辺に `useOsNotification.ts` 新設 | 中 |

### Wave 3 — P1 仕上げ（並列 2-3 worker）

| Issue | 要求 | 入口 |
|---|---|---|
| I-7 積み残し一掃（R10） | 02 B-8 の 6 件。ドロップゾーン + Cmd+V 画像は `TerminalCell.vue` のファイルドロップ既存実装（独自 MIME 区別済み）を全面化 |
| I-8 コピー体験（R11） | 応答単位コピーボタン（`session-title.ts` が保持する last response を `navigator.clipboard` へ）。W0-4 の実測結果次第で xterm.js 選択の調整 |
| I-9 フォークボタン（R12） | セルメニューに Fork: `claude --resume <id> --fork-session` で `insertCellAfter` |
| I-10 スクロールバック（R13） | xterm.js `scrollback: 10000` + reflow 検証結果の対応 |
| I-11 外出時経路の確認（R15） | RemoteHost API 生存確認 + Bark 継続判断の材料出しのみ（新規開発なし） |

### Wave 4 — P2（120 点。Gate 2 通過後に着手判断）

I-12 読書モード（R17・md レンダリングトグル）/ I-13 diff レビュー磨き込み（R18）/ I-14 PR/CI 割り込み（R19）/ I-15 エスカレーション inbox（R20・単独フェーズとして再計画）

### Gate（各 Wave 後）

- Wave 1-2 完了 → **Gate 1**（半日ドッグフーディング）→ 出た不満を Issue 化して Wave 3 に合流
- Wave 3 完了 → **Gate 2**(終日 30 ペイン・R9 の負荷実証を兼ねる) → 合格で P2 着手判断
- Gate 3（連続 5 営業日）→ 乗り換え宣言 + iTerm2 系 launchd 停止 + CLAUDE.md 改訂（`/revise-claude-md`、01 §9-E の 4 箇所）

## リスクと手当て

1. **grid_v2 スキーマ変更（I-1）が既存 7 セッションの状態を壊す** → parseGridState に後方互換パス + 変更前に localStorage エクスポート
2. **keymap 既定値が端末内アプリの Alt キーと衝突** → 既定値は Alt 系のみ・`keymap` に明示設定があれば一切上書きしない（04 §5.3 の設計方針を維持）
3. **並行運用中の hook 上書き合戦（W0-2）** → 結論が出るまで claudecode-notify を止めない（iTerm2 側の運用を守る方を優先）
4. **upstream rebase との衝突** → 変更は可能な限り新ファイル追加で行い、既存ファイルへの差分を最小化（README-KANJI の追従手順を壊さない）

# 07 — Wave 0 実施結果（事故防止 + 実態確認）

**生成モデル:** Claude Fable 5 (claude-fable-5) / 実施日: 2026-07-31 深夜 / 読む深さ: 📗 使い捨て

| # | 項目 | 結果 |
|---|---|---|
| W0-1 | tmux-monitor 両ソケット走査 | **完了・本番反映済み**。`monitor.sh` を `TMUX_SOCKETS=(default mulmoterminal)` のループに改修 + `--once` 検証モード追加。mulmoterminal ソケット上の擬似承認プロンプトで検知→自動承認を実測確認（log: `[mulmoterminal/mt-approvetest:0.0] pattern → SAFE → 自動承認`）。launchd 再起動済み（起動ログに sockets 表示）。commit `07af158`（tmux-monitor リポジトリ） |
| W0-2 | hook 共存 | **ファイル奪い合いは無い**。MulmoTerminal は `~/.claude/settings.json` を編集せず、spawn 時に `--settings` CLI フラグで per-session 注入（`server/session/hook-settings.ts`）。グローバル設定とマージされ両方のフックが発火する。⚠️ 残リスク: claudecode-notify hook が MulmoTerminal セッションでも発火し、`TMUX_PANE`（%N）はソケット間で衝突し得る → pane-registry の誤引き当ての理論的可能性。実害は 2 週間の並行運用で未観測。**Gate 3（乗り換え完了）時に claudecode-notify の hook 登録を外すことで根治**する。それまでは現状維持 |
| W0-3 | エージェント自走 API の有無 | **不在を確認**（server/routes 全走査: session/hook/dir/repo/tool/mcp/app/ws routes のみ）。I-5 は新設で確定 → Wave 1 worker に発注済み |
| W0-4a | xterm スクロールバック | **明示設定なし = xterm.js デフォルト 1000 行**。iTerm2 は 10,000 行運用だった → I-10 で `scrollback: 10000` 設定が必要（確定） |
| W0-4b | 再 wrap（リフロー） | xterm.js は通常バッファでリサイズ時 reflow する（iTerm2 の「wrap 焼き込み」問題は構造的に解消される見込み）。実画面での確認は Wave 3 検収時に実施 |
| W0-4c | 1Password 自動ロード | **問題なし（パリティ維持）**。`~/.zshrc` の op-load-keys は「対話 && tmux 外 && 未ロード」のみ発火する設計で、iTerm2 の tmux ペインでも元々発火していない。MulmoTerminal セッション（tmux 内）でも同じ挙動。必要時は `op-load-keys` 手動実行（従来通り） |
| W0-4d | cct（Agent Teams, --teammate-mode tmux） | **未実測**。MulmoTerminal セッションは mulmoterminal ソケットの tmux 内なので、Agent Teams の tmux 分割はセル内分割として描画される見込み（劣化はあるが動作はする仮説）。**Gate 1 ドッグフーディング項目に追加** — 実弾で 1 回起動して確認する |

## 派生した確定事項
- I-10（スクロールバック）は「確認」から「実装（scrollback: 10000）」に昇格
- Gate 3 のチェックリストに「claudecode-notify の hook 7 種を settings.json から外す」を追加
- Gate 1 のチェックリストに「cct を MulmoTerminal セル内で 1 回起動」を追加

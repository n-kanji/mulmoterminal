# HANDOVER — iTerm2 完全代替プロジェクト（kanji-it2-parity）

**最終更新:** 2026-08-01 01:15 頃（無人夜間運転中 / Layer 1 = Fable 5 セッション）
**CEO 指示:** 「私寝るので、このまま実装完了まで進めてください」（2026-07-31 夜）。要判断 3 件は全て推奨案で承認扱い

## 正本ドキュメント
`plans/kanji-it2-parity/` の 01〜07。要求は 05、実装計画は 06、Wave 0 結果は 07。

## 現在地
- Wave 0: **完了**（tmux-monitor 両ソケット対応は本番反映済み・tmux-monitor リポ commit 07af158）
- Wave 1: **完走**（I-5 / I-1+10列 / I-2+I-3 すべて kanji にマージ済み、最新 7493b240。lint / typecheck×3 / テスト 4,809 件 green を Layer 1 が再実行確認済み）
  - 状態語は 6 値（approval/question/disconnected/unread/idle=無語/working/shell）。分類は Notification payload の notification_type フィールド（ワーカーが CLI バイナリ解析で特定）
  - mission は PUT /api/session/:id/mission、~/.mulmoterminal/missions.json に永続化。/clear 後の id ずれは session-alias が吸収
  - I-5 実ブラウザ E2E / CLAUDE.md の書き込み先差し替えは Gate 1 / Gate 3 項目
- Wave 2: **実行中** — w2-keymap（I-4 既定キーマップ+新4アクション）/ w2-notify（I-6 ブラウザ通知+バッジ+音種別）/ w2-copy（I-8 応答コピー+copyOnSelect）の 3 worktree ワーカー並列
- Wave 3（I-7/I-9/I-10）: 未着手。Wave 2 マージ後に発注
- Wave 4（P2）: Gate 2 通過まで着手しない（計画通り）

## このセッションが死んだ場合の再開手順
1. `git -C ~/Projects/tools/mulmoterminal log --oneline -5` と `git worktree list` で worker 成果を確認
2. worker のブランチが残っていれば検収から再開: typecheck 3 種 + test + 実画面（http://localhost:34567）
3. 検収規律: worker の self-report を信じない。マージ前に必ず全テスト再実行
4. マージ順: I-2+I-3 → I-5 → I-1（gridTabs の変更が最大の I-1 を最後にし、コンフリクトを I-1 側で解消）
5. マージ後 `npx -y yarn@1.22.22 build` → `launchctl kickstart -k gui/501/com.kanji.mulmoterminal` で本番反映
6. 朝ブリーフ: 05 の Gate 1 手順 + 07 で追加された Gate 1 項目（cct 実弾 / 再 wrap 確認）を含める

## 落とし穴（既知）
- yarn 本体なし → 必ず `npx -y yarn@1.22.22`
- `yarn typecheck` 単独ではスペックの型を見ない → typecheck / typecheck:server / typecheck:test の 3 種必須
- gridTabs.ts:235-262 のズーム不変条件 5 つを壊すとページ計算が全崩壊
- グローバル config はサーバー起動時に一度だけ読む → 反映は launchctl kickstart
- リポジトリは絵文字全面禁止（UI/コメント/コミット）

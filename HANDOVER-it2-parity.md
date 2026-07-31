# HANDOVER — iTerm2 完全代替プロジェクト（kanji-it2-parity）

**最終更新:** 2026-07-31 23:30 頃（無人夜間運転中 / Layer 1 = Fable 5 セッション）
**CEO 指示:** 「私寝るので、このまま実装完了まで進めてください」（2026-07-31 夜）。要判断 3 件は全て推奨案で承認扱い

## 正本ドキュメント
`plans/kanji-it2-parity/` の 01〜07。要求は 05、実装計画は 06、Wave 0 結果は 07。

## 現在地
- Wave 0: **完了**（tmux-monitor 両ソケット対応は本番反映済み・tmux-monitor リポ commit 07af158）
- Wave 1: **I-5 / I-1 マージ済み**（I-5=f1199249、I-1 マージ + 10列対応=b85b6102。各マージ後に typecheck×3 + 全テストを Layer 1 が再実行して green 確認済み）
  - 10 列対応: MAX_CELLS 8→10 / MAX_TERMINALS 64→80 は Layer 1 が直接実装（ワーカー指摘の R1 合格基準ブロッカー）。スペック約 30 件を 10 列の期待値に書き換え
  - w1-mission: I-2+I-3（mission API + 状態語 6 値 + 鮮度色）— **実行中**。ベースが古い kanji なので gridTabs.ts の RANK 周りでコンフリクト予想 → マージ時に I-1 の 6 値対応と統合すること
  - I-5 の実ブラウザ E2E は未実施（本番サーバー稼働中のため）→ Gate 1 の最初の確認項目。疑うべき箇所は plans/kanji-it2-parity/08 §6 に記載
  - I-1 の既知トレードオフ: タブ行は 2 ページ以上でしか出ない（1 ページ目の命名は 2 ページ目ができてから）/ pin は右クリック（ツールチップに記載）
- Wave 2（I-4 keymap / I-6 通知 / I-8 コピー）・Wave 3（I-7/I-9/I-10）: 未着手。Wave 1 マージ後に発注予定
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

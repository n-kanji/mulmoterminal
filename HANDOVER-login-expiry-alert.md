# HANDOVER: login-expiry-alert（2026-10-21 深夜）

## 状態
- 実装・反映・push 済み: 74bac4e0（kanji ブランチ、n-kanji/mulmoterminal）。常駐サーバーは kickstart 済みで新コードが動いている
- 設計ノート: `plans/feat-login-expiry-alert.md`。復旧手順の memory: `oauth-unavailable-all-panes-recovery.md`
- 設定: `~/.mulmoterminal/config.json` の `loginAlert`（warnDays 7、Slack C0AGEFCQSRL、トークンは `.mbp-secrets.env`）。元は `config.json.bak.20261021`
- 確認 API: `GET /api/claude-account/health`（POST = 即スキャン・同一オリジンのみ）。通知の重複防止記録: `~/.mulmoterminal/login-health-notified.json`

## 次にやること
- 10/28 09:55 までに board@ を割り当てたページのペインで `/login` を 1 回（黄チップが出ている）。終わったらメニューの「再確認」で消えることを確認
- 次に赤チップ（ログイン切れ）が出たら: 時刻と、メニューに「同じ鍵が複数」が出ていたかを記録。10/21 の kanji@ 失効は期限の 1 週間前（朝 09:30 までに発生）で原因未特定

## 未確認・保留
- 起動済みペインの Remote Control が、別ペインの /login 後に自動で戻るか（ランチャーは戻ったが機構は不明）
- Slack の日次再通知はローカル深夜 0 時直後の毎時スキャンで出る（PC の前にいる時間帯ではない）。気になれば朝 8 時台に固定する
- セキュリティ: /security-review 未実施（ローカル専用 API・外部送信は Slack のみ・トークンはファイルから読む設計）

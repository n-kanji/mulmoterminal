# アカウント切り替えでペイン表示が乱れる件（2026-08-25 CEO 報告・調査済み）

**生成モデル:** Claude Fable 5 (claude-fable-5)（spaceengine-docs ペインからの外部調査。修正は本リポジトリのペインで行うこと）

## CEO の観測（2026-08-25 夜・初回のアカウント切り替えで発生）
- kanji@ → board@ に MT のツールバーから切り替えた
- 直後、グリッドに「結構前に終わったはずの古いペイン」が表示され、直近使っていたペインが見えなくなった
- CEO は /resume で手動復旧した
- CEO の要望: **「CLI 利用でこれを絶対発生させない方法」**。旧 ClaudeBar は Keychain 差し替えだけでペインに一切触れなかったので、この事象は一度も起きなかった

## 原因（コードとログで裏取り済み）
1. **8/22 実装の fleet restart（コミット 55bbb0ed）がデフォルト ON** — `src/components/ClaudeAccountControl.vue:16` `const restartPanes = ref(true)`。切り替えると全 claude ペインを reap → クライアント再接続 → `claude --resume <id>` でコールドリジューム、という設計
2. **少なくとも1ペインがセッション関連付けを失い `new` で復帰した** — `~/.mulmoterminal/server.log:17649` `[ws] client connected (new b33433d7-...)`（spaceengine-docs のペイン）。resume ではなく新規セッションで上がってきた = 直近の会話が消えたように見える。CEO が /resume で直したのはこれ
3. **detached / 放置ペインも全部再起動して前面化する** — restart-claude-panes.ts は hidden 以外の全 claude ペイン（見ていないページの detached 含む）を reap する設計。tmux 永続化で生き残っていた「終わったはずの古いペイン」群（切り替え時 10 sessions survived）も一斉に復帰し、「古いペインが表示された」体験になった
4. なお切り替え自体（backends/claude-account.ts）は Keychain + oauthAccount ブロックだけを差し替えており、会話履歴・~/.claude.json の他フィールドは無傷。**「ペインがアカウントに紐付いている」わけではない**

## ログ上の疑わしい点（追加調査対象）
- server.log 16112 以降、MT サーバー自体の再起動が切り替え前後に複数回発生（16112 / 16396 / 16788 / 16982）。fleet restart との因果は未確認
- 同じ resume id 群の再接続ウェーブが短時間に何度も走っている（reconnect ループの可能性）
- server.log にタイムスタンプがなく因果の確定が困難 → **ログに時刻を付けるのも改善候補**

## 修正方針（提案・CEO 未承認）
1. **`restartPanes` のデフォルトを OFF に変更**（1行）— OFF なら旧 ClaudeBar と完全に同挙動（Keychain 差し替えのみ・ペイン無傷 = 絶対に発生しない）。リミット到達時に全ペインを移したい時だけ明示的に ON
2. **`new` フォールバックの根治** — 再接続が resume id を運べなかった/解決できなかったケースで黙って新規セッションにしない。原因特定（client 側の ?session 欠落 or resolveClaudeSession の判定）+ 少なくとも警告表示
3. restart 対象を「アクティブページの working ペインのみ」に絞るオプション検討（detached の古いペインまで巻き込まない）
4. server.log にタイムスタンプ追加

## 実施状況（2026-08-25 夜・本リポジトリのペインで対応済み）
- 方針1・2 を実装しコミット 99615adb、build + kickstart で本番反映済み（21:21 再起動・全ペイン resume 復帰を確認）
  - `restartPanes` デフォルト OFF（ClaudeAccountControl.vue）
  - `resumeLossNotice`（server/session/session-resolve.ts・純関数+テスト4件）: 要求 ID を復元できず新 ID を発行する時、server.log に警告 + ペインに赤バナー（旧 ID・新 ID・/resume での復旧手順を明記）
- 会話喪失の因果もログで確定: spaceengine-docs ペインの本会話 b055b10a は当日朝に claude 自体が code=1 で異常終了して関連付けが切れており、切替時の「new」は未プロンプトの空セッション 268e7a05（トランスクリプト無し）の正規フォールバック。silent だったことが問題で、上記バナーで可視化した
- 方針3（restart 対象をアクティブページに絞る）・方針4（server.log タイムスタンプ）は未着手の改善候補として残す

## 検証手順（修正後）
- dev インスタンスで複数ペイン（active + detached + 古い tmux 残留）を用意 → 切り替え(restart ON) → 全ペインが**自分の会話**に戻ること・`new` 復帰が 0 件であることを server.log で確認
- restart OFF 切り替えでペインが一切変化しないこと

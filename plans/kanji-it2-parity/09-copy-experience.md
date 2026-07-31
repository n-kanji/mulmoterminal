# 09 — I-8: 応答単位のコピー体験（R11）

**要求元:** `05-requirements.md` R11「コピー体験の完成 — DOM 選択コピーの実挙動検証 + 応答単位のコピーボタン。pbcopy 運用ルールを不要にする」
**背景:** 02 A-1（半年間の慢性痛。CLAUDE.md に「手で打たせるコマンドは必ず pbcopy でクリップボードへ」という恒久ルールができるほど、iTerm2 のソフトラップ選択でコピーが壊れ続けた）
**生成モデル:** Claude Opus 5 (claude-opus-5)

---

## 1. 結論（先に）

- **応答コピー / プロンプトコピー**: セルの「…」ツールバー行（行 3）に 2 ボタンを新設。押すと**トランスクリプト由来の生テキスト**をクリップボードへ入れ、ボタン表示が短く `Copied` に変わる。トーストは作らない
- **copy-on-select**: 選択ドラッグが確定した時点でクリップボードへ入れる。グローバル設定 `copyOnSelect`（既定 ON）
- **OSC 52 との二重コピー**: 起こらない。トリガーが構造的に交わらないことをコードで確認した（§3）

## 2. なぜ画面バッファでなくトランスクリプトか

コピーの入口は 3 つありえた。実装は 3 番目を選んだ。

| 経路 | 得られるテキスト | 不採用の理由 |
|---|---|---|
| xterm バッファ読み出し（`readBuffer`、既存関数） | 画面に見えているまま | **カラム幅でハードラップされる**。スクロールバックから溢れた分は消えている。スピナー残骸が混ざる。まさに半年壊れていたコピーそのもの |
| ロースターの `lastResponse`（`/api/session/:id`） | 応答の冒頭 | 表示用に切られている。全文コピーには使えない |
| **`/api/transcript/last-turn`（採用）** | エージェント自身のログの生テキスト | 折返しなし・欠落なし・ターン境界は推測でなく記録。既に存在する経路 |

`last-turn` は #550 で「別セッションへ渡す文章」を作るために足された経路で、レスポンスは `{ prompt, reply, text }`。`text` は**エージェントが読む前提の枠付き・字数制限つき**の整形結果なので、人間のコピーには使わない。使うのは生の `prompt` / `reply` で、ここは無加工・無制限。**新しい API は足していない**（同じセッション・同じターンを読むだけなので、増やすと同じものを 2 通りで読む経路ができる）。

実装は `src/composables/useCopyTurn.ts`。`copyLastTurnPart(source, part, deps)` が「取得 → 空判定 → 書き込み」を 1 つの純粋な流れにし、結果を 4 値（`copied` / `empty` / `read-failed` / `clipboard-blocked`）で返す。`empty` を失敗と分けたのは、**まだ 1 ターンも完了していないペインでは空が正常**だからで、`clipboard-blocked` を分けたのは、書けなかったのに `Copied` と出したら操作者が古い内容を貼るからである。

## 3. copy-on-select と OSC 52 の関係（検証結果）

**確認したかったこと**: ブラウザ側の選択コピーと、tmux 越しに来る OSC 52 のクリップボード書き込みが二重にならないか。

**結論: ならない。トリガーが交わらない。**

- OSC 52 の経路は `server/infra/tmux.ts`（`set-clipboard on` + `Ms` 上書き）→ xterm の `ClipboardAddon` → `clipboardProvider.writeText`。これは**ターミナルの中のプログラムが自分で書く**経路
- ブラウザ側の選択は、そのプログラムに**届かない**。`src/composables/terminalMouseInput.ts` の `isReportableClick` は「押して離すまで動いていない」かつ「選択が残っていない」クリックしかアプリに報告しない（#729 のマウストラッキング握り潰しの一部）。つまりドラッグ = 選択はアプリから見えず、アプリが OSC 52 で応答することもない
- 逆向きも同じで、OSC 52 の書き込みが xterm 側の選択を作ることはない

したがって同じクリップボードに書く 2 者は残るが、同時に発火する経路がない。念のため両者は `src/composables/systemClipboard.ts` の `writeSystemClipboard` 1 か所に集約し、失敗（安全でないオリジン・フォーカスなし・権限拒否）を同じ形で扱う。

**選択の折返しについて**: xterm の `getSelection()` はソフトラップを繋いで返す（`isWrapped` を見る）。iTerm2 で壊れていた「画面の折返し位置に改行が入る」現象は、この経路では起きない。

**連射しない工夫**: `onSelectionChange` はドラッグ中に連続発火するので、120ms 落ち着いてから **1 回だけ**書く。書く直前に選択を読み直すので、途中経過ではなく最終的な選択が入る。

## 4. 設定 `copyOnSelect`

- 置き場所: `common/copyOnSelect.ts`（サーバーもブラウザも同じ規則で判定するため。CLAUDE.md の「両側が決めるものは common」）
- 既定 **ON**。`false` を明示したときだけ OFF（`prWorkdirFooter` と同型）。既存の config.json はこのキーを持たないので、**書かなくても効く**のが要件（設定を発見しないと痛みが消えない機能は意味がない）
- サーバー側は `AppConfig` の 1 フィールドとして sanitize / merge / 公開まで通す。ブラウザ側は `src/composables/copyOnSelect.ts` の素のモジュール値（`terminalSubmitMode` と同型 — 描画に使わず、開いている全ターミナルに一斉に効く）

## 5. 置き場所の判断（行 3 に置き、行 2 に置かない）

設計原則 2「1 カラムあたりの可読行数が最上位指標」より、**常時表示の行（行 1 のヘッダ / 行 2 のステータスストリップ）にはボタンを足さない**。コピーは「読んで、要ると思ったとき」の操作なので、`…` で開く行 3（ターミナルヘッダ行、`#header-actions` スロット）が正しい深さ。テストで「タイル状態では出ない・`…` を押すと出る」を固定してある。

成功表示も同じ理由でトーストにしない。30 カラムのうち 1 つの上に浮くパネルは、視線が既に別カラムへ移った後に出ても情報を運ばず、行を食う。**アイコンをその場で短い語に差し替える**（`Copied` / `No reply` / `Read failed` / `Blocked`）方式にした。

## 6. 変更ファイル

| ファイル | 内容 |
|---|---|
| `common/copyOnSelect.ts` (新) | 既定値とサニタイザ（両側共有） |
| `server/config/app-config.ts` | `copyOnSelect` を AppConfig に追加（sanitize / empty / merge / public） |
| `src/composables/copyOnSelect.ts` (新) | ブラウザ側の現在値 |
| `src/composables/systemClipboard.ts` (新) | クリップボード書き込みの単一窓口 |
| `src/composables/useCopyTurn.ts` (新) | last-turn 取得 → 結果 4 値 → ボタン表示語 |
| `src/composables/useTerminalConnections.ts` | copy-on-select の配線、OSC 52 プロバイダを共通の書き込みへ |
| `src/composables/useAppConfig.ts` | `/api/config` から `copyOnSelect` を反映 |
| `src/components/TerminalCell.vue` | 行 3 に Copy reply / Copy prompt |

テスト: `test/common/copyOnSelect.spec.ts` / `test/src/composables/copyOnSelect.spec.ts` / `test/src/composables/useCopyTurn.spec.ts` / `test/src/composables/useTerminalConnections.spec.ts`（copy-on-select の配線）/ `test/src/components/TerminalCell.spec.ts`（ボタン 4 件）/ `test/server/config/app-config.spec.ts`（設定の往復・merge）。

## 7. 積み残し・未検証

- **実機での copy-on-select 確認は未実施**（このワーカーはブラウザを起動していない）。ユニットでは配線と設定の既定を固定したが、「実際に 4K グリッドでドラッグしてクリップボードに入る」は Gate 1 のドッグフーディングで見る項目
- **HTTPS でないリモート接続（LAN の IP 直打ち）ではクリップボード API が存在しない**。その場合コピーは静かに失敗せず `Blocked` と出る。localhost 運用では起きない
- R11 に含まれる「pbcopy 運用ルールを不要にする」の判定は、CEO が 1 日回して初めて言える。ここで宣言はしない
- 本 Issue の範囲外だが、`test/src/components/gridTabs.spec.ts` が I-2/I-3 の状態語 6 値化に追随できておらず、`typecheck:test` と `test` が赤のままだった（`"blocked"` / `{blocked, done, working, idle}` が旧語彙）。green を回復するため新語彙へ 3 か所直した（`approval` と 7 値の counts）。ロジックは変えていない

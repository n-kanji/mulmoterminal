# 07 — 設計ノート: mission 層 (R2) と 状態語 6 値 + 鮮度 (R6/R7)

**生成モデル:** Claude Opus 5 (claude-opus-5[1m])
**作成日:** 2026-08-01 / 読む深さ: 📗 使い捨て（実装の設計判断メモ。CEO が読む必要があるのは §1 の curl だけ）
**対象要求:** `05-requirements.md` の R2（mission 層）/ R6（状態語 6 値）/ R7（鮮度）
**設計原則との関係:** 原則 2（1 カラムの可読行数が最上位指標）を守るため、**行を増やさずに** 情報を足す形にした。ステータス行は 22px のまま。

---

## 1. mission を書く（CEO・および Claude セッション自身）

Claude セッションの中から、そのペインの mission を 1 コマンドで書く:

```bash
curl -s -X PUT "http://127.0.0.1:34567/api/session/$CLAUDE_CODE_SESSION_ID/mission" \
  -H 'content-type: application/json' \
  -d '{"mission":"iTerm2 完全代替 P0 を実装する"}'
```

消す（空文字か、フィールドごと省略）:

```bash
curl -s -X PUT "http://127.0.0.1:34567/api/session/$CLAUDE_CODE_SESSION_ID/mission" \
  -H 'content-type: application/json' -d '{"mission":""}'
```

- `$CLAUDE_CODE_SESSION_ID` は Claude Code が子プロセスに渡す**自分自身の**セッション id。エージェントが知りうる唯一の id なので、これをそのまま使えるようにした
- `/clear` `/compact` の後、Claude は自分の id を振り直す。サーバーは**全フック**が運ぶ `x-mt-session`（= MulmoTerminal 側の id）と body の `session_id` の対を記録しており（`server/session/session-alias.ts`）、mission ルートはそれを引いて正しいペインに書き込む。これがないと `/clear` 後の書き込みは「200 が返るのに画面が変わらない」サイレント no-op になる
- 保存先は `~/.mulmoterminal/missions.json`。サーバー再起動をまたいで残る（実機で確認済み）
- CLAUDE.md の「ペインステータスの更新」ゲート（`~/.claude/panes/$CC_PAIR_ID.json` への書き込み）の**差し替え先がここ**。差し替えは CEO 側の CLAUDE.md 編集なので、本 PR には含めていない

### なぜ hook でなく URL パラメータか
hook は「Claude が何かした瞬間」にしか発火しない。mission は**エージェントが書きたいときに書く**もので、イベントに紐づかない。フックのペイロードに新フィールドを足すと Claude Code 側の仕様に依存する一方、PUT なら依存はゼロ。同一オリジンゲート（`same-origin-guard.ts`）は PUT を対象にするが、ローカル curl は Origin を送らない非ブラウザ呼び出しとして既に許可されている。

---

## 2. mission をどこに出したか

ステータス行（TerminalCell.vue の行 2）の中、**状態語の直後・AI サマリーの直前**に `[mission]` の形で。

| 位置 | 要素 | 幅の扱い |
|---|---|---|
| 1 | ● dot | 固定 |
| 2 | 状態語（6 値。idle は**無表示**） | 固定 |
| 3 | **`[mission]`（新）** | `max-w-[34%]`・`@[340px]/pane:` 未満では非表示 |
| 4 | AI サマリー | flex-auto（唯一の可変要素） |
| 5 | 最後のプロンプト | `@[340px]/pane:` 以上のときだけ |
| 6 | モデル名 | 固定 |

- **行は増やしていない**。mission はサマリーから幅を borrow する。設計原則 2 に対する毀損はゼロ行
- 狭いカラムでは prompt と同じく隠れる（既存の作法をそのまま踏襲）
- 色は `text-dim`（サマリーより暗い）。「先に読むが、今起きていることを食わない」

---

## 3. 状態語 6 値

`common/paneState.ts` に語彙と判定を 1 箇所化した。サーバーが分類し（Notification の 2 分岐はサーバーしか判断できない）、クライアントが描画・枠色・ソートに使うため、CLAUDE.md の common/ 規約どおり共有型。

| 状態 | 語 | 条件 |
|---|---|---|
| `approval` | 承認待ち | `waiting` かつ `Notification` かつ `waitKind=approval` |
| `question` | 質問 | `waiting` かつ `Notification` かつそれ以外（**判別不能もここ**） |
| `working` | 実行中 | `working` |
| `unread` | 完了・未読 | `waiting` かつ Notification 以外（= Stop） |
| `disconnected` | 切断 | セル自身の WS が落ちている / ランチャーのプロセスが exit した |
| `shell` | シェル | ランチャーセル（エージェントを走らせていない） |

### 🔴 「待機」は語を持たない（6 値の数え方）
旧 4 値の「待機」は**廃止**した。R6 の 6 値に含まれておらず、かつ 02 B-8 P0-2 の指摘（「全ペインが同じ値を出す欄は情報を運んでいない」）そのものだったため。型としては `idle` が残る（RANK・集計・fallback に floor 値が要る）が、**語は空文字**で、ステータス行では要素ごと消える。空いた幅はサマリーが取る。

つまり「6 値」= 語を持つ状態が 6 つ、`idle` は「言うことがない」という 7 番目の語ではなく**語の不在**。

### Notification の 2 分岐を何で判別したか（実証）
Claude Code 本体（`/opt/homebrew/lib/node_modules/@anthropic-ai/claude-code/bin/claude.exe`、v2.1.220）を `strings` で解析し、Notification フックのペイロード構築箇所を特定した:

```
hook_event_name:"Notification", message:r, title:n, notification_type:o
```

**`notification_type` が payload の第一級フィールドとして存在する。** 実際に流れる値と発生源:

| notification_type | 発生源（バイナリ内の呼び出し） | 分類 |
|---|---|---|
| `permission_prompt` | 権限ダイアログ全般（ツール許可 / plan mode / plan 承認 / ブラウザ使用 / Session paused） | **承認待ち** |
| `worker_permission_prompt` | `<agent> needs permission for <tool>` / `<worker> needs network access to <host>` | **承認待ち** |
| `idle_prompt` | `Claude is waiting for your input` | 質問 |
| `elicitation_dialog` / `elicitation_url_dialog` | `Claude Code needs your input`（MCP の elicitation） | 質問 |
| `elicitation_response` / `elicitation_complete` | MCP サーバーの応答通知 | 質問 |
| 未知の値 | — | 質問（安全側） |

message 文字列はフォールバックにしか使っていない（`notification_type` を送らない旧バージョン対策）。判定語は permission 系だけを拾う 6 パターンで、`Claude Code needs your input`（elicitation）を "needs" で誤って承認待ちに引き込まないようにしてある。

**なぜ質問に倒すか:** 「質問」は「見に行け」としか言わない。「承認待ち」は画面に yes/no ボタンがあると約束する。誤るならコストが小さい側に倒す。

### 既存バグの同時修正（意図的なスコープ拡張）
`nextActivity` はフラグが動かないと null を返す設計だった。その結果、**すでに `waiting=true`（Stop 由来 = 未読）のセッションが権限プロンプトに当たっても表示が「完了・未読」のまま固まる**。R6 の中核（承認待ちが見えること）が成立しないため、「waiting が true のまま・かつ event か waitKind が実際に変わったときだけ」更新する例外を足した。working 側の再表明（PreToolUse/PostToolUse が毎回違う event 名で飛ぶ）は従来どおり no-op のままなので、ソケットへの flood は起きない。

### RANK（auto ソート）
```
approval 0 / question 0 / disconnected 1 / unread 2 / idle 3 / working 4 / shell 5 / 空ランチセル 6
```
- 承認待ちと質問は**同格**（どちらが急ぐかはペイン次第で、種類では決まらない）。安定ソートなので CEO の並べた順が保たれる
- 切断がその次（要求どおり）。答えられないペインより、まず生き返らせる必要がある
- working が idle より下なのは従来どおり（見る必要がないから）。shell はさらに下（誰も呼んでいない）

### 「切断」と「シェル」はセルが勝つ
`resolveCellStatus` は従来「セッションの状態 > セルの自己申告」だったが、この 2 つだけ逆にした。サーバーの行はエージェントのターンを記述するもので、**このブラウザの WS が落ちたことも、ペインがただのシェルであることも知らない**。ソケットが死んだ瞬間に "working" のまま固まると、auto ソートで idle の下に埋まる。

---

## 4. 鮮度（R7）

サーバーが `lastActivityAt`（epoch ms）を `sessions` チャネルと `/api/session/:id` と `/api/activity` に載せる。中身は既存の `Activity.at`（最終状態変化時刻）で、新しい計測は増やしていない。

クライアント（`src/components/paneFreshness.ts`）が ● dot の色を変える:

| 経過 | dot |
|---|---|
| < 5 分 | 状態色のまま |
| 5〜30 分 | `var(--warn)`（黄） |
| > 30 分 | `var(--err)`（赤） |

- **`working` には適用しない**。長いビルドを赤く塗るのは嘘。動いているものは stale ではない（要求どおり）
- `idle` にも適用する。1 時間触られていない idle ペインは「閉じる候補」で、まさに炙り出したいもの
- `lastActivityAt` が null（一度も報告なし）／未来（時計のズレ）は **fresh** 扱い。「年齢不明」は放置の証拠ではない
- 1 分ごとの `setInterval` で再評価する。これがないと「最後に push が来たときの色」で固まり、狙ったペインだけ色が変わらない
- `at` は `activity-state.json` にも永続化した。`--watch` リロードのたびに全ペインが「たった今」に戻ると、朝から放置のペインが緑に見える

---

## 5. 変更ファイル

**common/**
- `common/paneState.ts`（新）— 語彙 6 値 + `paneStateOf` 判定 + `WaitKind`

**server/**
- `server/session/activity-hook.ts` — `notificationWaitKind` / `waitKindFor`（分類ロジック本体）
- `server/session/types.ts` — `Activity.waitKind`
- `server/session/activity-transition.ts` — `nextActivity` の kind 伝播 + 既存バグの escalation 例外 / `SessionRow` に `waitKind` `lastActivityAt` `mission`
- `server/session/activity-flag.ts` — `flagEffect` に kind
- `server/session/activity-state.ts` — `waitKind` `at` を永続化
- `server/session/registry.ts` — 復元時に `at` を保つ
- `server/session/lifecycle.ts` — `setWaiting` に kind / row に mission / reap で alias 掃除
- `server/session/mission-store.ts`（新）— mission の正規化・永続化・prune
- `server/session/session-alias.ts`（新）— `/clear` 後の id 対応表
- `server/session/session-detail-view.ts` — 3 フィールド追加
- `server/session/session-activity-deps.ts` — `setWaiting` の型
- `server/routes/hook-routes.ts` — `notification_type` を読む / alias 記録
- `server/routes/session-routes.ts` — `PUT /api/session/:id/mission` / `/api/activity` の拡張
- `server/routes/app-routes.ts` — `publishActivity` を session routes に渡す

**src/**
- `src/components/paneFreshness.ts`（新）— 3 段階の鮮度
- `src/components/gridTabs.ts` — `CellStatus` = `PaneState` / RANK / ATTENTION_ORDER / countByStatus / gridStatusSummary / resolveCellStatus
- `src/components/TerminalCell.vue` — 6 値の色・語・mission 表示・鮮度 dot・切断検出
- `src/components/LauncherCell.vue` — `shell` / `disconnected` を報告
- `src/components/CockpitHeader.vue` — ロースターも同じ 6 語に
- `src/components/GridView.vue` — waitKind を通す / presetAlerts は approval+question
- `src/components/AppToolbar.vue` — 集計バッジを 6 値対応
- `src/components/cellActivity.ts` / `src/composables/sessionActivity.ts` / `src/composables/useGridActivity.ts` — wire 拡張

---

## 6. 未了・懸念

- **切断の検出はクライアント側のみ。** サーバーは PTY が消えたとき `{event:"closed"}` を publish し、クライアントはそれを受けて自セルの WS 状態に落ちる。「サーバーは生きているがブラウザから見えていない」ケースは拾えるが、逆（ブラウザは繋がっているがサーバー側で PTY が死んだ）は closed push 経由の間接検出になる
- **鮮度の刻みは 1 分。** 5 分ちょうどの境界で最大 1 分遅れて色が変わる。dot の色に 1 分の精度は要らないという判断
- **mission の入力 UI はない。** curl（= エージェント自身）専用。CEO が手で書きたい場合は現状ターミナルから curl する。UI が要るなら別 Issue
- **CLAUDE.md 側の差し替えは未実施。** 応答前ゲートの書き込み先を `~/.claude/panes/*.json` からこの API に変えるのは CEO 環境の設定変更なので、本 PR の外
- **R7 の「放置ペインが浮く」は色だけ。** stale を auto ソートで浮かせるところまではやっていない（要求は色の変化まで）

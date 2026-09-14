# ページを別ウィンドウに切り離す（CEO 要望 2026-09-14）— v2 実装設計

> Chrome のタブのように、2枚目を独立ウィンドウとして取り出して**1枚目と同時に見たい**。
> 不要になったら1枚目にくっつけて元に戻す。セッション（claude プロセス）は切り離し・再結合を通じて生き続ける。

v1（着手前のスケッチ）はこのファイルの git 履歴。以下が着手用に詰めた版。

## 土台

`?ws=<name>`（`gridTabs.ts` の `workspaceFromSearch` / `stateKeyFor`）が既に
「同じサーバー・同じ生きたセッション、保存されるグリッドだけ別」を提供している。
足りないのは**ページ単位の引っ越し**（切り離し・再結合・孤児の回収）だけ。

セッションが生き残る理由: PTY はサーバー側の tmux で、WebSocket が閉じても 30 秒の猶予
（`server/session/lifecycle.ts` の `REAP_GRACE_MS`）がある。別ウィンドウが同じ session id に
つなぐと**後勝ち**で前のソケットが `superseded` で切られる（`messageEffect`）。
だから切り離しは「元のグリッドから取り除く」が必須で、取り除く側が先・つなぐ側が後という順序は
守らなくてよい（後勝ちが常に新しいウィンドウを勝たせる）。

## 用語

- **親** = 切り離し元のウィンドウ（`grid_v2` または `grid_v2:<ws>`）
- **子** = 切り離し先のウィンドウ（`grid_v2:<新ws>`、`origin` に親のキーを持つ）
- **ページ荷物 (PagePayload)** = `{ meta: { label?, account? }, cells: Cell[], separators?: [...] }`

## データの持ち方（localStorage）

| キー | 持ち主 | 中身 |
|---|---|---|
| `grid_v2` / `grid_v2:<ws>` | 各ウィンドウ | 既存の GridState。**`origin?: string` を1つ追加**（子だけが持つ、親のキー） |
| `<親キー>::detached` | 親 | 切り離し中ページの台帳 `[{ ws, label, at }]` |
| `<親キー>::home:<ws>` | 子が書く → 親が読んで消す | 帰宅便 `{ ws, pages: PagePayload[], at }` |

- `::` 区切りは `grid_v2:<ws>`（ワークスペース名は `WS_NAME_RE` = 英数 + `_-`、32文字）と衝突しない。
- `origin` は parse 時に `^grid_v2(:<WS_NAME_RE>)?$` で再検証する（blob は手編集可能という既存の前提）。
- 台帳は親が持つ。`grid_v2:*` を舐めて拾うと、CEO が手で作った `?ws=foo` まで飲み込んでしまう。

## 3つの操作

### 1. 切り離し（親の「別ウィンドウで開く」ボタン）

1. `detachPage(state, page)` が純粋に `{ parent, payload, uids }` を返す
2. 子の state を組み、`grid_v2:<新ws>` に書く（`origin` = 親のキー）
3. 台帳 `<親キー>::detached` に `{ ws, label, at }` を追加
4. 親の state をページを抜いたものに差し替える
5. `window.open("/terminals?ws=<新ws>", "<新ws>")`（名前付きターゲット = 同じページを二重に開かない）
6. **null が返ったら（ポップアップブロック）全部ロールバック**して「ブラウザにブロックされました」と出す
7. 開けたら 5 秒後に親側の `conn.release("cell-<uid>")`（xterm 破棄）。`terminate` は絶対に呼ばない
   （PTY を殺す）。5 秒待つのは、子がつなぐ前にソケットを閉じると 30 秒の回収猶予が走り出すため

**ws 名**: ページ名が ASCII なら sanitize して使い、日本語等なら `page<N>`。既存キーと衝突したら `-2`, `-3`。

**auto ソート中は切り離せない**（ボタンを disabled、理由をツールチップに出す）。
auto では並びがページ境界を跨ぐ（`orderGrid` はグリッド全体を並べ替える）ので、
「画面に見えている2枚目」と `pageSlice(state.cells, 1)` が一致しない。黙って別のセルを運ぶより拒否する。

### 2. 再結合（子の「元のウィンドウに戻す」ボタン）

1. 子が `pagesPayload(state)` を作り、`<親キー>::home:<ws>` に書く
2. 子は**自分のキーを消さない**（親が取り込んでから消す。取り込み失敗でページが消えるのを防ぐ）
3. 子は**閉じずに待つ**（persist は止める）。親は取り込んだときに**子のキーを消す**ので、それが応答になる。
   子は自分のキーが消えた `storage` イベントで初めて `suppressNextUnloadGuard()` → `window.close()`
   - 🔴 「頼んだ時点で閉じる」は不可。親が閉じている／別画面／満杯だと誰も受け取らず、
     ソケットだけ落ちてサーバーの回収タイマー（idle 30秒）が走り出す
   - 4秒応答が無ければ諦めて元の状態に戻す（ページもセッションもそのまま・書き置きは残す）。
     親は次にグリッドを開いたときに起動時スキャンで拾う
4. 親は `storage` イベント（同一オリジンの他ウィンドウにだけ飛ぶ＝自分の書き込みは届かない仕様）で気づき、
   **子の保存済みグリッド**（書き置きはフォールバック）を `reattachPages` で取り込む
   → 帰宅便・子のキー・台帳エントリを消す
5. 親が閉じていた場合は次回起動時のスキャンで同じ経路を通る（孤児の回収と同じ口）

### 3. 呼び戻し（親のゴーストタブをクリック）

親のタブ行に、切り離し中のページを**破線のゴーストタブ**として出す。クリックで:
`grid_v2:<ws>` を直接読む → `reattachPages` → 子のキー・台帳・帰宅便を消す。
子のウィンドウが開いていれば、自分のキーが消えた `storage` イベントで「戻しました」表示にして自分を閉じる。

## 純粋関数（新ファイル `src/components/gridDetach.ts`）

`gridBlocks.ts`（separators / parking）と同じ立ち位置。`gridTabs.ts` は既に 1229 行なので、
同じハウスルール（`state => state`、no-op は同一オブジェクトを返す、セッションに触らない）で兄弟モジュールにする。
`gridTabs.ts` 側の変更は `GridState.origin` の型と parse だけ。

- `canDetachPage(state, page)` — 2ページ以上 / 範囲内 / 走っているセルが1つ以上 / 自分が子でない /
  そのページに**占有しているのに session id が無い列**がない（実行中の command、起動直後の launcher、
  fork 待ちの列。運べないうえ、黙って捨てると両方の窓から消える）
- `detachPage(state, page)` → `{ parent, payload, uids } | null`
- `pagesPayload(state)` → `PagePayload[]`（中身のあるページだけ）
- `reattachPage(state, payload)` → `GridState | null`、`reattachPages(state, payloads)` → `{ state, rejected }`
- `freeWorkspaceName(base, taken)` / `sanitizeWorkspaceName`
- キー・台帳・帰宅便の組み立てと parse（`detachedKey`, `homeKey`, `isHomeKey`, `parseRegistry`, `parseHandoff`）

### 付随物の扱い（運ぶ / 落とす）

| もの | 扱い |
|---|---|
| `session` / `cwd` / `name` / `width` / `agent` / `launcher` / `parkNote` | 運ぶ（セルごと） |
| **`account`（PageMeta と Cell の両方）** | 運ぶ。落とすと別ウィンドウのペインが既定アカウントで起動する |
| `label` | 運ぶ |
| `pinned` | 運ばない。1ページに境界は要らない。再結合時に必要なら merge 側が張る |
| separators | そのセルに付いているものだけ運ぶ |
| `parent`（親子リンク） | 両方が同じ荷物に乗るときだけ残す。跨いだリンクは落とす（`closeCell` と同じ規則） |
| parked dock | 運ばない（ワークスペース単位のもの） |
| `expanded`（ズーム） | 運ばない。親側は運ばれた uid がズーム中なら null に戻す |
| 起動フォーム / command セル | 運ばない（session が無いものは元々永続化されない） |

### 二重取り込みの防止

親の「呼び戻し」と子の「戻す」が同時に起きると、同じページを2回 merge して
**1つの session に2つのペイン**ができる。3段で防ぐ:
1. 帰宅便の取り込みは台帳にその ws が残っているときだけ（消えていれば帰宅便を捨てるだけ）
2. 取り込み側は先に子のキーを消してから merge する
3. `reattachPage` は**すでにグリッド（と dock）にいる session id のセルを落とす**

## UI

タブ行（`GridView.vue` の `#tabs` スロット）に足す。右クリックはピン留めで埋まっているのでメニューは作らない。

- 親: `open_in_new` のボタン（アクティブページを切り離す）。`canDetachPage` が false なら disabled + 理由をツールチップ
- 親: ゴーストタブ（破線）= 切り離し中のページ。クリックで呼び戻し
- 子: `call_merge` のボタン「元のウィンドウに戻す」。子では切り離しボタンを出さない（孫は作らない）

アイコンは Material Symbols（このリポジトリは絵文字禁止）。

## テスト（`test/src/components/gridDetach.spec.ts`）

- `canDetachPage`: 1ページだけ / 空ページ / 子ウィンドウ / command セル在中 / 起動中（session 未発行）の列在中 → 拒否
- `detachPage`: 荷物の中身、親からの消滅、**後続ページのラベル・アカウントがずれない**（meta を splice する）、
  ズーム解除、跨いだ親子リンクの切断
- 荷物 → JSON → `parseGridState` の往復（子が実際に通る経路）で account / name / width が生き残る
- `reattachPage`: 末尾に新ページとして付く / 直前ページを封じる / ラベルとアカウントが戻る /
  MAX_PAGES・MAX_TERMINALS で拒否 / 既にいる session を落とす / separators の付け替え / uid 衝突なし
- ws 名: 日本語ラベル → `page2`、衝突 → `-2`、32文字上限
- 台帳・帰宅便の parse: 壊れた JSON・知らない ws → 落とす（グリッドは壊さない）
- 往復: detach → reattach で session の集合が同じ

## レビューで変わった点（2026-09-14 実装後）

- 「戻す」を**受け取り確認待ち**に変更（上の 2-3）。頼んだ時点で閉じるとセッションが回収されうる
- 取り込む中身は**子の保存済みグリッド優先**（書き置きはフォールバック）
- 占有しているが session id が無い列があるページは切り離し拒否
- 再結合前に元の窓の開きっぱなしの起動フォームを捨てる（`gridTabs.dropTrailingLaunch` に集約）

## 関連して見つかった既存のバグ

`gridBlocks.ts` の `parkCell` が、park するときセルの `account` / `width` / `parent` を落としている
（`asParked` は parse 側でこれらを読むので、保存形式の想定とずれている）。
park → 復帰したペインが既定アカウントに戻る経路。本件と同じ「付随物を運び忘れる」クラスなので一緒に直す。

# 09 — I-4 キーマップ既定値（R3）設計ノート

**生成モデル:** Claude Opus 5（実装・設計）
**作成日:** 2026-08-01 / 読む深さ: 使い捨て（実装記録。CEO は読まなくてよい）
**対象要求:** `05-requirements.md` R3 / 実装計画 `06-implementation-plan.md` I-4
**入口ファイル:** `common/keymap.ts` / `src/composables/gridShortcut.ts` / `src/components/gridTabs.ts` / `src/components/GridView.vue`

---

## 1. 何が問題だったか

fork の keymap 機構は完成していたが **7 アクション全部未割り当て**で、ユーザー config も `{}`。つまりグリッドはキーボードから一切運転できず、列を移るのにマウスが要る状態だった。iTerm2 + tmux では Option+i/j/k/l がペイン移動、M-u/M-h が前後ウィンドウで、これが日常の主操作（`01-iterm2-inventory.md` §2）。「列を変えるのにマウスに手が伸びる」時点で乗り換えは成立しない。

加えて upstream のアクションは **全部ズーム中のセルに作用する**設計だった。非ズームのグリッドには「今のターミナル」が無い、という理由で `NEEDS_A_CURRENT_TERMINAL` に閉じ込められている。しかし本 fork の主役は 9〜10 列の非ズームグリッド（設計原則 1）なので、この前提のままでは既定値を出荷しても半分死ぬ。

## 2. 決めたこと

### 2.1 新アクション 4 つ（`focus-next/prev-column`・`page-next/prev`）

- **非ズームのグリッドにも選択はある** — `focusedCellUid`（`focusin` が上がってくる）。upstream が「無い」と言っていたのはズーム対象のことで、DOM フォーカスは常にある。よって列移動は `NEEDS_A_CURRENT_TERMINAL` に入れない（要求どおり）
- **端で止める（wrap しない）**。巡回するのは `next-attention` だけ。あれは「呼んでいるセルの一巡」であって端のあるリストではないから。列やページで wrap すると、最終列で Alt+L を押した瞬間にカーソルが画面の反対側へ飛び、「別のことが起きた」と読める
- **ズーム中の列移動 = `zoom-next/prev` と同義**（要求で許可された挙動）。ズーム中は画面に列が無く、拡大対象が唯一の「選択」なので、1 階層上の同じジェスチャに落とすのが自然
- **ズーム中のページ移動は no-op**。これは要求に無い判断なので理由を書く: `switchPage` は `expanded: null` を立てる。つまりページキーがズーム中に効くと**レイアウトごと畳む**。これは `gridTabs.ts` のズーム不変条件 1（「ズームの有無を変えるのは `toggleZoom` だけ」）への違反そのもの。しかも失うものが無い — `page` はズーム中に未使用で、ズーム解除時は拡大中セルの位置から再導出されるため、仮に成功しても不可視のうえ直後に上書きされる

### 2.2 `DEFAULT_KEYMAP` と「1 個でも書いたら全部無効」

| 割り当て | アクション | 由来 |
|---|---|---|
| `Alt+J` / `Alt+L` | `focus-prev-column` / `focus-next-column` | iTerm2 の Option+j/l |
| `Alt+U` / `Alt+H` | `page-prev` / `page-next` | tmux の M-u / M-h（前後ウィンドウ） |
| `Alt+A` | `next-attention` | |
| `Alt+Z` | `zoom-toggle` | |
| `Alt+N` | `terminal-new-adjacent` | |
| `Alt+W` | `terminal-close` | |

- `terminal-new` は**あえて未割り当て**。常用するのは adjacent の方で、2 つ目の「新規」キーは端末から 1 キー奪うだけ
- **all-or-nothing**（`keymapWithDefaults`）。upstream の「バインドは端末からキーを奪うのでユーザーが決める」という理屈を捨てずに残すための形。マージ方式にすると、ユーザーが 1 個書いただけで**書いた覚えのない 7 個が黙って同居**することになり、上記の理屈と正面から矛盾する。全部切りたいときは押さないキーに 1 個割り当てれば済む
- 判定は **sanitize 後**のマップで行う。「ユーザーが割り当てた」は「実際に動くものを割り当てた」の意味。壊れた binding はそもそもここに来ない（サーバーが起動を拒否する）
- 適用点は `setActiveKeymap`（クライアント 1 箇所）。サーバーの `app-config.ts` はユーザーが書いたものをそのまま保持する（config ファイルの内容と `/api/config` の返り値が食い違わないようにするため）。**hydration 前は空のまま** — `/api/config` は非同期なので、既定値を先に有効化すると「config で置き換えるつもりのユーザー」から一瞬キーを奪う

### 2.3 macOS の Option 問題（要求 4）

実装は `event.key` 照合だったので、`Alt+J` は macOS で `key: "∆"` として届き**永久に一致しない**。既定値が全部 Alt 系なので、これを直さないと出荷しても全滅する。

- `matchesBinding` に **`code` 照合のフォールバック**を追加。`Alt` 付きの binding に限り、英字→`KeyX`・数字→`Digit N` に変換して `event.code` と突き合わせる
- **`Alt` 限定にした理由**: `code` は QWERTY 上の物理位置。Dvorak ユーザーが `"a"` と書いたら彼の a キーの意味であって、QWERTY の A 位置ではない。全 binding で `code` を見ると別のキーを乗っ取る。Option 下では尊重すべき `key` がそもそも残っていないので、トレードオフが成立するのはここだけ
- 既存互換: 判定は `key 一致 OR code 一致` の**加算**なので、これまで一致していた keydown は全部一致し続ける
- 副作用（ドキュメント済み）: `Alt` binding では英字の大小が無意味になる（物理キーは 1 つ）。`"Alt+j"` と `"Alt+J"` は同一

### 2.4 フォーカスの可視化（要求 3）

**既に実装済みだったので何も足していない。** `TerminalGrid.vue` の `.focused` クラスが `box-shadow: 0 0 0 1px var(--accent)` のリングを出す。しかもコメントに「以前は拡大縮小していたが、可読行数を返せという指摘でリングに変えた」と経緯が残っている（`.stage:not(.zoomed) .grid > .focused`）。要求の「可読行数を食う装飾は禁止」を満たしているので、上乗せは毀損にしかならない。

### 2.5 `runShortcut` をテーブル化

アクションが 7 → 11 になり、if 連鎖が lint の complexity 上限（20）と cognitive-complexity（15）を超えた。`Record<GridShortcut, () => void>` のディスパッチテーブルに置き換え、`zoom-toggle` / `next-attention` / 列移動の中身は名前付き関数へ切り出した。1 アクション 1 行になるので、追加が隣のブランチの挙動を静かに変えることがない。

## 3. テスト

| ファイル | 何を固定したか |
|---|---|
| `test/common/keymap.spec.ts` | `code` 照合（Option 文字での一致・修飾キー完全一致の維持・Alt 以外では `code` を見ない・`code` 無しイベント）／既定値の適用条件（空なら適用・1 個で不適用・返り値経由で `DEFAULT_KEYMAP` を破壊できない）／`DEFAULT_KEYMAP` 自体が `validateKeymap` を通る（重複ゼロ）／`KEYMAP_ACTIONS` は追記のみ（dispatch 順の固定） |
| `test/src/components/gridTabs.spec.ts` | `focusStepUid`（端停止・起点なし・画面外起点・空 launch セル飛ばし）／`stepPage`（端停止・単一ページ・**ズーム中 no-op**・trailing launch セル破棄の継承） |
| `test/src/composables/gridShortcut.spec.ts` | 新 4 アクションが非ズームで解決される／ズーム限定アクションのゲートは不変／未割り当ての Alt 和音は端末に素通し |
| `test/src/components/GridView.spec.ts` | 配線（どのリストを渡しているか・カーソルが動くのかレイアウトが動くのか）／ページキーがズームを畳まないこと／**macOS が実際に送る文字での E2E**（`key: "¬", code: "KeyL"`） |

## 4. 副作用として直したもの（I-4 の範囲外）

`kanji` HEAD（7493b240）の時点で `yarn typecheck:test` と `yarn test` が**赤だった**。I-1（ワークスペース）の spec が旧 4 値の状態語（`blocked` / `done`）で書かれており、I-3（6 値語彙）とのマージで意味的に衝突したもの。テキスト上は競合しないので git は黙って通していた。3 箇所を `approval` と共有ヘルパー `counts()` に直した（`test/src/components/gridTabs.spec.ts`）。

**教訓（Layer 2 へ）**: Wave 内で並列に走らせた Issue が同じ語彙を触ったら、マージ後に必ず `typecheck:test` まで通すこと。`yarn typecheck` だけでは spec がコンパイルされないので気づけない。

## 5. 積み残し・懸念

- **実機での打鍵検証は未実施**（live 検証ゲート）。Vitest は jsdom で合成 KeyboardEvent を投げているだけで、macOS の実キーボードが本当に `code: "KeyJ"` を返すかは実機でしか確認できない。ブラウザ devtools で `addEventListener("keydown", e => console.log(e.key, e.code), true)` を 1 回叩けば済む。**Gate 1 のドッグフーディング初手で確認すること**
- `Alt+W` は Cmd+W と違いブラウザ予約ではないため通るはずだが、これも実機確認の対象
- 既定値がターミナル内アプリの Alt キーと衝突する可能性（`06` のリスク 2）。`vim` の M-l 等を使う場面があれば、その時に config で明示的に置き換える（all-or-nothing なので置き換えは全書きになる — スキル側に注意書きを入れた）
- `terminal-new` は未割り当てのまま。必要になったら `Alt+T` あたりだが、ブラウザ予約の `Cmd+T` と混同しやすい

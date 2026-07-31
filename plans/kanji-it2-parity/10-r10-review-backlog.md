# 10 — R10: designer / pdm レビューの積み残し一掃

**生成モデル:** Claude Opus 5 (claude-opus-5)
**作成日:** 2026-08-01
**読む深さ:** 📗 使い捨て（実装の設計判断メモ。判断待ちなし）
**対象要求:** `05-requirements.md` R10（P1）
**前提:** Wave 1-2 マージ済みの `kanji`。§2 設計 3 原則（縦カラム主役 / 可読行数が最上位指標 / 状態は同じ画面の中に「自分が何をすべきか」の語彙で）に従う

---

## 0. 結論サマリー

| # | 項目 | 状態 |
|---|---|---|
| 1 | 切断の明示表示 + グローバル集計 | **既に充足**（Wave 1 の 6 状態語彙 + `countByStatus`）。実装ゼロ、回帰ピンのテストのみ追加 |
| 2 | チップ削除の undo | 実装（5 秒・チップが抜けたスロットにインライン） |
| 3 | auto ソートのカーソル下保留 | 実装（打鍵中は並び順を凍結、2 秒停止 or フォーカス喪失で適用） |
| 4 | ペインのカスタム名 | 実装（strip をダブルクリック → インライン入力、`grid_v2` 永続化、agent API の `label` 接続） |
| 5 | ペイン全面ドロップ + Cmd+V 画像貼付 | 実装（セル全面ドロップ / `POST /api/paste-image`） |
| 6 | Shell セルのヘッダー 2 行化 | 実装（Claude セルと同じ行 1 + ステータス行、状態語「シェル」） |

---

## 1. 切断の明示表示 — 確認結果（実装不要）

R10 の 1 項目目は「作る」ではなく「本当に満たされているか」の確認だった。**満たされている。**現状の経路を上から下まで辿った結果:

| 層 | 実体 | 場所 |
|---|---|---|
| 語彙 | `disconnected` は 6 状態のひとつ。`paneStateOf` で **最優先**（死んだペインは直前に何をしていようが「切断」） | `common/paneState.ts` |
| 表示語 | `PANE_STATE_WORD.disconnected = "切断"` | 同上 |
| ペイン自身 | `connView` の socket 状態から `disconnected` を算出 → 赤枠 + 赤ヘッダ + strip の「切断」 | `src/components/TerminalCell.vue` |
| Shell ペイン | プロセス終了 = `disconnected`（再起動ボタン付き） | `src/components/LauncherCell.vue` |
| 優先規則 | `CELL_OWNED` によりセル側の `disconnected` がサーバーの「実行中」に**勝つ** | `gridTabs.resolveCellStatus` |
| グローバル集計 | `countByStatus` が全ページ横断で計上 | `gridTabs.ts` |
| ツールバー | 赤ドット + 件数（承認待ちとは別枠） / ツールチップに `N disconnected` | `AppToolbar.vue` / `gridStatusSummary` |
| 導線 | `next-attention` の探索順が `approval → question → disconnected → unread → idle`、auto ソートの RANK も同順 | `gridTabs.ts` |

**不足していたのはテストだけ**だった（変換関数は `gridTabs.spec` / `paneState.spec` で厚く、**画面**は未カバー）。そこで実装の代わりに回帰ピンを追加した — `test/src/components/disconnectedSurfaces.spec.ts`:

- socket が落ちたセルが「切断」と赤枠を出す
- サーバーの最終行が `working: true` でもセル側が勝つ
- ツールバーの赤ドットが承認待ちの琥珀ドットと**別枠**で出る

## 2. 削除チップの undo

- 新トースト UI は**作らない**（原則 2: クロームは可読行数への毀損）。チップが抜けた**そのスロット**に Undo チップを出す。目線が既にそこにあり、他所に出すと「探すもの」が 1 つ増える
- スロット確保は **flex `order`** で行う（プリセット配列に偽エントリを差し込まない）。これで D&D 並べ替え・アラートバッジ・v-for キーのどれもプレースホルダを「ディレクトリ」と誤認しない
- 復元は**元の index に戻す**。チップ列は手で並べ替える列なので、先頭に戻すと削除を取り消したつもりで行が並び替わる
- 最後の 1 個を消した場合もチップ行を生かす（`showChipRow`）。消えると undo ごと消える = 誤クリックのコストが最大のケースで救済不能になる
- 保持と 5 秒タイマーは **GridView 側**（プリセット書き込みの隣）。undo は他の変更と同じ直列化された `savePresets` を通り、サーバー config に再登録される
- 実装: `src/components/presetUndo.ts`（純関数）/ `GridView.vue`（保持・タイマー）/ `AppToolbar.vue`（描画のみ）

## 3. auto ソートのカーソル下保留

- 発火条件: **xterm 自身の hidden textarea**（`.xterm-helper-textarea`）への打鍵。ランチャーのディレクトリ入力やページ名リネーム欄は端末ではないので保留しない
- 解除は 2 経路 — 打鍵が 2 秒止まる / 端末がフォーカスを失う（後者は即時。どこも打っていないなら守る対象がない）
- 凍結は**スナップショット再生ではなく突合**（`holdOrder`）。保留中にカラムは閉じたり開いたりするので、閉じたセルを含む・新カラムを欠いた順序を再生すると、防いだはずの誤爆より悪い嘘になる。新カラムは保留分の後ろに live 順で入る
- リスナーは capture phase の `window`（`useCaptureKeydown` と同じ理由）。キーは**奪わない** — 打鍵があった事実だけ記録する
- 実装: `src/components/sortHold.ts`（純関数）/ `src/composables/useTypingHold.ts`（状態）/ `GridView.vue`（`orderedCells` に適用）

## 4. ペインのカスタム名

**AI タイトルより優先する理由**: 同じリポジトリに 4 ペイン開くと、AI サマリーは**唯一区別に使えない情報**になる（4 つとも同じプロジェクトについてもっともらしいことを言う）。手で付けた名前は安定していて「どのペインか」の答えそのもの。名前があるときは strip の可変スロットを取り、サマリーは hover に退く（端末本体が同じ作業を映しているので失うものはない）。

**ダブルクリック対象の乖離（要件からの意図的な逸脱）**: 要件の原文は「ヘッダーの dir 名部分をダブルクリック」だが、**Wave 1 で行 1 から dir テキストは消えている**（identity は左スティッキー + hover title に移行済み）。加えて行 1 のヘッダー背景クリックは**ズーム**なので、そこに dblclick を置くとズーム → 解除を往復してから入力に入る。よって dblclick は**ステータス行の identity テキスト**（名前 / サマリーが出るスロット）に置いた。行 1 の直下、名前が実際に表示される場所であり、クリック動作の競合がない。

- 永続化: `Cell.name`（`grid_v2`）。parse 時に再トリム（手編集された blob の 10k 文字 name でワークスペース全ペインの strip が壊れる）
- 上限 32 文字。strip は状態語とモデルバッジと 22px を分け合う行であり、名前がサマリーの行を奪う原因になってはならない
- 空文字で**クリア**（`undefined` に戻す。空文字を永続化すると「名前あり・中身なし」として全判定を通ってしまう）
- Enter でコミット + 入力を閉じる → 続く blur が**二度目**を送らないようガード（Esc 後の blur が破棄した草稿を保存する事故も同じガードで防ぐ）
- **agent API の `label` 接続**: `AgentColumnEvent.label` は R8 の時点から event に載っていたが、セル側に置き場がなくログ出力だけだった。`addCellWithCwd(state, cwd, name)` でそれが着地する

## 5. ペイン全面ドロップ + Cmd+V 画像貼付

### 5.1 全面ドロップ
- 従来のドロップ先は端末キャンバスのみ。ヘッダ・strip・（ズーム時）端末ツールバーを差し引くとカラムの過半ではなく、数ピクセル上に落ちると**無言で何も起きない**
- セル root で受け、`e.defaultPrevented` で調停する。キャンバス上のドロップは Terminal.vue が処理して preventDefault 済みで上がってくるので、**二重挿入しない**
- カラム並べ替えドラッグは独自 MIME（`Files` を含まない）なので、`dragCarriesFiles` ゲートで素通りし TerminalGrid の drop ハンドラに届く（既存挙動は不変）
- Chrome がパスを渡さないケースは strip に一言出す（無反応 = 機能が壊れて見える）

### 5.2 Cmd+V 画像
- クリップボード画像には**パスがない**。だからドロップ経路では代替できない。バイト列をホストへ送り、ワークスペースの添付ストアに書いて、返ってきたパスを端末入力欄へ挿入する
- **既存機構の再利用**: `server/backends/remoteHost/attachmentStore.ts`（電話からのチャット添付が使う `data/attachments/YYYY/MM/<uuid>.<ext>`）。remote 固有の要素は何もなく、これまで remote 経路からしか呼ばれていなかっただけ。ストアが 1 つなら掃除先も命名規則もパーティションも 1 つで済む
- 新規ルート `POST /api/paste-image`（`server/files/paste-image.ts`）。**ブラウザから到達できる汎用 upload 経路は既存になかった**ので新設。同一オリジンゲート + 個別 origin チェック（`pick-file` / `open-dir` と同じ作法）
- 応答は**絶対パス**。ペインはどのディレクトリでも動きうるので、ワークスペース相対パスは workspace 以外の全ペインで間違いになる
- 受け入れ MIME はスクリーンショット系のみ（png/jpeg/webp/gif）。添付ストアは未知 MIME を `.bin` にするので、**エージェントが開けないファイルは「何も起きなかった」より悪い**
- サイズ上限 15 MiB は `common/pasteImage.ts` に 1 回だけ書き、ブラウザ側が事前に弾き、ルートが受信バイトで再検査する
- ⚠️ **`../mulmoclaude` の sibling checkout がこの環境に存在しない**ため、CLAUDE.md の「API パスは MulmoClaude が命名権威」チェックを実行できなかった。命名は本リポの既存流儀（`/api/pick-file`, `/api/open-dir`, `/api/git-remote`）に合わせている。MulmoClaude 側に相当ルートがあれば要突合

### 5.3 一時メッセージの出し方
「保存中…」「挿入しました」「失敗しました」は**トーストにしない**。strip の可変スロットを数秒借りる（コピーボタンの outcome ラベルと同じ理屈 — 30 カラムの 1 本に浮くパネルは可読行を食って何も伝えない）。

## 6. Shell セル（LauncherCell）のヘッダー現代化

- 行 1 = identity（DirBadge + アクション）/ 行 2 = ステータス行（ドット + 状態語 + 実行中のコマンド + ディレクトリ）
- 状態語は `paneStateWord` 経由の「シェル」/ 終了後は「切断」。**Claude ペインと同じ表・同じ位置・同じ色**
- 色表は `src/components/cellStatusStyles.ts` に切り出して両者で共有した（TerminalCell から移設）。1 列隣の「実行中」と別の色で「シェル」が出るなら、語彙を 1 つにした意味がなくなる
- 左スティッキー（ディレクトリ色）も Claude セルと揃えた
- **行数コスト**: 34px 単行 → 24px + 22px = 46px（+12px ≒ 端末 1 行弱）。原則 2（可読行数が最上位指標）に対する持ち出しだが、これは要件が明示的に求めたトレードオフであり、得るものは「グリッド全体で 1 つのペイン言語」。Claude ペイン側の行数・strip は**一切変えていない**

---

## 7. 変更ファイル

**新規**
- `common/pasteImage.ts` — 貼付画像の wire shape と検証（両側が読む）
- `server/files/paste-image.ts` — `POST /api/paste-image`
- `src/components/presetUndo.ts` / `src/components/sortHold.ts` / `src/components/cellStatusStyles.ts`
- `src/composables/useTypingHold.ts` / `src/composables/usePasteImage.ts`

**変更**
- `src/components/gridTabs.ts` — `Cell.name` / `setCellName` / `cellName` / `addCellWithCwd(name)` / parse
- `src/components/GridView.vue` / `TerminalGrid.vue` / `TerminalCell.vue` / `LauncherCell.vue` / `AppToolbar.vue`
- `server/routes/app-routes.ts` — ルート登録

**テスト（新規 8 本）**: `test/common/pasteImage.spec.ts` / `test/server/files/paste-image.spec.ts` / `test/src/components/{presetUndo,sortHold,cellPaneName,cellDropAndPaste,LauncherCellStrip,AppToolbarPresetUndo,disconnectedSurfaces,GridViewR10}.spec.ts` / `test/src/composables/{useTypingHold,usePasteImage}.spec.ts`

## 8. 検証されていないこと（正直な範囲）

- **実ブラウザでの実行は未検証**。全て jsdom + Vitest。特に ①実 Chrome / Safari のクリップボード `items` の並び ②実 xterm textarea への paste イベントの伝播順 ③実 D&D の `dragleave` 発火パターン は、jsdom の DataTransfer / ClipboardEvent がモックである以上、**動く保証ではない**
- 30 ペイン実機での保留ロジックの体感（2 秒が長すぎ / 短すぎ）は使ってみないと分からない。定数は `TYPING_HOLD_MS` 1 箇所
- `/api/paste-image` の MulmoClaude 側との命名突合（§5.2 の ⚠️）

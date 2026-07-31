# 10 — フォークボタン (R12) とスクロールバック (R13)

**生成モデル:** Claude Opus 5 (claude-opus-5)
**対象 Issue:** I-9（フォークボタン / R12）, I-10（スクロールバック再 wrap / R13）
**読む深さ:** 使い捨て（実装済みの設計記録。判断待ちなし）

---

## I-9 フォークボタン (R12)

### 何を作ったか

Claude セルの `…`（ツールバー行）に Fork ボタンを 1 つ。押すと **そのセルの右隣に新カラム**が開き、
`claude --resume <元セッション> --session-id <新規> --fork-session` で起動する。元セッションは
触られず、そのまま動き続ける。CEO が手で打っていた `claude --resume --fork-session` の 1 クリック化。

### 経路（上から下へ）

| 層 | ファイル | 役割 |
|---|---|---|
| ボタン | `src/components/TerminalCell.vue` | `…` 行に `cell-fork`。セルは「頼む」だけ（`fork` emit） |
| 中継 | `src/components/TerminalGrid.vue` | `fork(uid)` を上へ |
| セル生成 | `src/components/gridTabs.ts` `forkCell()` | `insertCellAfter` で **元セルの直後**に `{ session: null, cwd: 元と同じ, fork: 元 session id }` |
| 起動 | `src/components/GridView.vue` `onFork()` | プリセットチップと同じ `autoLaunchUid` に乗せる（フォームで止めない） |
| URL | `src/components/wsUrl.ts` | `/ws?...&fork=<id>`。**`session` が付いたら fork は落とす** |
| 判定 | `server/session/session-resolve.ts` `resolveFork()` | 純粋関数。none / fork / unavailable の 3 値 |
| 経路 | `server/routes/ws-routes.ts` `planClaudeConnection()` | セッション解決と fork をまとめて 1 つの plan に |
| argv | `server/agents/claude-args.ts` | `--resume <src> --session-id <new> --fork-session` |

### 設計判断 3 つ

1. **新 id は必ずこちらで決める（`--session-id` を併記）。** `--fork-session` 単体だと claude が
   自分で新 id を採番し、こちら側はどの transcript を書いているか分からなくなる → 再起動後の
   resume 不能・「最後の返答をコピー」不能・セルの活動表示なし。実測で
   `--resume <src> --session-id <new> --fork-session` が有効なことを確認済み（新 id の .jsonl が
   生成され、元の .jsonl は無傷）。
2. **失敗はサイレントに新規セッションへ落とさない。** 元が `/clear` 済み等で transcript が無い場合、
   `resolveFork` は `unavailable` を返し、経路は端末にエラー文を出してソケットを閉じる
   （`closeWithError` はクライアント側で terminal 扱い＝再接続しない）。「フォークしたつもりが
   まっさらな別セッションだった」が最悪の失敗なので、ここだけは必ず止める。
3. **fork は 1 回きりのリクエスト。** 二重に守る。①クライアント: サーバーが新 id を返した瞬間に
   `TerminalCell` の `forkFrom` と grid の `cell.fork` を捨てる（`setSession`）。②サーバー:
   reattach / resume が成立する接続では fork パラメータを無視する（`fresh` フラグ）。
   これが無いと、ソケット断→再接続のたびに元会話を何本もフォークする。

4. **id 待ちのフォーク列は「空の起動フォーム」ではない**（レビュー指摘で追加）。`isOccupied` に
   `fork != null` を足した。これが無いと、まだ session id が付いていないフォーク列が
   「末尾の空セル」と同一視され、タブ切替（`switchPage`）で消える / プリセットチップに
   上書きされる（`addCellWithCwd`）/「+ Terminal」で取り消される。特に**フォークが拒否された
   セルは永久に session なし**なので、読ませたいエラー文がタブを切り替えた瞬間に消えていた。

補足: フォーク先の provider/model は**元セッションのものを引き継ぐ**（`rememberedChoice`）。
新 id はこのサーバーが選択を見たことがないため、放置すると分岐した瞬間に別バックエンドへ移りうる。
また argv 側の `ForkNotResumableError` は経路の catch で拾い、フォークの問題として端末に出す
（`claudeSpawnFailure`）。放置すると「claude が PATH にありますか」という無関係な案内になる。

### 実挙動の確認（ローカル実サーバー）

- 正常系: `/ws?gui=0&cwd=<dir>&fork=<既存 session>` → 新 id が返り、`ps` で
  `claude --resume 2222… --session-id 44ac… --fork-session` が tmux 配下で起動しているのを確認。
  端末には元会話が載った状態（Context 33%）で TUI が立ち上がった。
- 異常系: 存在しない session を fork → `{"type":"error","message":"Cannot fork this session: …"}`
  を受信してクローズ。PTY は生成されず、新セッションも作られない。

---

## I-10 スクロールバック (R13)

### 何を変えたか

`common/terminalScrollback.ts` に `TERMINAL_SCROLLBACK_DEFAULT = 10_000` を置き、
`useTerminalConnections.ts` の `new Terminal({ … })` に `scrollback` として渡した。全セル共通。
グローバル config 化はしていない（設定面を増やす必要が出ていない。増やすなら `fontFamily` と
同じ経路 = `config-schema` → `app-config` → `/api/config` → グローバル ref）。

### 再 wrap（reflow）が効く根拠 — 3 行

xterm.js は**通常バッファ**を resize 時に再折返しする（実測: 20 桁で書いた 36 文字を 10 桁に
縮めると 4 行へ組み直された。`test/src/composables/terminalScrollback.spec.ts` が実 xterm で固定）。
Claude Code の TUI は代替スクリーンを奪わず通常バッファに書くため、この経路にそのまま乗る。
iTerm2 は書き込み時点の桁数で折返しを焼き込むため、カラム幅を変えると過去が読めなくなる —
これが「原理的に解けない」と結論していた痛みで、ブラウザ側の terminal に移した時点で解消する。

### tmux 側の履歴

`server/infra/tmux.ts` の `TMUX_CONF_LINES` は既に `set -g history-limit 20000`。
xterm の 10,000 を上回っているので**変更不要**。ただし両者は直列で、再アタッチ時に画面へ戻る
過去は tmux ペイン側から来る（ブラウザの xterm は reload で空になる）。tmux 側が小さいと
ブラウザがいくら持てても表示できない上、どちらにも説明が出ない — この関係を
`test/server/infra/tmux.spec.ts` の 1 ケースで固定した（history-limit >= scrollback）。

### メモリ

10,000 行 × 30 ペインは無視できる量ではないが、xterm の行バッファは書かれた分だけ確保される
（空の履歴は確保されない）ので、実際に 10,000 行流したペインだけが上限まで伸びる。
30 ペイン常用で問題が出たら、上記のとおり config 化して落とせる。

---

## テスト

| ファイル | 内容 |
|---|---|
| `test/server/agents/claude-args.spec.ts` | fork の argv 組み立て / MCP・model の据え置き / resume 不能なら例外（サイレント新規化の禁止） |
| `test/server/session/session-resolve.spec.ts` | `resolveFork` の 3 値。特に「再接続では fork を無視」「transcript 無しは unavailable」 |
| `test/src/components/gridTabs.spec.ts` | `forkCell` が `insertCellAfter` 経由で隣に開く / 上限・非セッションの拒否 / id 待ちでも実カラム扱い / `setSession` で fork を使い切る |
| `test/src/components/GridView.spec.ts` | grid → 新カラムが元の隣に立ち、auto-launch に乗る |
| `test/src/components/TerminalCell.spec.ts` | ボタンは `…` 行だけ・会話がある時だけ / fork が端末へ渡り、session 到着で消える |
| `test/src/composables/terminalScrollback.spec.ts` | 実 xterm で 3,000 行保持と narrow 時の再折返し |
| `test/server/infra/tmux.spec.ts` | tmux history-limit >= xterm scrollback |

## 積み残し / 懸念

- サイドバーに出るフォーク直後のタイトルは `New session`（最初の prompt / AI タイトルで置き換わる）。
  「Fork of …」的な命名は入れていない。
- フォーク元がまだ 1 度も prompt を送っていないセル（transcript 未生成）では Fork が
  「フォークできません」で失敗する。ボタン自体は session id があれば出るので、**押してから**
  分かる。押す前に落とす（disabled）には transcript 有無をクライアントが知る必要がある。
- 常時表示 UI は増やしていない（Fork は `…` 行のみ）。

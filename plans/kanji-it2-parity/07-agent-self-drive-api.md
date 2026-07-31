# 07 — R8 エージェント自走 API（実装ノート）

**生成モデル:** Claude Opus 5 (claude-opus-5[1m])
**対象:** 05-requirements.md の R8 / 実装日 2026-07-31
**読む深さ:** 📙 要判断 — §5 の CLAUDE.md 差し替え案だけ CEO の確認が要る。他は実装記録

---

## 1. 何を作ったか

| API | やること |
|---|---|
| `POST /api/workspace/column` | 指定ディレクトリに **claude が走った状態の新カラム**を 1 本開く。任意で初回プロンプトを自動実行 |
| `POST /api/broadcast` | 稼働中の **全 Claude セッション**に 1 つの指示をタイプ注入して Enter。`cwd` 指定でそのディレクトリのみ |

どちらも localhost の Claude セッションが curl で叩く前提。認証は新設しない — 既存の
`sameOriginGuard`（`server/routes/same-origin-guard.ts`）が全 POST に効いており、Origin ヘッダの無い
ローカル非ブラウザ呼び出し（curl）は通り、ユーザーが訪れた外部サイトからの POST は 403 になる。
実測: `-H 'origin: https://evil.example'` で 403、Origin なしの curl で 200/409。

## 2. 設計判断（なぜこの形か）

**判断 1: 新カラムは「1 タブにだけ」配る（`publishToOne`）。**
要求文は「接続中の全ブラウザクライアントに WS でイベントを流し」だったが、これは既存の #831
（スマホからのターミナル起動）が意図的に避けた形。全タブにブロードキャストすると、ワークスペース用に
ブラウザウィンドウを 2 枚開いた状態（R1 の想定）で **1 回の API 呼び出しが 2 本のカラムを開く**。
「接続しているブラウザに届かせる」という意図は `publishToOne` で満たされ、誰も受け取らなければ
`false` が返るので 409 に落とせる。既存資産と同じ判断に揃えた。

**判断 2: プロンプト本文はブラウザを通さない。**
イベントに載るのは `{cwd, label}` だけ。初回プロンプトはサーバー側のキュー
（`server/session/agent-prompt-queue.ts`）に置き、そのディレクトリで**新規に spawn したグリッドの
claude セッション**が WebSocket 接続してきたときに取り出して、既存の `initialPrompt` 経路
（`draft-injection.ts`: bracketed paste → 250ms 後に Enter）に渡す。理由は 2 つ:

- pub/sub に到達できるページが「エージェントの中で自動実行される文字列」を差し込めない
- 長文プロンプトを扱う既存機構（CLI 引数だと tmux の command-length 上限で落ちる、と 04 §3.1）を
  そのまま再利用でき、新しいタイピング処理を書かなくて済む

キーはディレクトリ（セッション ID は応答時点で存在しないため）。同じディレクトリに 2 本頼めば
FIFO で順に配られる。未消費のプロンプトは **120 秒で失効**し、配信に失敗したら即座に取り消す
（手で開いたカラムを後から乗っ取らないため）。

**判断 3: broadcast は working 中に送らない。**
`working !== false` を全て skip 扱いにする。`undefined`（まだフックが 1 度も鳴っていない）も skip:
初回プロンプト付きで起動したセッションはフック前に 1 ターン走るので、「不明 = 待機」と読むと
ターンの途中に文字を突っ込むことになる（`terminalInput.ts` の `canClearInputBox` と同じ理屈）。
シェルセル・Codex セルは候補にすら入れない（貼り付いた文字列がシェルではコマンドとして走るため）。
応答は `{sent, sessions, skipped}` で、誰に届いて誰に届かなかったかを呼び出し側が言える形。

**判断 4: cwd はフォールバックしない。**
既存の `resolveWorkspace()` は不正パスを既定ワークスペースに落とすが、この API では
「頼んだのと違う場所にエージェントのカラムが開く」ほうが有害なので、`existingDir()`（新設・
フォールバック無し版）で 400 にする。broadcast の `cwd` も相対パスなら 400（黙って 0 件に
なると「全員 working だった」と誤読されるため）。

## 3. ファイル

新規:
- `common/agentApi.ts` — wire 型・pub/sub チャネル名・イベントのパーサ
- `server/routes/agent-routes.ts` — 2 ルート
- `server/session/agent-column.ts` — カラム要求の純粋な判定（400 / 409）
- `server/session/agent-broadcast.ts` — 宛先の純粋な選別 + body 検証
- `server/session/agent-prompt-queue.ts` — 初回プロンプトの一時保管（TTL 120 秒）
- `src/composables/useAgentColumn.ts` — 購読 + グリッド未マウント時のキュー（`useNewTerminal` と同型）
- specs 4 本（`test/common/agentApi.spec.ts`, `test/server/session/agent-{column,broadcast,prompt-queue}.spec.ts`,
  `test/server/routes/agent-routes.spec.ts`）

既存への差分（最小・upstream rebase 耐性のため）:
- `server/index.ts` — ルートのマウント（+ import 3 行）
- `server/routes/ws-routes.ts` — fresh spawn 時にキューからプロンプトを取り出す 1 箇所
- `server/config/workspace.ts` — `existingDir()` を新設、`resolveWorkspace` をその上に載せ替え
- `src/App.vue` — 購読 2 行
- `src/components/GridView.vue` — ハンドラ登録（プリセットチップと同じ `onQuickLaunch` に流す）

## 4. curl での叩き方

前提: サーバーは `http://localhost:34567`（`~/.mulmoterminal/config.json` / launchd の設定どおり）。
**ブラウザのタブが 1 枚以上開いていること** — カラムを開くのはブラウザ側なので、閉じていれば 409 が返る。

```bash
# 1. 新しいカラムを開く（そのディレクトリで claude が起動する）
curl -sS -X POST http://localhost:34567/api/workspace/column \
  -H 'content-type: application/json' \
  -d '{"cwd":"/Users/kanjinoguchi/Projects/orosy-v2","label":"orosy"}'
# => {"ok":true,"cwd":"...","label":"orosy","prompt":false}

# 2. 初回プロンプト付き（起動後に自動でタイプされ、Enter まで押される）
curl -sS -X POST http://localhost:34567/api/workspace/column \
  -H 'content-type: application/json' \
  -d '{"cwd":"/Users/kanjinoguchi/Projects/orosy-v2","label":"orosy",
       "prompt":"HANDOVER-*.md を読んで、続きから着手して"}'

# 3. 全 Claude セッションに一斉指示（working 中のセッションは skip される）
curl -sS -X POST http://localhost:34567/api/broadcast \
  -H 'content-type: application/json' \
  -d '{"text":"いまの作業を HANDOVER.md に保存して"}'
# => {"sent":6,"sessions":["...","..."],"skipped":[{"id":"...","reason":"working"}]}

# 4. 特定ディレクトリのセッションだけに送る
curl -sS -X POST http://localhost:34567/api/broadcast \
  -H 'content-type: application/json' \
  -d '{"text":"検算して","cwd":"/Users/kanjinoguchi/Projects/orosy-v2"}'
```

エラーの読み方:
- `409` = MulmoTerminal のブラウザタブが開いていない（カラムを開ける相手がいない）。**成功と区別できる**
- `400` = `cwd` が絶対パスの実在ディレクトリでない / `text` が空 / 長すぎる
- `403` = 外部サイトからの呼び出し（curl では起きない）
- `skipped: [{reason:"working"}]` = そのセッションはターン実行中なので送っていない。落ち着いてから再送する

## 5. 🔴 要判断 — `~/.claude/CLAUDE.md`「別プロジェクトへのシームレス分岐」の差し替え案

推奨: 下記で現行セクション（claudecode-notify の `POST /api/workspace/add` に依存している手順）を置き換える。
理由: MulmoTerminal 移行後は claudecode-notify のワークスペース API を叩いても iTerm2 側にしかペインが増えず、
CEO が見ている画面には現れないため。拒否権: iTerm2 と併用する期間は両方併記でもよい（その場合は
「MulmoTerminal を見ているなら下、iTerm2 を見ているなら上」と条件を明記する）。

```markdown
## 別プロジェクトへのシームレス分岐（能動的提案）
会話中に現在のプロジェクト外の作業アイデアが出た場合、**能動的に**「別カラムで新しい Claude Code を
立ち上げて進めますか？」と提案すること。

### 判定条件
- 話題が現在の cwd とは別のプロジェクト（別リポジトリ・別フォルダ）の実装・調査に移った
- ユーザーが「これ別で作りたい」「あっちのプロジェクトで」等のニュアンスを発した
- 新規プロジェクトのアイデアが具体化し始めた

### 実行手順（MulmoTerminal）
1. 引き継ぎファイル（`HANDOVER-{topic}.md`）を対象プロジェクトフォルダに作成する
2. MulmoTerminal に新カラムを開かせる。初回プロンプトまで一度に渡せる:
   ```bash
   curl -sS -X POST http://localhost:34567/api/workspace/column \
     -H 'content-type: application/json' \
     -d '{"cwd":"{target_dir}","label":"{topic}",
          "prompt":"{target_dir}/HANDOVER-{topic}.md を読んで、そこから着手して"}'
   ```
   `{"ok":true,...}` が返れば、そのディレクトリで claude が起動し、プロンプトが自動実行される
3. `409` が返ったら **カラムは開いていない**。MulmoTerminal のブラウザタブが閉じている状態なので、
   ユーザーに「MulmoTerminal のウィンドウを開いてください」と伝えてから再実行する（黙って成功扱いにしない）
4. 元のペインでの会話は中断せず継続する

### 全カラムへの一斉指示
全 Claude セッションに同じ指示を流したいとき（例: 一斉に作業を保存させる）:
```bash
curl -sS -X POST http://localhost:34567/api/broadcast \
  -H 'content-type: application/json' \
  -d '{"text":"いまの作業を HANDOVER.md に保存して"}'
```
応答の `skipped` に出たセッションは**ターン実行中なので送っていない**（入力中のプロンプトを壊さないため）。
必要なら落ち着いた頃に再送する。`cwd` を付けるとそのディレクトリのセッションだけに絞れる。
シェル・Codex のセルには届かない（仕様）。

### オーケストレーターとの違い
- **オーケストレーター**: 同じリポジトリ内のワークツリーで並列実装
- **この機能**: 全く別のプロジェクトを新しいカラムで立ち上げる。プロジェクト横断のマルチタスク用
```

## 6. 検証したこと / していないこと

**実測した**（`server/routes/agent-routes.ts` を実 Express + 実 same-origin ガードに載せ、curl で叩いた）:
ブラウザ 0 件で 409・購読 1 件で 200 と `{cwd,label}` のみの publish・broadcast が working を skip し
shell を候補にしないこと・`cwd` の末尾スラッシュ正規化・相対パスで 400・外部 Origin で 403。
加えて specs 全 4 本と既存 4,678 件が green。

**していない**: 実ブラウザで実際にカラムが開き、プロンプトがタイプされるところまでの通し確認。
本番サーバー（launchd, port 34567）が稼働中で、二重起動は `~/.mulmoterminal` の状態ファイルを共有するため
避けた。**Gate 1 のドッグフーディング時に、この 1 本を最初に通すこと**（`curl` → カラムが開く → 
プロンプトが自動実行される、を目視）。ここが通らなければ疑うのは
`GridView` のハンドラ登録（KeepAlive の activate タイミング）か、`ws-routes.ts` の
`queuedFirstTurn` の条件（grid = `gui=0` のみ、resume は対象外）。

**未確認**: MulmoClaude 側との API パス整合。sibling checkout（`../mulmoclaude`）が
この環境に無く突き合わせできなかった。ただし MulmoClaude にはターミナルグリッドが無く
「カラムを開く」概念そのものが存在しないため、fork 固有ルートとして扱ってよいと判断した。

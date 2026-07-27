# README-KANJI — この fork の野口さん専用セットアップ

fork: `n-kanji/mulmoterminal`（upstream: `receptron/mulmoterminal`）
カスタマイズはブランチ `kanji` に載っている。main は upstream 追従用にクリーンに保つ。

## 起動・停止

```
mterm            # 起動して http://localhost:34567 をブラウザで開く
mterm --no-open  # ブラウザを開かず起動
Ctrl+C           # 停止（tmux 永続化により Claude セッション自体は生き残る）
```

- `~/bin/mterm` … ランチャー。CLAUDE_BIN と MULMOTERMINAL_AUTOCONFIRM_CHANNELS を設定してこの checkout の `bin/mulmoterminal.js` を起動する
- `~/bin/claude-mulmo` … MulmoTerminal が spawn する claude の wrapper。iTerm2 の zsh 関数と同じく `--dangerously-load-development-channels server:claude-peers` を付ける

## この fork 独自のカスタマイズ（ブランチ kanji）

1. **claude-peers 連携** — 素の MulmoTerminal は `claude` を直接 spawn するため、
   zsh 関数で付けていた claude-peers チャネルが失われる。CLAUDE_BIN wrapper で復元した。
   グリッドから起動したセッションは iTerm2 のペインと同じ peers ネットワークに参加する
   （list_peers で見える・send_message が届く）。
2. **dev-channels 確認プロンプトの自動通過** — `server/session/channel-consent.ts`（新規）。
   claude-peers フラグ付き起動は毎回「I am using this for local development / Exit」の
   確認で止まるため、spawn 直後の PTY 出力を監視して自動で Enter を送る。
   - オプトイン: 環境変数 `MULMOTERMINAL_AUTOCONFIRM_CHANNELS`（mterm が設定）に
     一致するチャネルリストの時だけ発火。他のチャネルでは人間の確認待ちのまま。
     **単一チャネルリスト前提**（カンマ区切り複数は表示揺れで不発になり得る）
   - 監視は **TUI 起動（または 30 秒）で武装解除**される。起動後にこのプロンプトの
     文言をファイル表示しても誤 Enter は飛ばない（code-reviewer 検算の指摘で修正済み）
   - claude はこのプロンプトを単語ごとにカーソル移動で描画するため、
     エスケープ列をスペース化して照合している（詳細はソースコメントと spec 参照）
   - 発火時はサーバーログに `[consent] auto-confirming ...` が残る
   - テスト: `test/server/session/channel-consent.spec.ts`
3. 設定: `~/.mulmoterminal/config.json` にディレクトリプリセット（orosy-v2 ほか）を整備済み。
   見た目・色・通知音などは MulmoTerminal 内の claude セッションで `/mulmoterminal-config`
   と打つと対話的に設定できる。

## 既知の制限

- **単一ビュー（/chat）のセッションでは claude-peers の MCP ツールが載らない**。
  上流仕様で単一ビューは `--strict-mcp-config`（GUI MCP のみ）で起動するため。
  チャネル（メッセージ注入）は生きるが、そのセッション自身から list_peers 等は呼べない。
  グリッドのセッションは制限なし（通常 MCP がフルに載る）。
- グローバル設定はサーバ起動時に一度だけ読まれる。config.json を手で編集したら mterm を再起動する。

## upstream 追従（アップデート手順）

```
cd ~/Projects/tools/mulmoterminal
git fetch upstream
git checkout kanji
git rebase upstream/main        # カスタマイズは channel-consent 周りの小差分のみ
npx -y yarn@1.22.22 install --frozen-lockfile
npx -y yarn@1.22.22 build
```

conflict はほぼ `server/session/spawn-claude.ts` の import と scanner 1 行に限られるはず。
検証: `npx -y yarn@1.22.22 test test/server/channel-consent.spec.ts`

※ この Mac には yarn 本体が入っていない（corepack も無し）。`npx -y yarn@1.22.22` を使う。

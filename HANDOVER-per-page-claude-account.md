# HANDOVER — ページ別 Claude アカウント（2026-09-14）

## 何をしたか

グリッドの**ページ（タブ）ごとに別の claude.ai アカウント**でペインを走らせられるようにした。
従来のヘッダーチップは Keychain の資格情報を1つだけグローバルに差し替える方式で、
ワークスペース全体が同じアカウントになっていた。

コミット 8 本（`836421cf` 〜 `6890fd35`、ブランチ `kanji`）。設計と経緯は
`plans/feature-per-page-claude-account.md` に全部書いてある。**続きをやる人はまずそれを読む。**

## 仕組み（要点だけ）

Claude Code 2.1.270 は Keychain のサービス名を資格情報ストアのディレクトリから導出する:
`Claude Code-credentials-<sha256(dir)先頭8桁>`。`CLAUDE_SECURESTORAGE_CONFIG_DIR` を渡せば
**プロセスごとに別アカウントで同時ログイン**でき、`~/.claude`（設定・スキル・CLAUDE.md・履歴）は共有のまま。
`CLAUDE_CONFIG_DIR` はそれらも分割してしまうので使わない。env は**プロセス env** で渡す必要がある
（CLI は settings より前に解決する）。tmux 経由なので `new-session -- /usr/bin/env NAME=VAL <cmd>`。

## 触る前に知っておくべき罠（全部踏んで直した）

1. **tmux サーバーは最初の spawn の環境を保持する**。アカウント付きペインが tmux サーバーを立てると
   以後の未割り当てペインが他人のログインで起動する（#579 と同型）。env は new-session コマンド内だけに渡し、
   アカウント無しの claude spawn は常に変数名を scrub する。`SCRUBBED_NAMES` にも入れてある
2. **`~/.claude.json` は全ペイン共有**。ストア付きペインで `/login` すると、そのファイルの名義だけが書き換わる。
   だから既定アカウントは MT 自身が `~/.mulmoterminal/claude-accounts.json` の `defaultAccount` に記録し、
   食い違ったときは**資格情報を動かす操作を全部止めてチップで聞く**（黙って選ぶと別アカウントの資格情報を取り違えて保存する）
3. **ページ判定は表示順（`orderedCells`）から作った uid→アカウントのマップ1本**で、接続と stamp の両方を駆動する。
   自動ソートはページ跨ぎで動くしズーム中は全ページ描画なので、別々に求めると「X で動いて Y と表示」になる
4. **資格情報の所有者は常に1つ**。既定スロット、またはそのアカウントのストア。既定切替でストア保有アカウントを選ぶと
   ストアの生きた資格情報を使い、ストアは畳む（同じ refresh token が2箇所にあるとローテーションで片方が失効する）

## 実機検証（2026-09-14 済み）

- 専用ストアで起動したペインの env・Keychain 項目名・ターン完走を CLI で確認。他ペインへの env 漏れなし、
  tmux グローバル環境は削除指定済み。Keychain の許可ダイアログは出なかった
- CEO が 2枚目を作り kanji@spaceengine.io で実運用。トークンはローテートしたので、
  **旧グローバル切替用スナップショット（kanji@）は古い**。ただし切替はストアから読むので実害なし

## 残タスク

- [ ] `origin`（spacengine/mulmoterminal）への push（8 コミット未送信 / `company` remote）
- [ ] リリース時: `docs/ChangeLog.md` + `docs/guide/{en,ja}/v<version>.md`（リポジトリ規約。/publish の手順）
- [ ] `accountSpawnEnv` は spawn ごとに `security` を数回叩く。実測で気になったらキャッシュ（レビュー Minor #13、現状は不要判断）

## 参考

- `plans/feature-per-page-claude-account.md` — 設計・検証記録・レビューで変わった点
- memory `claude-credentials-per-config-dir` — CLI 側の導出ロジック（このリポジトリからは読めない知識）

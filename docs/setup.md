# セットアップ

インストールから、modを読み込んで保存モードを選ぶまでの手順。全体の概要は [README](../README.md) を参照。

## 必要なもの

- Claude Code v2.1.287以上（modが使えるバージョン）
- Node.js（v23で動作確認）
- [Ollama](https://ollama.com)（意味検索を使う場合）
- 使うプロジェクトが、**コミットが1つ以上あるgitリポジトリ**であること

Ollamaがなくても、保存とキーワード検索は動く。

gitリポジトリでない場所や、まだコミットがないリポジトリでは、modは何もしない。会話は保存されず（ステータス行に表示される）、検索もできない。最初のコミットをすると、それ以降の会話から保存される。

## 1. インストール

```bash
ollama pull bge-m3   # 意味検索用のモデル（Ollamaは起動しておく）

git clone https://github.com/localailab/mod-db-conversation.git
cd mod-db-conversation
npm install
npm run build
```

modが動かすのは `dist/cli.js`。`git pull` などで `src/` が変わったら、もう一度 `npm run build` する。

## 2. modを読み込む

1セッションだけ試す（リポジトリのルートで実行する）:

```bash
claude --plugin-dir "$(pwd)/mod/conversation-memory"
```

すべてのプロジェクトで常に読み込むには、`~/.claude/settings.json` に書く。`/path/to/mod-db-conversation` はcloneした場所に置き換える:

```json
{
  "env": {
    "CLAUDE_CODE_PLUGIN_DIRS": "/path/to/mod-db-conversation/mod/conversation-memory"
  }
}
```

`CLAUDE_CODE_PLUGIN_DIRS` は、リポジトリの中の `.claude/settings.json` に書いても読まれない。ホームの `~/.claude/settings.json` に書く。

## 3. 保存モードを選ぶ

モードの違いは [保存モードとデータ](storage.md) を参照。迷ったら、デフォルトの `shared` のままでいい。

### `shared` モード（デフォルト）

設定は要らない。すべてのプロジェクトの会話が `~/.claude-memory/` に保存される。

これまでの会話をまとめて取り込むときは（任意）:

```bash
cd /path/to/mod-db-conversation
npm run backfill
```

### `repo` モード

1. Claude Codeで `/config` を開き、`conversation-memory` の `storage` を `repo` にする
2. Claude Codeを起動し直す
3. 使いたいリポジトリでClaude Codeを起動して、会話する

最初に保存するときに、リポジトリの中に次のフォルダが自動で作られる。

```
<リポジトリ>/.claude/conversation-memory/
├── .gitignore           中身は「*」。このフォルダの中身はgitに入らない
├── conversations.db     SQLite（会話の本文、キーワード検索）
└── vectors/             LanceDB（意味検索用のベクトル）
```

gitに入らないことは、次のコマンドで確認できる。`!! .claude/` と出れば、無視されている。

```bash
git status --short --ignored .claude
```

これまでの会話をそのリポジトリのDBに取り込むときは（任意）、**そのリポジトリのルートで**実行する:

```bash
cd /path/to/your-repo
CONV_MEMORY_STORAGE=repo node /path/to/mod-db-conversation/dist/cli.js backfill
```

取り込まれるのは、そのリポジトリでした会話だけ。他のリポジトリの会話は、件数（`other_project`）として数えるだけで、保存しない。

`repo` モードで注意すること:

- **gitに入っていないことを毎回確認する**: 保存する前に、DBがgitに無視されているかを確かめる。無視されていなければ保存を止めて、ステータス行に `save failed: not ignored by git, ...` と出す。`.claude/conversation-memory/.gitignore` を消したり、`git add -f` したりしないこと
- **DBは持ち主のリポジトリでしか開けない**: DBには、作ったリポジトリの識別子が記録される。フォルダを別のリポジトリにコピーしても、そのリポジトリからは開けない
- **リポジトリと一緒に消える**: リポジトリのフォルダを削除したり、cloneし直したりすると、会話も一緒に消える（cloneし直した場合は、上の `backfill` で取り込み直せる）
- **worktreeごとに別のDBになる**: worktreeは作業フォルダが別なので、DBも別々にできる
- **クラウド同期に注意**: リポジトリがiCloud Driveなどで同期されるフォルダ（macOSの「デスクトップと書類」の同期など）にあると、会話のDBも同期される。SQLiteのファイルを同期中のフォルダに置くと、壊れることもある

## 4. 動作確認

1. `/plugin` を開いて、`mods active` の行に `conversation-memory` が出ていること
2. 何回かやり取りしたあと、ステータス行に `save failed` などのエラーが出ていないこと
3. `/recall` を実行して、今の会話が一覧に出ること

うまく読み込まれないときは、`claude --debug` で起動すると理由がログに出る。

## 古いDBがあるとき

以前のバージョンで作ったDBがあると、「older version」というエラーになる（プロジェクトの識別方法が変わったため）。`node dist/cli.js rebuild` で作り直す。今のDBは `backup-<時刻>/` に移され、Claude Codeが保存しているすべての会話から作り直される。`repo` モードでは、そのリポジトリのルートで `CONV_MEMORY_STORAGE=repo` を付けて実行する。

モデル名の欄（`model`）がなかった頃のDBは、開いたときに自動で欄が追加され、取り込み済みの会話からモデル名が埋められる。作り直す必要はない。

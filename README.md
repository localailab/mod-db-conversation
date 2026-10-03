# mod-db-conversation

Claude Codeの会話履歴を**すべて自動で保存**し、**プロジェクト単位で検索**できるようにするClaude Code mod。

- 会話は、Claudeが応答を終えるたびに自動で保存される。Claudeが保存を忘れることはない
- 「前に話したあれ」を、キーワードでも言い換えでも探せる
- プロンプトを送るたびに、関連する過去の会話を自動でClaudeに渡す
- プロジェクトごとに記憶が分かれる。別のプロジェクトの会話は混ざらない
- 会話ごとに、そのときのgitコミットを記録する。「どの時点のコードについての会話か」が分かる
- データはすべて手元のマシンに置く。会話を外部のサービスには送らない

## 必要なもの

- Claude Code v2.1.287以上（modが使えるバージョン）
- Node.js（v23で動作確認）
- [Ollama](https://ollama.com)（意味検索を使う場合）
- 使うプロジェクトが、**コミットが1つ以上あるgitリポジトリ**であること

Ollamaがなくても、保存とキーワード検索は動く。

gitリポジトリでない場所や、まだコミットがないリポジトリでは、modは何もしない。会話は保存されず（ステータス行に表示される）、検索もできない。最初のコミットをすると、それ以降の会話から保存される。

## セットアップ

```bash
ollama pull bge-m3   # 意味検索用のモデル（Ollamaは起動しておく）

git clone https://github.com/localailab/mod-db-conversation.git
cd mod-db-conversation
npm install
npm run build
npm run backfill     # これまでの会話をまとめて取り込む（任意）
```

以前のバージョンで作ったDBがあると、「older version」というエラーになる（プロジェクトの識別方法が変わったため）。`node dist/cli.js rebuild` で作り直す。今のDBは `backup-<時刻>/` に移され、Claude Codeが保存しているすべての会話から作り直される。

### modを読み込む

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

読み込まれたかどうかは、Claude Codeで `/plugin` を開くと確認できる（`mods active` の行に `conversation-memory` が出る）。

## 使い方

ふだんは何もしなくていい。会話は自動で保存され、関連する過去の会話も自動でClaudeに渡される。

- **Claudeに聞く**: 「前にこのプロジェクトで認証について話したよね？」のように聞くと、Claudeが自分で検索して答える
- **自分で探す**: `/recall 認証` で検索する。`/recall` だけなら、最近の会話を一覧表示する
- **その時点のコードを見る**: 「その会話のときのコードと今のコードの差分を見せて」のように頼むと、Claudeが記録されたコミットを使って `git diff` などで調べる
- **会話を消す**: 「この前の〇〇の会話を記憶から消して」とClaudeに頼む。実行前に確認ダイアログが出る

## modがすること

| いつ | すること |
|---|---|
| セッション開始時 | toolと `/recall` を登録する。Ollamaに埋め込みモデルを読み込ませておく |
| プロンプト送信時 | 関連する過去の会話を最大3件、Claudeだけが読むコンテキストに追加する。挨拶や短文、`/` で始まるコマンドでは何もしない |
| Claudeの応答が終わるたび（`Stop`）、圧縮の前（`PreCompact`）、セッション終了時（`SessionEnd`） | transcriptの差分を保存し、新しいメッセージをベクトル化する |

保存に失敗したときや、Ollamaにつながらずベクトル化を待っているメッセージがあるときは、プロンプトの下のステータス行に表示される。

### Claudeが使えるtool

| tool | 内容 |
|---|---|
| `search` | 過去の会話を、キーワードと意味の両方で検索する |
| `get_session` | 会話を時系列で読む。`around_uuid` を渡すと、ヒットしたメッセージの前後を返す |
| `list_sessions` | このプロジェクトの会話の一覧（タイトル・件数） |
| `delete_session` | 会話を削除する。実行前に確認ダイアログが出る |

modが登録したtoolは、Claude Codeの仕様で `mcp__conversation-memory__<name>` という名前になる。名前は `mcp__` で始まるが、MCPサーバーではない。

### 設定

Claude Codeの `/config` から変更できる。

| 項目 | 内容 | デフォルト |
|---|---|---|
| `autoContext` | 関連する会話を自動で添付する | `true` |
| `cliPath` | 別の場所の `dist/cli.js` を使うときのパス | 空（このリポジトリの `dist/cli.js` を使う） |
| `nodePath` | CLIを実行する `node` | `node` |

Node.jsのバージョンを切り替えて使っている場合（nvmなど）は、`nodePath` に `npm install` したときの `node` を指定する。`better-sqlite3` とLanceDBはネイティブモジュールで、Node.jsのバージョンに依存するため。

## プロジェクトの分離

1つのDBにすべてのプロジェクトの会話を保存し、プロジェクトごとに分けている。

| | 中身 | 変わるとき |
|---|---|---|
| `project_id`（識別に使う） | リポジトリの**最初のコミットのハッシュ** | 変わらない（下の表を参照） |
| `name`（表示に使う） | リポジトリ名（git remoteの名前。remoteがなければフォルダ名） | 使うたびに最新の名前に更新される |

最初のコミットはリポジトリの履歴の出発点なので、次のどれをしても同じプロジェクトとして扱われる。

- リポジトリ名の変更、ownerの変更
- フォルダの移動、別の場所へのclone、worktree
- remoteの追加や変更
- リポジトリのサブディレクトリでClaude Codeを起動する

同じプロジェクトとして扱われるもの、別になるもの:

- forkは元のリポジトリと同じ履歴を持つので、同じプロジェクトになる
- 履歴の最初のコミットを書き換えると（rebaseなど）、別のプロジェクトになる

検索は、今のセッションのプロジェクトだけが対象。Claudeにproject_idを選ばせないので、間違えて別のプロジェクトの記憶を読んだり消したりすることはない。他のプロジェクトの会話は、明示的に `all_projects: true` を指定したときだけ読める。削除は常に今のプロジェクトだけが対象。

### 会話を別のプロジェクトに移す

リポジトリを作り直したときなど、会話を別のプロジェクトに移したいときは `move-session` を使う。

```bash
node dist/cli.js move-session <セッションID> <移し先のリポジトリのディレクトリ>
```

- そのセッションのメッセージが、移し先のプロジェクトに付け替わる。コミットも移し先のリポジトリの履歴で計算し直す（移し先の最初のコミットより前のメッセージは「before first commit」になる）
- 移したあとにそのセッションで続けた会話も、移し先に保存される
- 移したことは記録され、`rebuild` しても保たれる
- セッションIDは `/recall` の一覧で確認できる

## 会話とコミットの対応

保存するメッセージごとに、`git_commit` を記録する。メッセージを書いた時刻に、そのブランチで最新だったコミット。

- 会話の途中でコミットした場合も、コミットの前のメッセージと後のメッセージで正しく分かれる
- まだ最初のコミットがなかった時刻のメッセージは `null`（検索結果では「before first commit」）
- コミットしていない変更があっても、記録されるのは直前のコミット

検索結果には `git_commit` が、会話の一覧には会話の最初と最後のコミット（`first_commit` / `last_commit`）が付く。

## データの保存場所

保存場所を指定しなければ、記憶はすべてホームディレクトリの `~/.claude-memory/` に作られる。どのプロジェクトで使っても同じ場所に保存され、プロジェクトのフォルダの中には何も作らない。

```
~/.claude-memory/
├── conversations.db     SQLite（会話の本文、キーワード検索）
└── vectors/             LanceDB（意味検索用のベクトル）
```

`conversations.db-wal` / `conversations.db-shm` が一緒にできることがある。SQLiteが書き込み中に使う作業用のファイル。

### 保存場所を変える

環境変数で場所を指定すると、そこに保存される。指定しなかったほうは `~/.claude-memory/` のまま。

| 変数 | 指定するもの | 指定しないとき |
|---|---|---|
| `CONV_MEMORY_DB` | SQLiteのファイルのパス | `~/.claude-memory/conversations.db` |
| `CONV_MEMORY_VECTORS` | LanceDBのディレクトリのパス | `~/.claude-memory/vectors` |

modはClaude Codeの環境変数を引き継いでCLIを動かすので、`~/.claude/settings.json` の `env` に書く:

```json
{
  "env": {
    "CONV_MEMORY_DB": "/path/to/memory/conversations.db",
    "CONV_MEMORY_VECTORS": "/path/to/memory/vectors"
  }
}
```

- フォルダがなければ自動で作られる
- CLIを手で実行するとき（`npm run backfill` など）も、同じ環境変数を設定しておく。設定しないと、デフォルトの `~/.claude-memory/` に別の記憶が作られてしまう
- 場所を変えても、前の場所のデータは移らない。引き継ぐなら、ファイルを新しい場所に移してから設定を変える

### 記憶を消す

- **一部の会話を消す**: Claudeに頼む（`delete_session`）
- **すべて消す**: Claude Codeを閉じてから、保存場所（デフォルトなら `~/.claude-memory/`）を削除する

このmodが読み取る元データとして、Claude Code自身も会話を `~/.claude/projects/<プロジェクト>/<セッションID>.jsonl` に保存している。これはClaude Codeが管理しているファイルで、このmodは書き換えも削除もしない。`npm run backfill` は、ここから会話を取り込む。

## しくみ

```
Claude Code
  └─ mod/conversation-memory（hooks/register.ts）
       │  $.process.run
       ▼
     dist/cli.js
       ├─▶ ~/.claude-memory/conversations.db（SQLite：会話の正本 + キーワード検索）
       └─▶ ~/.claude-memory/vectors（LanceDB：ベクトル）◀── Ollama（bge-m3）
```

modのコードからはNode.jsのAPIが使えず、DBを直接開けない。そのため、DBの操作はすべて同梱のCLIを起動して任せている。MCPサーバーは使っていない。

検索はキーワード検索（SQLite FTS5）と意味検索（Ollama + LanceDB）のハイブリッド。詳しくは [docs/vector-search.md](docs/vector-search.md) を参照。

### 保存するもの

- user / assistant のテキスト、tool呼び出しとtool結果（2000文字で切り詰める）
- メッセージごとのgitブランチとコミット
- セッションの情報: 作業ディレクトリ、gitブランチ、自動生成されたタイトル、開始・更新時刻
- テキストのメッセージごとのベクトル

保存しないもの: `<system-reminder>` などClaude Codeが挿入した文字列、thinking、コミットのあるgitリポジトリの外での会話

```
projects (id PK = 最初のコミットのハッシュ, name, root_path, git_remote)
  └─ sessions (session_id PK, project_id FK, cwd, git_branch, title, ...)
       └─ messages (id PK, uuid, project_id FK, session_id FK, role, kind, content, git_branch, git_commit, embedded_model, ...)
```

## CLI

modが内部で使うCLI。手で実行してもいい。検索系のコマンドは、stdinにJSONを渡すと結果をJSONで返す。

```
cli.js ingest            stdin: hook JSON ({ transcript_path, cwd })。取り込み後、新しいメッセージをベクトル化する
cli.js backfill [dir]    ~/.claude/projects 以下の会話をすべて取り込み、ベクトル化する
cli.js embed             まだベクトルのないメッセージをベクトル化する
cli.js warm              Ollamaに埋め込みモデルを読み込ませておく
cli.js rebuild           今のDBを backup-<時刻>/ に移し、すべての会話から作り直す（move-sessionの記録は引き継ぐ）
cli.js move-session <セッションID> <ディレクトリ>
                         セッションを、そのディレクトリのプロジェクトに移す
cli.js search            stdin: { cwd, query, include_tools?, all_projects?, exclude_session_id?, limit? }
cli.js related           stdin: { cwd, text, exclude_session_id?, limit?, min_coverage? }
cli.js get               stdin: { cwd, session_id, around_uuid?, window?, offset?, limit? }
cli.js list              stdin: { cwd, title_contains?, limit? }
cli.js delete            stdin: { cwd, session_id }
```

例:

```bash
echo '{"cwd":"'"$(pwd)"'","query":"認証方式"}' | node dist/cli.js search
```

## 環境変数

| 変数 | 内容 | デフォルト |
|---|---|---|
| `CONV_MEMORY_DB` | SQLiteのパス（[データの保存場所](#データの保存場所)） | `~/.claude-memory/conversations.db` |
| `CONV_MEMORY_VECTORS` | LanceDBのディレクトリ（[データの保存場所](#データの保存場所)） | `~/.claude-memory/vectors` |
| `PROJECT_ID` | 自動で決まるproject_idを上書きする（CLIの検索系コマンドのみ。`ingest` には効かない） | なし |

Ollamaの環境変数（`CONV_MEMORY_EMBED_MODEL`、`OLLAMA_HOST`）は [docs/vector-search.md](docs/vector-search.md#環境変数) を参照。

## 開発

```
src/
├── db.ts        SQLiteのスキーマ
├── ingest.ts    transcriptの差分取り込み
├── project.ts   project_idの判定（最初のコミット）
├── commits.ts   メッセージごとのコミットの判定
├── search.ts    ハイブリッド検索、セッションの取得・一覧・削除
├── embed.ts     Ollamaでのベクトル化
├── vectors.ts   LanceDBへの保存と検索
└── cli.ts       CLI
mod/conversation-memory/
├── .claude-plugin/plugin.json
└── hooks/
    ├── hooks.json
    ├── register.ts        mod本体
    └── register.test.ts   modのテスト
docs/
└── vector-search.md       Ollamaとベクトル検索の詳細
```

```bash
npm run build                                  # src/ → dist/
claude plugin validate mod/conversation-memory
claude plugin test mod/conversation-memory
```

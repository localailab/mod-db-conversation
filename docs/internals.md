# しくみと開発

modの内部構成、CLI、開発用のコマンド。使い方は [使い方](usage.md) を参照。

## 全体の構成

```
Claude Code
  └─ mod/conversation-memory（hooks/register.ts）
       │  $.process.run（環境変数 CONV_MEMORY_STORAGE で保存モードを渡す）
       ▼
     dist/cli.js
       ├─▶ conversations.db（SQLite：会話の正本 + キーワード検索）
       └─▶ vectors/（LanceDB：ベクトル）◀── Ollama（bge-m3）
```

DBの場所は保存モードで決まる（`shared`: `~/.claude-memory/`、`repo`: `<リポジトリ>/.claude/conversation-memory/`）。詳しくは [保存モードとデータ](storage.md)。

modのコードからはNode.jsのAPIが使えず、DBを直接開けない。そのため、DBの操作はすべて同梱のCLIを起動して任せている。MCPサーバーは使っていない。

検索はキーワード検索（SQLite FTS5）と意味検索（Ollama + LanceDB）のハイブリッド。詳しくは [ベクトル検索](vector-search.md) を参照。

## 保存するもの

- user / assistant のテキスト、tool呼び出しとtool結果（2000文字で切り詰める）
- メッセージごとのgitブランチとコミット
- assistantのメッセージごとの、答えたモデル
- セッションの情報: 作業ディレクトリ、gitブランチ、自動生成されたタイトル、開始・更新時刻
- テキストのメッセージごとのベクトル

保存しないもの: `<system-reminder>` などClaude Codeが挿入した文字列、thinking、コミットのあるgitリポジトリの外での会話、`repo` モードでの他のリポジトリの会話

テーブルとカラムの詳細は [DB構成](database.md) を参照。

## CLI

modが内部で使うCLI。手で実行してもいい。検索系のコマンドは、stdinにJSONを渡すと結果をJSONで返す。

```
cli.js ingest            stdin: { transcript_path, cwd, root? }。取り込み後、新しいメッセージをベクトル化する
cli.js backfill [dir]    ~/.claude/projects 以下の会話をすべて取り込み、ベクトル化する
cli.js embed             まだベクトルのないメッセージをベクトル化する
cli.js warm              Ollamaに埋め込みモデルを読み込ませておく
cli.js rebuild           今のDBを backup-<時刻>/ に移し、すべての会話から作り直す（move-sessionの記録は引き継ぐ）
cli.js move-session <セッションID> <ディレクトリ>
                         セッションを、そのディレクトリのプロジェクトに移す（shared モードのみ）
cli.js search            stdin: { cwd, query, include_tools?, exclude_session_id?, limit? }
cli.js related           stdin: { cwd, text, exclude_session_id?, limit?, min_coverage? }
cli.js get               stdin: { cwd, session_id, around_uuid?, window?, offset?, limit? }
cli.js list              stdin: { cwd, title_contains?, limit? }
cli.js delete            stdin: { cwd, session_id }
```

`repo` モード（`CONV_MEMORY_STORAGE=repo`）では、使うDBを次の順で決める: stdinの `root`、stdinの `cwd`、CLIを実行したディレクトリ。`backfill` / `rebuild` / `embed` は、対象のリポジトリのルートで実行する。

例:

```bash
echo '{"cwd":"'"$(pwd)"'","query":"認証方式"}' | node dist/cli.js search
```

## 環境変数

| 変数 | 内容 | デフォルト |
|---|---|---|
| `CONV_MEMORY_STORAGE` | 保存モード（`shared` / `repo`）。modは `/config` の `storage` をこの変数で渡す。CLIを手で実行するときは自分で指定する | `shared` |
| `CONV_MEMORY_DB` | SQLiteのパス（`shared` モードのみ。[保存場所](storage.md#保存場所)） | `~/.claude-memory/conversations.db` |
| `CONV_MEMORY_VECTORS` | LanceDBのディレクトリ（`shared` モードのみ） | `~/.claude-memory/vectors` |
| `PROJECT_ID` | 自動で決まるproject_idを上書きする（`shared` モードの検索系コマンドのみ。`ingest` には効かない） | なし |

Ollamaの環境変数（`CONV_MEMORY_EMBED_MODEL`、`OLLAMA_HOST`）は [ベクトル検索](vector-search.md#環境変数) を参照。

## 開発

```
src/
├── storage.ts   保存モードと保存場所の決定（repo モードの .gitignore と確認も）
├── db.ts        SQLiteのスキーマ、移行、repo モードの持ち主の確認
├── ingest.ts    transcriptの差分取り込み、モデル名の埋め直し
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
docs/                      ドキュメント（README の目次から辿れる）
```

```bash
npm run build                                  # src/ → dist/
claude plugin validate mod/conversation-memory
claude plugin test mod/conversation-memory
```

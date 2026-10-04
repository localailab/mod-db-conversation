# 保存モードとデータ

会話をどこに保存し、プロジェクトをどう分けるか。設定の手順は [セットアップ](setup.md#3-保存モードを選ぶ) を参照。

## 2つのモード

どちらのモードでも、保存も検索も削除も、今のリポジトリの会話だけが対象。他のリポジトリの会話を読む機能はない。違うのは、保存の仕方と、混ざらないことをどう保証するか。

| | `shared`（デフォルト） | `repo` |
|---|---|---|
| 保存先 | `~/.claude-memory/` の1つのDB | 各リポジトリの `.claude/conversation-memory/` |
| プロジェクトの分け方 | DBの中で、識別子（`project_id`）で絞り込む | DBのファイルそのものが分かれる |
| 混ざらないことの保証 | プログラムが正しく絞り込むこと | 他のリポジトリのDBを開かないこと |
| 管理（バックアップ、作り直し） | 1か所で済む | リポジトリごと |
| 会話を別のプロジェクトに移す（`move-session`） | できる | できない |
| リポジトリを削除したとき | 会話は残る | 会話も一緒に消える |
| 設定 | 要らない | `/config` で `storage` を `repo` にする |

**どちらを選ぶか**:

- 全プロジェクトの記憶を1か所でまとめて管理したい → `shared`
- 仕事と私用のリポジトリを同じマシンで扱うなど、会話が混ざらないことをファイルの単位で確実にしたい → `repo`

`shared` でも、すべての読み書きを今のプロジェクトに絞り込んでいる。ただ、分けているのはDBの中の絞り込みなので、プログラムに不具合があれば混ざる可能性は残る。`repo` は、他のリポジトリのDBをそもそも開かないので、そうした不具合があっても混ざらない。

モードは `/config` の `storage` で、すべてのプロジェクトに共通で設定する。

## プロジェクトの識別

どちらのモードでも、プロジェクトはリポジトリの**最初のコミットのハッシュ**で識別する。

| | 中身 | 変わるとき |
|---|---|---|
| `project_id`（識別に使う） | リポジトリの最初のコミットのハッシュ | 変わらない（下を参照） |
| `name`（表示に使う） | リポジトリ名（git remoteの名前。remoteがなければフォルダ名） | 使うたびに最新の名前に更新される |

最初のコミットはリポジトリの履歴の出発点なので、次のどれをしても同じプロジェクトとして扱われる。

- リポジトリ名の変更、ownerの変更
- フォルダの移動、別の場所へのclone、worktree
- remoteの追加や変更
- リポジトリのサブディレクトリでClaude Codeを起動する

同じプロジェクトとして扱われるもの、別になるもの:

- forkは元のリポジトリと同じ履歴を持つので、同じプロジェクトになる
- 履歴の最初のコミットを書き換えると（rebaseなど）、別のプロジェクトになる

`repo` モードでは、DBに持ち主のリポジトリの `project_id` を記録する。違う `project_id` のリポジトリからそのDBを開こうとすると、拒否する（フォルダをコピーした場合など）。

### `shared` モードでの分離

保存、検索、一覧、削除のすべてを、今のセッションのプロジェクトに絞り込む。Claudeにproject_idを選ばせないので、間違えて別のプロジェクトの記憶を読んだり消したりすることはない。

### `repo` モードでの分離

セッションを起動したリポジトリのDBだけを開く。

- **保存**: そのリポジトリの会話だけを保存する。セッションの途中で別のリポジトリのフォルダに移って会話しても、その部分は保存しない
- **検索**: そのDBの中だけを探す
- **DBの置き場所**: `.claude/conversation-memory/` の中に `*` だけの `.gitignore` を置き、中身がgitに入らないようにする。さらに保存する前に毎回 `git check-ignore` で確かめて、gitに入る状態なら保存を止める

## 会話とコミット、モデルの対応

保存するメッセージごとに、次の2つを記録する。

- **`git_commit`**: メッセージを書いた時刻に、そのブランチで最新だったコミット
  - 会話の途中でコミットした場合も、コミットの前のメッセージと後のメッセージで正しく分かれる
  - まだ最初のコミットがなかった時刻のメッセージは `null`（検索結果では「before first commit」）
  - コミットしていない変更があっても、記録されるのは直前のコミット
- **`model`**: assistantのメッセージを書いたモデル（例: `claude-opus-5-5`）
  - Claude Codeのtranscriptに残る、APIが返したモデル名を使う。Claude自身の申告ではない
  - userのメッセージは空。どのモデルに送ったかは、直後のassistantのメッセージで分かる
  - `<synthetic>` は、中断やエラーのときにClaude Code自身が書いたメッセージ

検索結果には `git_commit` と `model` が、会話の一覧には会話の最初と最後のコミット（`first_commit` / `last_commit`）と、答えたモデルの一覧（`models`）が付く。

## 保存場所

### `shared` モード

```
~/.claude-memory/
├── conversations.db     SQLite（会話の本文、キーワード検索）
└── vectors/             LanceDB（意味検索用のベクトル）
```

環境変数で場所を変えられる。指定しなかったほうは `~/.claude-memory/` のまま。

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

### `repo` モード

```
<リポジトリ>/.claude/conversation-memory/
├── .gitignore           中身は「*」
├── conversations.db
└── vectors/
```

場所は固定で、`CONV_MEMORY_DB` / `CONV_MEMORY_VECTORS` は効かない。

どちらのモードでも、`conversations.db-wal` / `conversations.db-shm` が一緒にできることがある。SQLiteが書き込み中に使う作業用のファイル。

## モードを切り替えるとき

モードを変えても、前のモードのDBの中身は移らない。前のDBは消さずにそのまま残るので、戻せばまた使える。

- **`shared` → `repo`**: 各リポジトリのルートで `CONV_MEMORY_STORAGE=repo node /path/to/mod-db-conversation/dist/cli.js backfill` を実行すると、Claude Codeのtranscriptからそのリポジトリの会話を取り込める。ただし、`move-session` で付け替えた会話は取り込まれない（元の作業フォルダのプロジェクトとして扱われるため）
- **`repo` → `shared`**: `npm run backfill` で、すべての会話を `~/.claude-memory/` に取り込める

どちらも、元になるのはClaude Code自身が保存しているtranscript（`~/.claude/projects/` の下）。削除されたtranscriptの会話は取り込めない。

## 会話を別のプロジェクトに移す（`shared` モードのみ）

リポジトリを作り直したときなど、会話を別のプロジェクトに移したいときは `move-session` を使う。

```bash
node dist/cli.js move-session <セッションID> <移し先のリポジトリのディレクトリ>
```

- そのセッションのメッセージが、移し先のプロジェクトに付け替わる。コミットも移し先のリポジトリの履歴で計算し直す（移し先の最初のコミットより前のメッセージは「before first commit」になる）
- 移したあとにそのセッションで続けた会話も、移し先に保存される
- 移したことは記録され、`rebuild` しても保たれる
- セッションIDは `/recall` の一覧で確認できる

## 記憶を消す

- **一部の会話を消す**: Claudeに頼む（`delete_session`）
- **すべて消す**: Claude Codeを閉じてから、保存場所を削除する
  - `shared`: `~/.claude-memory/`（場所を変えていればその場所）
  - `repo`: 各リポジトリの `.claude/conversation-memory/`

このmodが読み取る元データとして、Claude Code自身も会話を `~/.claude/projects/<プロジェクト>/<セッションID>.jsonl` に保存している。これはClaude Codeが管理しているファイルで、このmodは書き換えも削除もしない。`backfill` は、ここから会話を取り込む。

# opencode-energy-logger

opencode plugin that logs the energy usage of your sessions.

## Turning energy tracking on/off

<!--
Energy logging can be toggled per folder with the `/energy` command or the
icon in opencode's footer status bar. The state is looked up at the root of the git
repository containing the folder (the folder itself outside a repository),
from the first of:

1. `.energy.local.json` — per machine override, written by every
   toggle. Inside a repository the path is appended to `.gitignore` when
   first written, a one time change to commit, so the override stays out of
   `git status` in every clone. The file sits at the root of the repository
   rather than in `.opencode/`: opencode watches that directory as part of
   its config, and the reload a write there triggers would race the
   toggle's own reply, leaving the footer icon showing the previous state.
2. `.energy.json` — committed default shared with the repository:

   ```json
   { "enabled": false }
   ```

3. the `defaultEnabled` plugin option, which defaults to `true`.
-->

## Where the energy records go

<!--
While capturing, every record is mirrored into `.energy/<sessionID>.jsonl` at
the root of the git repository containing the folder: one JSON object per
line, one file per session. Every record carries an `id` — the md5 of the
whole record — so copies of one record stay recognisable across branches
and machines, while distinct captures can never share one. The files grow by appending each record and are
staged with `git add .energy`, coalesced to at most one run per half second,
so they ride along with the next commit, merge like any other file when
branches or pull requests come together, and are visible to reviewers right in
the diff.

Two small files inside `.energy` are written once and are meant to be
committed with it:

1. `.gitattributes` marks the record files `merge=union`, so branches that
   logged the same session merge their lines instead of conflicting. Union
   merges can interleave or repeat lines, so readers order records by their
   `time` and deduplicate by their `id`.
2. `.gitignore` keeps the temporary files of the atomic writes out of the
   repository.

The durable source of truth for a session stays outside the repository, at
`$XDG_STATE_HOME/opencode-energy-logger/sessions/<repository>/<sessionID>.jsonl`,
scoped to the repository the records were made in so one repository never sees
another's records. The `.energy` files mirror it record by record and —
whenever they stop matching the file the plugin last wrote, after a
`git reset --hard`, a branch switch or a merge replaced them — are rebuilt as
the merge of the durable state and the copy in git, so neither local records
nor records that arrived through pulls and merges can be lost. A session
spanning a branch switch writes its growing file on both branches — exactly
the shape the union merge resolves — and when the session's writes are flushed
the local view copies are deduplicated, so duplicates a union merge left
behind are gone before the next commit. The flush runs when the plugin
unloads, after waiting for the body scans of the responses still streaming,
so records from requests in flight at shutdown land too. Outside a git
repository only the state directory is written.

Do not add `.energy` to an ignore file: the records are meant to be committed
with the code they describe. An ignored `.energy` directory is reported to
the debug log, which the `ENERGY_LOGGER_DEBUG` environment variable enables.
-->

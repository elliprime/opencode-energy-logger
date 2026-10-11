# opencode-energy-logger

opencode plugin that logs the energy usage of your sessions.

## Turning energy tracking on/off

<!--
Energy logging can be toggled per folder with the `/energy` command or the
icon in opencode's footer status bar. The state is looked up at the root of the git
repository containing the folder (the folder itself outside a repository),
from the first of:

1. `.opencode/energy.local.json` — per machine override, written by every
   toggle. Inside a repository the path is appended to `.gitignore` when
   first written, a one time change to commit, so the override stays out of
   `git status` in every clone.
2. `.opencode/energy.json` — committed default shared with the repository:

   ```json
   { "enabled": false }
   ```

3. the `defaultEnabled` plugin option, which defaults to `true`.
-->

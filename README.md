# opencode-energy-logger

opencode plugin that logs the energy usage of your sessions to a folder in your git repo in
order to provide transparency in exactly how AI was used during development.

**Note: energy records include prompt text to show how AI was used.** Prompt responses
are considered too large to track.

**Currently this plugin will only work with [Neuralwatt](https://neuralwatt.com), since they
are the only provider that actually exposes energy usage.**

## Turning energy tracking on/off

Energy logging can be toggled per git repository by clicking the lightning icon in
opencode's footer status bar (visible after the plugin is activated).

Energy logging can also be toggled via the `/energy` command.

The toggle state is sourced from two files:

1. `.energy.json` - stores the default setting for a repository, committed to git.
2. `.energy.local.json` - stores the current machine's override and gitignored. Each toggle
  in opencode writes to this file.

A default can also be supplied viar the `defaultEnabled` plugin option in opencode's own
config.

## Where the energy records go

Energy records are logged to *.jsonl files in the `.energy/` directory at the root
of the current git repository. Each file consists of JSON objects, one per line, and
each file is named after the ID of the opencode session that logged it.

Do not add `.energy` to an ignore file: the records are meant to be committed
with the code they were logged for.

## Viewing energy logs

A small local viewer is included in this repository in the `viewer/` directory. To
start it, run the following commands from the root of this repository:

```bash
cd ./viewer
npm install
npm run dev
```

Then open http://localhost:3000.

The viewer lets you upload archives with energy logs, or an archive with a .energy/ directory.
You can also use a link to a Github or Forgejo repository (the repository archive will be
downloaded).

Once energy logs are loaded into the app, perspective.js is used to allow you to explore the data
freely.

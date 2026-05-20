# branchstash

Sync selected ignored files and directories into newly created Git worktrees.

Useful for local files that Git does not track, such as `.env`, `.env.local`, `node_modules`, or `.turbo`.

## Install

```sh
pnpm add -D branchstash
```

## Configure

Create the default config:

```sh
pnpm branchstash init
```

This adds a minimal `package.json` block:

```json
{
  "branchstash": {
    "files": {
      ".env": "link",
      "node_modules": "copy"
    }
  }
}
```

Supported strategies:

- `copy`: create an independent copy, using CoW/reflink when possible
- `link`: create a symlink to the source worktree path

## Install Hook

```sh
pnpm branchstash install
```

This installs a `post-checkout` Git hook that delegates to the installed CLI with an absolute path:

```sh
node "/absolute/path/to/branchstash/dist/cli.js" run "$@"
```

The hook is idempotent and preserves unrelated existing hook content where possible.

## Run

Create a worktree normally:

```sh
git worktree add ../project-feature -b feature/my-feature
```

The hook runs automatically for newly created worktrees.

You can also run manually:

```sh
pnpm branchstash run
```

Manual runs are useful if the hook was not installed yet, config changed, or files were deleted.

## Behavior

- Source is the main worktree from `git worktree list --porcelain`.
- Target is the current worktree.
- Only explicitly configured paths are synced.
- Missing source paths are skipped.
- Existing target paths are skipped.
- Targets are never overwritten by default.

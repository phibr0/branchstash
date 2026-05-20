import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import {
  lstat,
  mkdtemp,
  mkdir,
  readFile,
  readlink,
  realpath,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";

import { initCommand, installCommand, runCommand, upsertHook } from "./cli.js";

const execFileAsync = promisify(execFile);

test("upsertHook creates and updates a marker block idempotently", () => {
  const command = "node '/repo/node_modules/branchstash/dist/cli.js' run \"$@\"";
  const first = upsertHook("", command);
  const second = upsertHook(first, command);
  const replaced = upsertHook(
    `#!/usr/bin/env sh\n${first.replace(command, "old-command")}\n`,
    command,
  );

  assert.equal(first, second);
  assert.match(first, /^#!\/usr\/bin\/env sh\n/);
  assert.match(
    first,
    /# branchstash:start\nnode '\/repo\/node_modules\/branchstash\/dist\/cli\.js' run "\$@"\n# branchstash:end\n$/,
  );
  assert.doesNotMatch(replaced, /old-command/);
});

test("initCommand adds default config without overwriting existing config", async () => {
  const cwd = await mkdtemp(path.join(tmpdir(), "branchstash-init-"));
  const packagePath = path.join(cwd, "package.json");

  await writeFile(packagePath, `${JSON.stringify({ name: "fixture" }, null, 2)}\n`);
  await initCommand(cwd);

  const initialized = JSON.parse(await readFile(packagePath, "utf8"));
  assert.deepEqual(initialized["branchstash"], {
    files: {
      ".env": "link",
      node_modules: "copy",
    },
  });

  initialized["branchstash"].files[".env"] = "link";
  await writeFile(packagePath, `${JSON.stringify(initialized, null, 2)}\n`);
  await initCommand(cwd);

  const preserved = JSON.parse(await readFile(packagePath, "utf8"));
  assert.equal(preserved["branchstash"].files[".env"], "link");
});

test("initCommand fails without an existing package.json", async () => {
  const cwd = await mkdtemp(path.join(tmpdir(), "branchstash-init-missing-"));

  await assert.rejects(initCommand(cwd), /no package\.json found; run this from the project root/);
});

test("installCommand preserves existing hook content", async () => {
  const repo = await createRepo("branchstash-install-");
  const hookPath = path.join(repo, ".git", "hooks", "post-checkout");

  await writeFile(hookPath, "#!/usr/bin/env sh\nprintf 'existing'\n");
  await installCommand(repo);
  await installCommand(repo);

  const hook = await readFile(hookPath, "utf8");
  assert.match(hook, /printf 'existing'/);
  assert.match(hook, /node '.*\/dist\/cli\.js' run "\$@"/);
  assert.equal(hook.match(/# branchstash:start/g)?.length, 1);
  assert.equal((await stat(hookPath)).mode & 0o111, 0o111);
});

test("runCommand copies and links configured paths from the main worktree", async () => {
  const repo = await createRepo("branchstash-run-");
  const linkedSource = path.join(repo, ".env.shared");
  const worktree = `${repo}-feature-worktree`;

  await writeFile(
    path.join(repo, "package.json"),
    `${JSON.stringify(
      {
        name: "fixture",
        branchstash: {
          files: {
            ".env": "copy",
            ".env.shared": "link",
            node_modules: "copy",
            "missing.local": "copy",
          },
        },
      },
      null,
      2,
    )}\n`,
  );
  await writeFile(path.join(repo, ".env"), "LOCAL=1\n");
  await writeFile(linkedSource, "SHARED=1\n");
  await mkdir(path.join(repo, "node_modules", "fixture"), { recursive: true });
  await writeFile(path.join(repo, "node_modules", "fixture", "index.js"), "module.exports = 1;\n");
  await git(repo, ["add", "package.json"]);
  await git(repo, ["commit", "-m", "initial"]);
  await git(repo, ["worktree", "add", worktree, "-b", "feature"]);

  const result = await runCommand([], worktree);

  assert.deepEqual(result?.copied.sort(), [".env", "node_modules"]);
  assert.deepEqual(result?.linked, [".env.shared"]);
  assert.deepEqual(result?.skipped, ["missing.local: source does not exist"]);
  assert.equal(await readFile(path.join(worktree, ".env"), "utf8"), "LOCAL=1\n");
  assert.equal(
    await readFile(path.join(worktree, "node_modules", "fixture", "index.js"), "utf8"),
    "module.exports = 1;\n",
  );
  assert.equal(await realpath(path.join(worktree, ".env.shared")), await realpath(linkedSource));

  await writeFile(path.join(repo, ".env"), "CHANGED=1\n");
  assert.equal(await readFile(path.join(worktree, ".env"), "utf8"), "LOCAL=1\n");
});

test("hook arguments only run for new worktree checkout", async () => {
  const repo = await createRepo("branchstash-hook-args-");
  const worktree = `${repo}-hook-worktree`;

  await writeFile(
    path.join(repo, "package.json"),
    `${JSON.stringify(
      {
        branchstash: { files: { ".env": "copy" } },
      },
      null,
      2,
    )}\n`,
  );
  await writeFile(path.join(repo, ".env"), "LOCAL=1\n");
  await git(repo, ["add", "package.json"]);
  await git(repo, ["commit", "-m", "initial"]);
  await git(repo, ["worktree", "add", worktree, "-b", "hook"]);

  const skipped = await runCommand(["not-zero", "HEAD", "1"], worktree);
  assert.equal(skipped, undefined);

  const result = await runCommand(
    ["0000000000000000000000000000000000000000", "HEAD", "1"],
    worktree,
  );
  assert.deepEqual(result?.copied, [".env"]);
});

test("runCommand rejects invalid config values", async () => {
  const repo = await createRepo("branchstash-invalid-config-");

  await writeFile(
    path.join(repo, "package.json"),
    `${JSON.stringify({ branchstash: { files: { ".env": "move" } } }, null, 2)}\n`,
  );

  await assert.rejects(
    runCommand([], repo),
    /package\.json must contain a branchstash\.files config with copy\/link values/,
  );
});

test("runCommand rejects malformed package.json", async () => {
  const repo = await createRepo("branchstash-malformed-json-");

  await writeFile(path.join(repo, "package.json"), "{ not json }\n");

  await assert.rejects(runCommand([], repo), /Expected property name|Unexpected token/);
});

test("runCommand rejects configured paths outside a relative file path", async () => {
  const repo = await createRepo("branchstash-invalid-path-");

  await writeFile(
    path.join(repo, "package.json"),
    `${JSON.stringify({ branchstash: { files: { ".": "copy" } } }, null, 2)}\n`,
  );

  await assert.rejects(runCommand([], repo), /invalid configured path: \./);
});

test("runCommand skips existing target paths", async () => {
  const repo = await createRepo("branchstash-existing-target-");
  const worktree = `${repo}-existing-target-worktree`;

  await writeFile(
    path.join(repo, "package.json"),
    `${JSON.stringify({ branchstash: { files: { ".env": "copy" } } }, null, 2)}\n`,
  );
  await writeFile(path.join(repo, ".env"), "SOURCE=1\n");
  await git(repo, ["add", "package.json"]);
  await git(repo, ["commit", "-m", "initial"]);
  await git(repo, ["worktree", "add", worktree, "-b", "existing-target"]);
  await writeFile(path.join(worktree, ".env"), "TARGET=1\n");

  const result = await runCommand([], worktree);

  assert.deepEqual(result?.skipped, [".env: target already exists"]);
  assert.equal(await readFile(path.join(worktree, ".env"), "utf8"), "TARGET=1\n");
});

test("runCommand creates parent directories for nested configured paths", async () => {
  const repo = await createRepo("branchstash-nested-path-");
  const worktree = `${repo}-nested-path-worktree`;

  await writeFile(
    path.join(repo, "package.json"),
    `${JSON.stringify({ branchstash: { files: { "config/local/.env": "copy" } } }, null, 2)}\n`,
  );
  await mkdir(path.join(repo, "config", "local"), { recursive: true });
  await writeFile(path.join(repo, "config", "local", ".env"), "NESTED=1\n");
  await git(repo, ["add", "package.json"]);
  await git(repo, ["commit", "-m", "initial"]);
  await git(repo, ["worktree", "add", worktree, "-b", "nested-path"]);

  const result = await runCommand([], worktree);

  assert.deepEqual(result?.copied, ["config/local/.env"]);
  assert.equal(
    await readFile(path.join(worktree, "config", "local", ".env"), "utf8"),
    "NESTED=1\n",
  );
});

test("runCommand preserves copied symlinked directories", async () => {
  const repo = await createRepo("branchstash-copy-symlink-dir-");
  const worktree = `${repo}-copy-symlink-dir-worktree`;

  await writeFile(
    path.join(repo, "package.json"),
    `${JSON.stringify({ branchstash: { files: { "linked-dir": "copy" } } }, null, 2)}\n`,
  );
  await mkdir(path.join(repo, "real-dir"));
  await writeFile(path.join(repo, "real-dir", "value.txt"), "VALUE=1\n");
  await symlink("real-dir", path.join(repo, "linked-dir"), "dir");
  await git(repo, ["add", "package.json"]);
  await git(repo, ["commit", "-m", "initial"]);
  await git(repo, ["worktree", "add", worktree, "-b", "copy-symlink-dir"]);

  const result = await runCommand([], worktree);
  const copiedLink = path.join(worktree, "linked-dir");

  assert.deepEqual(result?.copied, ["linked-dir"]);
  assert.equal((await lstat(copiedLink)).isSymbolicLink(), true);
  assert.equal(await readlink(copiedLink), "real-dir");
});

test("runCommand links configured directories", async () => {
  const repo = await createRepo("branchstash-link-dir-");
  const worktree = `${repo}-link-dir-worktree`;

  await writeFile(
    path.join(repo, "package.json"),
    `${JSON.stringify({ branchstash: { files: { ".cache": "link" } } }, null, 2)}\n`,
  );
  await mkdir(path.join(repo, ".cache"));
  await writeFile(path.join(repo, ".cache", "value.txt"), "VALUE=1\n");
  await git(repo, ["add", "package.json"]);
  await git(repo, ["commit", "-m", "initial"]);
  await git(repo, ["worktree", "add", worktree, "-b", "link-dir"]);

  const result = await runCommand([], worktree);

  assert.deepEqual(result?.linked, [".cache"]);
  assert.equal(
    await realpath(path.join(worktree, ".cache")),
    await realpath(path.join(repo, ".cache")),
  );
});

test("installCommand works from a linked worktree", async () => {
  const repo = await createRepo("branchstash-install-linked-worktree-");
  const worktree = `${repo}-install-linked-worktree`;

  await writeFile(
    path.join(repo, "package.json"),
    `${JSON.stringify({ name: "fixture" }, null, 2)}\n`,
  );
  await git(repo, ["add", "package.json"]);
  await git(repo, ["commit", "-m", "initial"]);
  await git(repo, ["worktree", "add", worktree, "-b", "install-linked-worktree"]);

  await installCommand(worktree);

  const hooksDir = path.resolve(
    worktree,
    (await git(worktree, ["rev-parse", "--git-path", "hooks"])).trim(),
  );
  const hook = await readFile(path.join(hooksDir, "post-checkout"), "utf8");
  assert.match(hook, /node '.*\/dist\/cli\.js' run "\$@"/);
});

test("runCommand rejects when Git commands fail", async () => {
  const cwd = await mkdtemp(path.join(tmpdir(), "branchstash-not-git-"));

  await assert.rejects(runCommand([], cwd), /not a git repository|Command failed/);
});

async function createRepo(prefix: string): Promise<string> {
  const repo = await mkdtemp(path.join(tmpdir(), prefix));

  await git(repo, ["init", "-b", "main"]);
  await git(repo, ["config", "user.email", "test@example.com"]);
  await git(repo, ["config", "user.name", "Test User"]);
  return repo;
}

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", args, { cwd });
  return stdout;
}

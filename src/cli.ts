#!/usr/bin/env node

import { constants } from "node:fs";
import { chmod, cp, lstat, mkdir, readFile, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { execFile as execFileCB } from "node:child_process";
import { promisify } from "node:util";

const execFile = promisify(execFileCB);

const CONFIG_KEY = "branchstash";
const ZERO_REF = "0000000000000000000000000000000000000000";
const HOOK_START = "# branchstash:start";
const HOOK_END = "# branchstash:end";
const GIT_TIMEOUT_MS = 5_000;
const DEFAULT_CONFIG: BranchstashConfig = {
  files: {
    ".env": "link",
    node_modules: "copy",
  },
};

type Strategy = "copy" | "link";

type BranchstashConfig = {
  files: Record<string, Strategy>;
};

type PackageJson = Record<string, unknown> & {
  [CONFIG_KEY]?: unknown;
};

type SyncResult = {
  copied: string[];
  linked: string[];
  skipped: string[];
  warnings: string[];
};

export async function main(argv = process.argv.slice(2), cwd = process.cwd()): Promise<void> {
  const [command, ...args] = argv;

  try {
    if (command === "init") {
      await initCommand(cwd);
      return;
    }

    if (command === "install") {
      await installCommand(cwd);
      return;
    }

    if (command === "run") {
      await runCommand(args, cwd);
      return;
    }

    printUsage(command);
    process.exitCode = command ? 1 : 0;
  } catch (error) {
    console.error(`branchstash: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}

export async function initCommand(cwd: string): Promise<void> {
  const packagePath = path.join(cwd, "package.json");
  const packageJson = await readPackageJsonForInit(packagePath);

  if (packageJson[CONFIG_KEY] !== undefined) {
    console.log("branchstash: package.json already has a branchstash config");
    return;
  }

  packageJson[CONFIG_KEY] = DEFAULT_CONFIG;
  await writeFile(packagePath, `${JSON.stringify(packageJson, null, 2)}\n`);
  console.log("branchstash: added default branchstash config to package.json");
}

export async function installCommand(cwd: string): Promise<void> {
  const hooksDir = await git(cwd, ["rev-parse", "--git-path", "hooks"]);
  const resolvedHooksDir = path.resolve(cwd, hooksDir.trim());
  const hookPath = path.join(resolvedHooksDir, "post-checkout");

  await mkdir(resolvedHooksDir, { recursive: true });

  const existing = await readOptionalFile(hookPath);
  const cliPath = fileURLToPath(import.meta.url);
  const next = upsertHook(existing ?? "", `node '${cliPath.replaceAll("'", "'\\''")}' run "$@"`);

  await writeFile(hookPath, next, { mode: 0o755 });
  await chmod(hookPath, 0o755);
  console.log(`branchstash: installed post-checkout hook at ${hookPath}`);
}

export async function runCommand(args: string[], cwd: string): Promise<SyncResult | undefined> {
  const [oldHead, , checkoutFlag] = args;
  if (args.length > 0 && !(oldHead === ZERO_REF && checkoutFlag === "1")) {
    return undefined;
  }

  const targetWorktree = await git(cwd, ["rev-parse", "--show-toplevel"]);
  const target = targetWorktree.trim();

  const output = await git(cwd, ["worktree", "list", "--porcelain"]);
  const match = output.match(/^worktree (.+)$/m);
  if (!match?.[1]) {
    throw new Error("could not determine main worktree from git worktree list --porcelain");
  }
  const source = match[1];

  const config = await readConfig(path.join(target, "package.json"));

  console.log(`branchstash: source worktree ${source}`);
  console.log(`branchstash: target worktree ${target}`);
  console.log("");

  const result: SyncResult = { copied: [], linked: [], skipped: [], warnings: [] };

  for (const [relativePath, strategy] of Object.entries(config.files)) {
    if (
      relativePath === "" ||
      relativePath === "." ||
      path.isAbsolute(relativePath) ||
      relativePath.split(/[\\/]/).includes("..")
    ) {
      throw new Error(`invalid configured path: ${relativePath}`);
    }

    const sourcePath = path.join(source, relativePath);
    const targetPath = path.join(target, relativePath);

    if (!(await pathExists(sourcePath))) {
      result.skipped.push(`${relativePath}: source does not exist`);
      console.log(`skipped ${relativePath}: source does not exist`);
      continue;
    }

    if (await pathExists(targetPath)) {
      result.skipped.push(`${relativePath}: target already exists`);
      console.log(`skipped ${relativePath}: target already exists`);
      continue;
    }

    await mkdir(path.dirname(targetPath), { recursive: true });

    if (strategy === "copy") {
      await cp(sourcePath, targetPath, {
        recursive: true,
        force: false,
        errorOnExist: true,
        dereference: false,
        verbatimSymlinks: true,
        mode: constants.COPYFILE_FICLONE,
      });
      result.copied.push(relativePath);
      console.log(`copied ${relativePath}`);
      continue;
    }

    const symlinkType = (await lstat(sourcePath)).isDirectory() ? "dir" : "file";
    await symlink(sourcePath, targetPath, symlinkType);
    result.linked.push(relativePath);
    console.log(`linked ${relativePath}`);
  }

  return result;
}

export function upsertHook(existing: string, command = 'branchstash run "$@"'): string {
  const block = `${HOOK_START}\n${command}\n${HOOK_END}`;
  const normalized = existing.replace(/\r\n/g, "\n");
  const markerPattern = new RegExp(
    `${escapeRegExp(HOOK_START)}[\\s\\S]*?${escapeRegExp(HOOK_END)}`,
  );

  if (markerPattern.test(normalized)) {
    return ensureTrailingNewline(normalized.replace(markerPattern, block));
  }

  const withShebang =
    normalized.trim().length === 0
      ? "#!/usr/bin/env sh\n"
      : normalized.startsWith("#!")
        ? ensureTrailingNewline(normalized)
        : `#!/usr/bin/env sh\n${ensureTrailingNewline(normalized)}`;

  return `${ensureTrailingNewline(withShebang)}${block}\n`;
}

async function readConfig(packagePath: string): Promise<BranchstashConfig> {
  const packageJson = JSON.parse(await readFile(packagePath, "utf8")) as PackageJson;
  const config = packageJson[CONFIG_KEY];

  if (!isConfig(config)) {
    throw new Error("package.json must contain a branchstash.files config with copy/link values");
  }

  return config;
}

async function readPackageJsonForInit(packagePath: string): Promise<PackageJson> {
  if (!(await pathExists(packagePath))) {
    throw new Error("no package.json found; run this from the project root");
  }

  return JSON.parse(await readFile(packagePath, "utf8")) as PackageJson;
}

function isConfig(value: unknown): value is BranchstashConfig {
  if (!value || typeof value !== "object") {
    return false;
  }

  const files = (value as { files?: unknown }).files;
  if (!files || typeof files !== "object" || Array.isArray(files)) {
    return false;
  }

  return Object.values(files).every((strategy) => strategy === "copy" || strategy === "link");
}

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFile("git", args, {
    cwd,
    signal: AbortSignal.timeout(GIT_TIMEOUT_MS),
  });
  return stdout;
}

function isMissingPathError(error: unknown): boolean {
  if (!(error instanceof Error) || !("code" in error)) {
    return false;
  }

  return error.code === "ENOENT" || error.code === "ENOTDIR";
}

async function pathExists(filePath: string): Promise<boolean> {
  try {
    await lstat(filePath);
    return true;
  } catch (error) {
    if (isMissingPathError(error)) {
      return false;
    }
    throw error;
  }
}

async function readOptionalFile(filePath: string): Promise<string | undefined> {
  try {
    return await readFile(filePath, "utf8");
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return undefined;
    }
    throw error;
  }
}

function ensureTrailingNewline(value: string): string {
  return value.endsWith("\n") ? value : `${value}\n`;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function printUsage(command: string | undefined): void {
  if (command) {
    console.error(`branchstash: unknown command ${command}`);
  }

  console.log("usage: branchstash <init|install|run>");
}

await main();

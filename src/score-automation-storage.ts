import { randomUUID } from "node:crypto";
import {
  closeSync, constants, fstatSync, fsyncSync, lstatSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { AppError } from "./errors.js";
import { secureDirectory } from "./prosper-runs.js";

export type AutomationArtifact = "state" | "status" | "review" | "admission";

export function automationDirectory(): string {
  const local = resolve(".local");
  secureDirectory(local);
  const directory = join(local, "score-automation");
  secureDirectory(directory);
  return directory;
}

function verifyPrivateFile(path: string): void {
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.uid !== process.getuid?.() ||
      (stat.mode & 0o077) !== 0 || stat.size > 4 * 1024 * 1024) {
    throw new AppError("automation_unsafe_file");
  }
}

export function readAutomationArtifact(name: AutomationArtifact): unknown | undefined {
  const path = join(automationDirectory(), `${name}.json`);
  let fd: number;
  try { fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); }
  catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return undefined;
    throw new AppError("automation_unsafe_file");
  }
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.uid !== process.getuid?.() || (stat.mode & 0o077) !== 0 ||
        stat.size > 4 * 1024 * 1024) throw new AppError("automation_unsafe_file");
    try { return JSON.parse(readFileSync(fd, "utf8")) as unknown; }
    catch { throw new AppError("automation_invalid_json"); }
  } finally {
    closeSync(fd);
  }
}

export function writeAutomationArtifact(name: AutomationArtifact, data: unknown): string {
  const directory = automationDirectory();
  const path = join(directory, `${name}.json`);
  try { verifyPrivateFile(path); }
  catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
  }
  const text = JSON.stringify(data, null, 2) + "\n";
  if (Buffer.byteLength(text) > 4 * 1024 * 1024) throw new AppError("automation_artifact_too_large");
  const temporary = join(directory, `.state-${randomUUID()}.tmp`);
  const fd = openSync(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  let renamed = false;
  try {
    try { writeFileSync(fd, text); fsyncSync(fd); }
    finally { closeSync(fd); }
    renameSync(temporary, path);
    renamed = true;
    const directoryFd = openSync(directory, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    try { fsyncSync(directoryFd); }
    finally { closeSync(directoryFd); }
  } finally {
    if (!renamed) unlinkSync(temporary);
  }
  return path;
}

export function acquireAutomationLease(): () => void {
  const path = join(automationDirectory(), "owner.json");
  const nonce = randomUUID();
  let fd: number;
  try {
    fd = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "EEXIST") {
      throw new AppError("automation_already_owned",
        "An automation lease exists. Do not start another coordinator; verify its process before recovering a stale lease.");
    }
    throw error;
  }
  try {
    writeFileSync(fd, JSON.stringify({ pid: process.pid, nonce, acquired_at: new Date().toISOString() }) + "\n");
    fsyncSync(fd);
  }
  finally { closeSync(fd); }
  const owned = lstatSync(path);
  let released = false;
  return () => {
    if (released) return;
    verifyPrivateFile(path);
    const current = lstatSync(path);
    if (owned.dev !== current.dev || owned.ino !== current.ino ||
        !readFileSync(path, "utf8").includes(nonce)) throw new AppError("automation_lease_changed");
    unlinkSync(path);
    released = true;
  };
}

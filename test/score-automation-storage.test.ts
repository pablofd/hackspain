import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { test } from "node:test";

test("automation state stays private and a second coordinator cannot acquire the same lease", (t) => {
  const directory = resolve(".local", `automation-store-test-${randomUUID()}`);
  mkdirSync(directory, { mode: 0o700 });
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const fixture = resolve(directory, "check.mjs");
  writeFileSync(fixture, `
    import assert from 'node:assert/strict';
    import {chmodSync,readFileSync,statSync,symlinkSync,unlinkSync,writeFileSync} from 'node:fs';
    import {resolve} from 'node:path';
    import {readAutomationArtifact,writeAutomationArtifact,acquireAutomationLease,automationDirectory} from ${JSON.stringify(new URL("../src/score-automation-storage.ts", import.meta.url).href)};
    assert.equal(readAutomationArtifact('state'),undefined);
    const path=writeAutomationArtifact('state',{phase:'scoring'});
    assert.equal(statSync(path).mode&0o777,0o600);
    assert.deepEqual(readAutomationArtifact('state'),{phase:'scoring'});
    writeAutomationArtifact('state',{phase:'review'});
    assert.deepEqual(readAutomationArtifact('state'),{phase:'review'});
    const release=acquireAutomationLease();
    assert.throws(()=>acquireAutomationLease(),{code:'automation_already_owned'});
    release();release();
    acquireAutomationLease()();
    chmodSync(path,0o644);
    assert.throws(()=>readAutomationArtifact('state'),{code:'automation_unsafe_file'});
    chmodSync(path,0o600);
    const target=resolve(automationDirectory(),'target');
    writeFileSync(target,'unchanged',{mode:0o600});
    unlinkSync(path);symlinkSync(target,path);
    assert.throws(()=>writeAutomationArtifact('state',{}),{code:'automation_unsafe_file'});
    assert.equal(readFileSync(target,'utf8'),'unchanged');
  `, { mode: 0o600 });
  const result = spawnSync(process.execPath, ["--import", import.meta.resolve("tsx"), fixture], {
    cwd: directory, env: {}, encoding: "utf8", timeout: 15_000,
  });
  assert.equal(result.status, 0, result.stderr);
});

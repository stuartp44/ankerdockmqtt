import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const workflow = await readFile(new URL("../.github/workflows/release-please.yml", import.meta.url), "utf8");
const releaseStep = workflow.split("      - name: Create draft from merged release PR\n")[1]?.split("      - name:")[0];
const draftStep = workflow.split("      - name: Check for unpublished releases\n")[1]?.split("      - name:")[0];
const prStep = workflow.split("      - name: Create or update release PR\n")[1]?.split("\n  build-release:")[0];

test("release creation never generates the next PR before publishing", () => {
  assert.match(releaseStep, /skip-github-pull-request: true/);
  assert.match(prStep, /if: steps\.release\.outputs\.release_created != 'true' && steps\.drafts\.outputs\.ready == 'true'/);
  assert.match(prStep, /skip-github-release: true/);
  assert.match(workflow, /if: needs\.release-please\.outputs\.release_created == 'true'/);
  assert.match(workflow, /tag: \$\{\{ needs\.release-please\.outputs\.tag_name \}\}/);
});

test("draft guard blocks PR generation until publication and propagates API failures", async t => {
  assert.match(draftStep, /if: steps\.release\.outputs\.release_created != 'true'/);
  const script = draftStep.split("        run: |\n")[1].replace(/^          /gm, "");
  const directory = await mkdtemp(path.join(tmpdir(), "dock-mqtt-release-workflow-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const output = path.join(directory, "output");
  const mock = 'gh() { printf "%s" "$TEST_DRAFT_TAGS"; return "$TEST_GH_EXIT"; }\n';
  const env = {
    ...process.env,
    GITHUB_OUTPUT: output,
    GH_REPO: "stuartp44/ankerdockmqtt",
    TEST_GH_EXIT: "0",
  };
  for (const [drafts, expected] of [["", "ready=true\n"], ["v0.4.1", "ready=false\n"]]) {
    await rm(output, { force: true });
    await execFileAsync("bash", ["-e", "-o", "pipefail", "-c", mock + script], {
      env: { ...env, TEST_DRAFT_TAGS: drafts },
    });
    assert.equal(await readFile(output, "utf8"), expected);
  }
  await rm(output);
  await assert.rejects(execFileAsync("bash", ["-e", "-o", "pipefail", "-c", mock + script], {
    env: { ...env, TEST_DRAFT_TAGS: "", TEST_GH_EXIT: "1" },
  }));
  await assert.rejects(readFile(output), { code: "ENOENT" });
});

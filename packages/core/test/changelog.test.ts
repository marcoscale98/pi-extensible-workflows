import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import test from "node:test";
import { showChangelogNotice } from "../src/changelog.js";

async function packageFixture(version: string, changelog: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "pi-extensible-workflows-changelog-package-"));
  writeFileSync(join(root, "package.json"), JSON.stringify({ name: "pi-extensible-workflows", version }));
  writeFileSync(join(root, "CHANGELOG.md"), changelog);
  return root;
}

function noticeContext(notices: string[], mode = "tui") {
  return { hasUI: true, mode, ui: { notify(message: string) { notices.push(message); } } };
}

void test("shows the installed release notes once per version and includes intervening releases", async () => {
  const packageRoot = await packageFixture("3.0.0", "# Changelog\n## [5.0.0]\n\n- Five\n## [4.0.0]\n\n- Four\n## [3.0.0]\n\n- Three\n");
  const agentDir = await mkdtemp(join(tmpdir(), "pi-extensible-workflows-changelog-agent-"));
  const notices: string[] = [];
  const context = noticeContext(notices);

  await showChangelogNotice(context, agentDir, packageRoot);
  await showChangelogNotice(context, agentDir, packageRoot);
  assert.equal(notices.length, 1);
  assert.match(notices[0] ?? "", /updated to 3\.0\.0/);
  assert.match(notices[0] ?? "", /Three/);
  assert.deepEqual(JSON.parse(readFileSync(join(agentDir, "pi-extensible-workflows", "changelog-state.json"), "utf8")), { lastNotifiedVersion: "3.0.0" });

  writeFileSync(join(packageRoot, "package.json"), JSON.stringify({ name: "pi-extensible-workflows", version: "5.0.0" }));
  await showChangelogNotice(context, agentDir, packageRoot);
  await showChangelogNotice(context, agentDir, packageRoot);
  assert.equal(notices.length, 2);
  assert.match(notices[1] ?? "", /Five/);
  assert.match(notices[1] ?? "", /Four/);
  assert.doesNotMatch(notices[1] ?? "", /Three/);

  writeFileSync(join(packageRoot, "package.json"), JSON.stringify({ name: "pi-extensible-workflows", version: "5.0.0-dev.1" }));
  writeFileSync(join(packageRoot, "CHANGELOG.md"), "# Changelog\n## [5.0.0-dev.1]\n\n- Development\n## [5.0.0]\n\n- Five\n## [4.0.0]\n\n- Four\n## [3.0.0]\n\n- Three\n");
  await showChangelogNotice(context, agentDir, packageRoot);
  await showChangelogNotice(context, agentDir, packageRoot);
  assert.equal(notices.length, 3);
  assert.match(notices[2] ?? "", /Development/);
  assert.doesNotMatch(notices[2] ?? "", /Five/);
});

void test("does not mark print or JSON sessions as seen", async () => {
  const packageRoot = await packageFixture("1.0.0", "# Changelog\n## [1.0.0]\n\n- First\n");
  const agentDir = await mkdtemp(join(tmpdir(), "pi-extensible-workflows-changelog-headless-"));
  const notices: string[] = [];

  await showChangelogNotice(noticeContext(notices, "print"), agentDir, packageRoot);
  await showChangelogNotice(noticeContext(notices, "json"), agentDir, packageRoot);
  assert.deepEqual(notices, []);
  assert.equal(existsSync(join(agentDir, "pi-extensible-workflows", "changelog-state.json")), false);
});

void test("tolerates malformed changelog and state or persistence failures", async () => {
  const packageRoot = await packageFixture("2.0.0", "not a release changelog\n");
  const agentDir = await mkdtemp(join(tmpdir(), "pi-extensible-workflows-changelog-errors-"));
  const notices: string[] = [];
  await showChangelogNotice(noticeContext(notices), agentDir, packageRoot);
  assert.deepEqual(notices, []);

  writeFileSync(join(packageRoot, "CHANGELOG.md"), "# Changelog\n## [2.0.0]\n\n- Current\n");
  mkdirSync(join(agentDir, "pi-extensible-workflows"), { recursive: true });
  writeFileSync(join(agentDir, "pi-extensible-workflows", "changelog-state.json"), "{");
  await showChangelogNotice(noticeContext(notices), agentDir, packageRoot);
  assert.equal(notices.length, 1);

  const blockedAgentPath = join(agentDir, "blocked-agent");
  writeFileSync(blockedAgentPath, "not a directory");
  await assert.doesNotReject(showChangelogNotice(noticeContext(notices), blockedAgentPath, packageRoot));
  assert.equal(notices.length, 2);
});

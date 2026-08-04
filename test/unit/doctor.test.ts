import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import {
	buildDoctorReport,
	computePackageSourceSnapshot,
	inspectRuntimeIdentity,
	listPackageSourceSnapshotFiles,
	type RuntimeIdentity,
} from "../../src/extension/doctor.ts";
import type { AgentConfig, ChainConfig } from "../../src/agents/agents.ts";
import type { SubagentState } from "../../src/shared/types.ts";

function makeState(cwd: string): SubagentState {
	return {
		baseCwd: cwd,
		currentSessionId: "session-current",
		asyncJobs: new Map(),
		foregroundControls: new Map(),
		lastForegroundControlId: null,
		cleanupTimers: new Map(),
		lastUiContext: null,
		poller: null,
		completionSeen: new Map(),
		watcher: null,
		watcherRestartTimer: null,
		resultFileCoalescer: { schedule: () => false, clear: () => {} },
	};
}

function makeAgent(name: string, source: AgentConfig["source"]): AgentConfig {
	return {
		name,
		description: `${name} agent`,
		systemPrompt: "Prompt",
		systemPromptMode: "replace",
		inheritProjectContext: false,
		inheritSkills: false,
		source,
		filePath: `/tmp/${name}.md`,
	};
}

function makeChain(name: string, source: ChainConfig["source"]): ChainConfig {
	return {
		name,
		description: `${name} chain`,
		source,
		filePath: `/tmp/${name}.chain.md`,
		steps: [{ agent: "worker", task: "Work" }],
	};
}

function makeRuntimeIdentity(root: string): RuntimeIdentity {
	return {
		extensionModulePath: path.join(root, "src", "extension", "doctor.ts"),
		packageRoot: root,
		packageName: "pi-subagents",
		packageVersion: "0.35.1",
		packageSnapshot: { algorithm: "sha256", scope: "pi-subagents-npm-files-v1", sha256: "a".repeat(64), fileCount: 156 },
		git: { available: true, head: "b".repeat(40), tree: "c".repeat(40), dirtyEntryCount: 0 },
		nodeExecutable: { path: "/usr/bin/node", resolvedPath: "/usr/bin/node", sha256: "d".repeat(64) },
		piEntry: { path: "/usr/bin/pi", resolvedPath: "/opt/pi/cli.js", sha256: "e".repeat(64) },
		settings: { path: "/home/test/.pi/agent/settings.json", resolvedPath: "/home/test/.pi/agent/settings.json", sha256: "f".repeat(64) },
		settingsPath: "/home/test/.pi/agent/settings.json",
		failures: {},
	};
}

const PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

describe("computePackageSourceSnapshot", () => {
	it("deterministically hashes the npm source surface and changes with source content", () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-doctor-snapshot-"));
		try {
			for (const relative of ["src/a.ts", "agents/a.md", "skills/example/SKILL.md", "prompts/a.md", "test/ignored.ts"]) {
				fs.mkdirSync(path.dirname(path.join(root, relative)), { recursive: true });
				fs.writeFileSync(path.join(root, relative), relative);
			}
			for (const relative of ["package.json", "index.ts", "README.md", "CHANGELOG.md", "install.mjs"]) {
				fs.writeFileSync(path.join(root, relative), relative);
			}
			const first = computePackageSourceSnapshot(root);
			const second = computePackageSourceSnapshot(root);
			assert.deepEqual(first, second);
			assert.equal(first.scope, "pi-subagents-npm-files-v1");
			assert.equal(first.fileCount, 9);
			assert.match(first.sha256, /^[0-9a-f]{64}$/);

			fs.writeFileSync(path.join(root, "test", "ignored.ts"), "ignored change");
			assert.deepEqual(computePackageSourceSnapshot(root), first, "test files are outside the runtime package scope");
			fs.writeFileSync(path.join(root, "src", "a.ts"), "source change");
			assert.notEqual(computePackageSourceSnapshot(root).sha256, first.sha256);
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	it("matches the current npm pack file list as a release gate", () => {
		const cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-doctor-npm-cache-"));
		try {
			const packed = spawnSync("npm", ["pack", "--dry-run", "--json"], {
				cwd: PACKAGE_ROOT,
				encoding: "utf-8",
				env: { ...process.env, npm_config_cache: cacheDir },
				maxBuffer: 10 * 1024 * 1024,
			});
			assert.equal(packed.status, 0, packed.stderr || packed.stdout);
			const parsed = JSON.parse(packed.stdout) as Array<{ files: Array<{ path: string }> }> | Record<string, { files: Array<{ path: string }> }>;
			const report = Array.isArray(parsed) ? parsed[0] : parsed["pi-subagents"];
			assert.ok(report, "npm pack --dry-run --json should report the packed file list");
			assert.deepEqual(listPackageSourceSnapshotFiles(PACKAGE_ROOT), report!.files.map((entry) => entry.path).sort());
		} finally {
			fs.rmSync(cacheDir, { recursive: true, force: true });
		}
	});

	it("rejects the file limit while collecting rather than after hashing", () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-doctor-snapshot-count-"));
		try {
			fs.mkdirSync(path.join(root, "src"));
			fs.writeFileSync(path.join(root, "package.json"), "{}");
			fs.writeFileSync(path.join(root, "index.ts"), "export {};");
			for (let index = 0; index < 5_000; index++) fs.writeFileSync(path.join(root, "src", `${index}.ts`), "");
			assert.throws(() => listPackageSourceSnapshotFiles(root), /exceeds file limit \(5001 > 5000\)/);
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	it("fails closed on a symlink inside the source snapshot", { skip: process.platform === "win32" }, () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-doctor-snapshot-link-"));
		try {
			fs.mkdirSync(path.join(root, "src"));
			fs.writeFileSync(path.join(root, "package.json"), "{}");
			fs.writeFileSync(path.join(root, "index.ts"), "export {};");
			fs.writeFileSync(path.join(root, "outside.ts"), "outside");
			fs.symlinkSync(path.join(root, "outside.ts"), path.join(root, "src", "linked.ts"));
			assert.throws(() => computePackageSourceSnapshot(root), /refuses symlink: src\/linked\.ts/);
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	it("fails closed when an initial snapshot directory is a symlink", { skip: process.platform === "win32" }, () => {
		for (const linkedDirectory of ["src", "skills"]) {
			const root = fs.mkdtempSync(path.join(os.tmpdir(), `pi-doctor-snapshot-root-link-${linkedDirectory}-`));
			const outside = fs.mkdtempSync(path.join(os.tmpdir(), "pi-doctor-snapshot-root-link-outside-"));
			try {
				fs.writeFileSync(path.join(root, "package.json"), "{}");
				fs.writeFileSync(path.join(root, "index.ts"), "export {};");
				fs.writeFileSync(path.join(outside, "outside.ts"), "outside");
				if (linkedDirectory !== "src") fs.mkdirSync(path.join(root, "src"));
				fs.symlinkSync(outside, path.join(root, linkedDirectory), "dir");
				assert.throws(() => computePackageSourceSnapshot(root), new RegExp(`refuses symlink: ${linkedDirectory}`));
			} finally {
				fs.rmSync(root, { recursive: true, force: true });
				fs.rmSync(outside, { recursive: true, force: true });
			}
		}
	});

	it("caps and sanitizes the complete Git failure reason", { skip: process.platform === "win32" }, () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-doctor-git-failure-"));
		try {
			fs.mkdirSync(path.join(root, "src"));
			fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ name: "fixture", version: "1.0.0" }));
			fs.writeFileSync(path.join(root, "index.ts"), "export {};");
			const fakeGit = path.join(root, "fake-git");
			fs.writeFileSync(fakeGit, `#!/usr/bin/env node\nprocess.stderr.write("\\u001b[31m" + "x".repeat(1000) + "\\u202E"); process.exit(7);\n`);
			fs.chmodSync(fakeGit, 0o700);
			const identity = inspectRuntimeIdentity(root, { gitExecutablePath: fakeGit, piEntryPath: path.join(root, "missing") });
			assert.equal(identity.git.available, false);
			const reason = identity.git.available ? "" : identity.git.reason;
			assert.ok(reason.length <= 300, `reason length ${reason.length} exceeds 300`);
			assert.doesNotMatch(reason, /\p{Cc}|\p{Cf}/u);
			assert.match(reason, /^git rev-parse exited 7:/);
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	it("keeps independent identity fields when snapshot, Git, Pi entry, or settings are unavailable", () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-doctor-partial-identity-"));
		try {
			fs.mkdirSync(path.join(root, "src"));
			fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ name: "fixture-package", version: "1.0.0" }));
			fs.writeFileSync(path.join(root, "index.ts"), "export {};");
			fs.writeFileSync(path.join(root, "src", "oversized.ts"), "");
			fs.truncateSync(path.join(root, "src", "oversized.ts"), 16 * 1024 * 1024 + 1);
			const settingsDirectory = path.join(root, "settings-directory");
			fs.mkdirSync(settingsDirectory);
			const identity = inspectRuntimeIdentity(root, {
				piEntryPath: path.join(root, "missing-pi-entry"),
				settingsPath: settingsDirectory,
			});

			assert.equal(identity.packageName, "fixture-package");
			assert.equal(identity.packageSnapshot, undefined);
			assert.match(identity.failures["source snapshot"] ?? "", /identity limit/);
			assert.equal(identity.git.available, false);
			assert.ok((identity.git.available ? "" : identity.git.reason).length <= 300);
			assert.ok(identity.nodeExecutable?.sha256);
			assert.equal(identity.piEntry, undefined);
			assert.equal(identity.settings, undefined);
			assert.match(identity.failures.settings ?? "", /not a regular file/);

			const report = buildDoctorReport({
				cwd: root,
				config: {},
				state: makeState(root),
				runtimeIdentity: identity,
				paths: { tempRootDir: root, asyncDir: root, resultsDir: root, chainRunsDir: root },
				deps: {
					isAsyncAvailable: () => true,
					discoverAgentsAll: () => ({ builtin: [], package: [], user: [], project: [], chains: [], userDir: root, projectDir: root, userChainDir: root, projectChainDir: root, userSettingsPath: "", projectSettingsPath: "" }),
					discoverAvailableSkills: () => [],
					diagnoseIntercomBridge: () => ({ active: false, mode: "always", wantsIntercom: false, supervisorChannelAvailable: true, extensionDir: "native:pi-subagents-supervisor-channel" }),
				},
			});
			assert.match(report, /- package: fixture-package@1\.0\.0/);
			assert.match(report, /- source snapshot: unavailable .*identity limit/);
			assert.match(report, /- git: unavailable/);
			assert.match(report, /- Node executable: .*sha256 [0-9a-f]{64}/);
			assert.match(report, /- Pi entry: not available/);
			assert.match(report, /- settings: unavailable .*not a regular file/);
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});
});

describe("buildDoctorReport", () => {
	it("formats a bounded successful environment summary", () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-doctor-success-"));
		try {
			const state = makeState(root);
			state.subagentSpawns = {
				sessionId: "session-abc123",
				count: 3,
				configuredLimit: 4,
				granted: 1,
				grantHistory: [{ sessionId: "session-abc123", amount: 1, grantedAt: 0, previousLimit: 4, limit: 5 }],
			};
			const paths = {
				tempRootDir: path.join(root, "temp-root"),
				asyncDir: path.join(root, "async"),
				resultsDir: path.join(root, "results"),
				chainRunsDir: path.join(root, "chains"),
			};
			for (const dir of Object.values(paths)) fs.mkdirSync(dir, { recursive: true });

			const report = buildDoctorReport({
				cwd: root,
				config: { defaultSessionDir: "~/subagent-sessions", intercomBridge: { mode: "always" }, maxSubagentSpawnsPerSession: 4 },
				state,
				runtimeIdentity: makeRuntimeIdentity(root),
				currentSessionFile: path.join(root, "sessions", "parent.jsonl"),
				currentSessionId: "session-abc123",
				orchestratorTarget: "subagent-chat-abc123",
				expandTilde: (value) => value.replace(/^~\//, `${root}/home/`),
				paths,
				deps: {
					isAsyncAvailable: () => true,
					discoverAgentsAll: () => ({
						builtin: [makeAgent("builtin-a", "builtin")],
						user: [makeAgent("user-a", "user")],
						project: [makeAgent("project-a", "project"), makeAgent("project-b", "project")],
						chains: [makeChain("user-flow", "user"), makeChain("project-flow", "project")],
						userDir: path.join(root, "home", ".agents"),
						projectDir: path.join(root, ".pi", "agents"),
						userChainDir: path.join(root, "home", ".pi", "agent", "chains"),
						projectChainDir: path.join(root, ".pi", "chains"),
						userSettingsPath: path.join(root, "home", ".pi", "agent", "settings.json"),
						projectSettingsPath: path.join(root, ".pi", "settings.json"),
					}),
					discoverAvailableSkills: () => [
						{ name: "project-skill", source: "project" },
						{ name: "package-skill", source: "user-package" },
					],
					diagnoseIntercomBridge: () => ({
						active: true,
						mode: "always",
						wantsIntercom: true,
						supervisorChannelAvailable: true,
						extensionDir: "native:pi-subagents-supervisor-channel",
						orchestratorTarget: "subagent-chat-abc123",
					}),
				},
			});

			assert.match(report, /^Subagents doctor report/);
			assert.ok(report.includes(`- cwd: ${root}`));
			assert.match(report, /- async support: available/);
			assert.match(report, /- configured session dir: .*subagent-sessions/);
			assert.match(report, /- current session file: .*parent\.jsonl/);
			assert.match(report, /Runtime identity/);
			assert.match(report, /- package: pi-subagents@0\.35\.1/);
			assert.match(report, new RegExp(`- source snapshot: sha256 ${"a".repeat(64)} \\(pi-subagents-npm-files-v1; 156 files\\)`));
			assert.match(report, new RegExp(`- git: HEAD ${"b".repeat(40)}; tree ${"c".repeat(40)}; worktree clean`));
			assert.match(report, new RegExp(`- Pi entry: /usr/bin/pi → /opt/pi/cli\\.js; sha256 ${"e".repeat(64)}`));
			assert.match(report, new RegExp(`- settings: /home/test/\\.pi/agent/settings\\.json; sha256 ${"f".repeat(64)}`));
			assert.match(report, /- temp root: ok /);
			assert.match(report, /- agents: total 4 \(builtin 1, package 0, user 1, project 2\)/);
			assert.match(report, /- chains: total 2 \(builtin 0, package 0, user 1, project 1\)/);
			assert.match(report, /Spawn budget\n- usage: 3\/5 used, 2 remaining \(configured 4; granted 1; grant allowance 3\)/);
			assert.match(report, /- recent grants: \+1 at 1970-01-01T00:00:00\.000Z \(4 → 5\)/);
			assert.match(report, /new parent session resets usage and grants; compaction does not/);
			assert.match(report, /- skills: total 2 \(project 1, user-package 1\)/);
			assert.match(report, /- bridge: active/);
			assert.match(report, /- supervisor channel: available \(native:pi-subagents-supervisor-channel\)/);
			assert.doesNotMatch(report, /Companion packages/);
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	it("keeps reporting when a directory or discovery check fails", () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-doctor-failure-"));
		try {
			const asyncPath = path.join(root, "async-file");
			fs.writeFileSync(asyncPath, "not a directory");
			const report = buildDoctorReport({
				cwd: root,
				config: {},
				state: makeState(root),
				runtimeIdentity: makeRuntimeIdentity(root),
				paths: {
					tempRootDir: root,
					asyncDir: asyncPath,
					resultsDir: path.join(root, "missing-results"),
					chainRunsDir: path.join(root, "missing-chains"),
				},
				deps: {
					isAsyncAvailable: () => false,
					discoverAgentsAll: () => {
						throw new Error("discovery exploded");
					},
					discoverAvailableSkills: () => [],
					diagnoseIntercomBridge: () => ({
						active: false,
						mode: "fork-only",
						wantsIntercom: false,
						supervisorChannelAvailable: true,
						extensionDir: "native:pi-subagents-supervisor-channel",
						reason: "bridge mode is fork-only and context is not fork",
					}),
				},
			});

			assert.match(report, /- async support: unavailable/);
			assert.match(report, /- async runs: failed .*Error: not a directory:/);
			assert.match(report, /- results: missing /);
			assert.match(report, /- agents\/chains: failed — Error: discovery exploded/);
			assert.match(report, /- skills: total 0 \(none\)/);
			assert.match(report, /- bridge: inactive \(bridge mode is fork-only and context is not fork\)/);
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});
});

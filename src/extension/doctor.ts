import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { discoverAgentsAll, type AgentSource } from "../agents/agents.ts";
import { isAsyncAvailable } from "../runs/background/async-execution.ts";
import { formatSpawnBudgetSummary, getSpawnBudgetSnapshot } from "../runs/shared/spawn-budget.ts";
import { diagnoseIntercomBridge, type IntercomBridgeDiagnostic } from "../intercom/intercom-bridge.ts";
import { discoverAvailableSkills, type SkillSource } from "../agents/skills.ts";
import {
	ASYNC_DIR,
	CHAIN_RUNS_DIR,
	RESULTS_DIR,
	TEMP_ROOT_DIR,
	type ExtensionConfig,
	type SubagentState,
} from "../shared/types.ts";
import { getAgentDir } from "../shared/utils.ts";

interface DoctorPaths {
	tempRootDir: string;
	asyncDir: string;
	resultsDir: string;
	chainRunsDir: string;
}

interface DoctorDeps {
	isAsyncAvailable: () => boolean;
	discoverAgentsAll: typeof discoverAgentsAll;
	discoverAvailableSkills: typeof discoverAvailableSkills;
	diagnoseIntercomBridge: typeof diagnoseIntercomBridge;
}

interface FileIdentity {
	path: string;
	resolvedPath: string;
	sha256: string;
}

export interface PackageSourceSnapshot {
	algorithm: "sha256";
	scope: "pi-subagents-npm-files-v1";
	sha256: string;
	fileCount: number;
}

type RuntimeIdentityField = "package" | "source snapshot" | "Node executable" | "Pi entry" | "settings";

export interface RuntimeIdentity {
	extensionModulePath: string;
	packageRoot: string;
	packageName?: string;
	packageVersion?: string;
	packageSnapshot?: PackageSourceSnapshot;
	git: { available: true; head: string; tree: string; dirtyEntryCount: number } | { available: false; reason: string };
	nodeExecutable?: FileIdentity;
	piEntry?: FileIdentity;
	settings?: FileIdentity;
	settingsPath: string;
	failures: Partial<Record<RuntimeIdentityField, string>>;
}

export interface RuntimeIdentityOptions {
	nodeExecutablePath?: string;
	piEntryPath?: string;
	settingsPath?: string;
	gitExecutablePath?: string;
}

interface DoctorReportInput {
	cwd: string;
	config: ExtensionConfig;
	state: SubagentState;
	runtimeIdentity?: RuntimeIdentity;
	context?: "fresh" | "fork";
	requestedSessionDir?: string;
	currentSessionFile?: string | null;
	currentSessionId?: string | null;
	orchestratorTarget?: string;
	sessionError?: string;
	expandTilde?: (value: string) => string;
	paths?: DoctorPaths;
	deps?: Partial<DoctorDeps>;
}

const DEFAULT_PATHS: DoctorPaths = {
	tempRootDir: TEMP_ROOT_DIR,
	asyncDir: ASYNC_DIR,
	resultsDir: RESULTS_DIR,
	chainRunsDir: CHAIN_RUNS_DIR,
};

const DEFAULT_DEPS: DoctorDeps = {
	isAsyncAvailable,
	discoverAgentsAll,
	discoverAvailableSkills,
	diagnoseIntercomBridge,
};

const EXTENSION_MODULE_PATH = fileURLToPath(import.meta.url);
const PACKAGE_ROOT = path.resolve(path.dirname(EXTENSION_MODULE_PATH), "../..");
const SNAPSHOT_ROOT_FILES = ["package.json", "index.ts", "README.md", "CHANGELOG.md"];
const SNAPSHOT_DIRECTORIES = ["src", "agents", "skills", "prompts"];
const SNAPSHOT_MAX_FILES = 5_000;
const SNAPSHOT_MAX_ENTRIES = 10_000;
const SNAPSHOT_MAX_FILE_BYTES = 16 * 1024 * 1024;
const SNAPSHOT_MAX_TOTAL_BYTES = 64 * 1024 * 1024;
const NODE_IDENTITY_MAX_BYTES = 128 * 1024 * 1024;
const PI_ENTRY_IDENTITY_MAX_BYTES = 32 * 1024 * 1024;
const SETTINGS_IDENTITY_MAX_BYTES = 4 * 1024 * 1024;
const GIT_TIMEOUT_MS = 1_000;
const GIT_MAX_BUFFER = 64 * 1024;
const DIAGNOSTIC_MAX_CHARS = 300;
const HASH_BUFFER = Buffer.allocUnsafe(1024 * 1024);

function errorText(error: unknown): string {
	return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
}

function lineFromCheck(label: string, check: () => string): string {
	try {
		return check();
	} catch (error) {
		return `- ${label}: failed — ${errorText(error)}`;
	}
}

function addSnapshotFile(files: Set<string>, relative: string): void {
	files.add(relative);
	if (files.size > SNAPSHOT_MAX_FILES) throw new Error(`source snapshot exceeds file limit (${files.size} > ${SNAPSHOT_MAX_FILES})`);
}

function scanDirectoryEntries(directory: string, visit: (entry: fs.Dirent) => void): void {
	const handle = fs.opendirSync(directory);
	try {
		let entry: fs.Dirent | null;
		while ((entry = handle.readSync()) !== null) visit(entry);
	} finally {
		handle.closeSync();
	}
}

export function listPackageSourceSnapshotFiles(packageRoot: string): string[] {
	for (const required of ["package.json", "index.ts", "src"]) {
		if (!fs.existsSync(path.join(packageRoot, required))) throw new Error(`source snapshot is missing required path: ${required}`);
	}
	const files = new Set<string>();
	for (const relative of SNAPSHOT_ROOT_FILES) {
		const filePath = path.join(packageRoot, relative);
		if (!fs.existsSync(filePath)) continue;
		const stats = fs.lstatSync(filePath);
		if (stats.isSymbolicLink()) throw new Error(`source snapshot refuses symlink: ${relative}`);
		if (!stats.isFile()) throw new Error(`source snapshot expected a regular file: ${relative}`);
		addSnapshotFile(files, relative);
	}

	let entriesSeen = 0;
	const countEntry = () => {
		entriesSeen++;
		if (entriesSeen > SNAPSHOT_MAX_ENTRIES) throw new Error(`source snapshot exceeds entry limit (${entriesSeen} > ${SNAPSHOT_MAX_ENTRIES})`);
	};
	scanDirectoryEntries(packageRoot, (entry) => {
		countEntry();
		if (entry.isSymbolicLink() && entry.name.endsWith(".mjs")) throw new Error(`source snapshot refuses symlink: ${entry.name}`);
		if (entry.isFile() && entry.name.endsWith(".mjs")) addSnapshotFile(files, entry.name);
	});

	const pending: string[] = [];
	for (const relative of SNAPSHOT_DIRECTORIES) {
		const directory = path.join(packageRoot, relative);
		if (!fs.existsSync(directory)) continue;
		const stats = fs.lstatSync(directory);
		if (stats.isSymbolicLink()) throw new Error(`source snapshot refuses symlink: ${relative}`);
		if (!stats.isDirectory()) throw new Error(`source snapshot expected a directory: ${relative}`);
		pending.push(relative);
	}
	while (pending.length > 0) {
		const relativeDir = pending.pop()!;
		scanDirectoryEntries(path.join(packageRoot, relativeDir), (entry) => {
			countEntry();
			const relative = path.join(relativeDir, entry.name);
			if (entry.isSymbolicLink()) throw new Error(`source snapshot refuses symlink: ${relative}`);
			if (entry.isDirectory()) pending.push(relative);
			else if (entry.isFile()) addSnapshotFile(files, relative);
		});
	}
	return [...files].map((relative) => relative.split(path.sep).join("/")).sort();
}

function updateHashFromRegularFile(
	digest: ReturnType<typeof createHash>,
	filePath: string,
	maxBytes: number,
	beforeContent?: (size: number) => void,
): number {
	const beforeOpen = fs.lstatSync(filePath);
	if (beforeOpen.isSymbolicLink()) throw new Error(`refusing symlink while hashing: ${filePath}`);
	const noFollow = typeof fs.constants.O_NOFOLLOW === "number" ? fs.constants.O_NOFOLLOW : 0;
	const fd = fs.openSync(filePath, fs.constants.O_RDONLY | noFollow);
	try {
		const before = fs.fstatSync(fd);
		if (!before.isFile()) throw new Error(`not a regular file: ${filePath}`);
		if (before.dev !== beforeOpen.dev || before.ino !== beforeOpen.ino) throw new Error(`file changed while opening for hash: ${filePath}`);
		if (before.size > maxBytes) throw new Error(`file exceeds identity limit (${before.size} > ${maxBytes} bytes): ${filePath}`);
		beforeContent?.(before.size);
		let offset = 0;
		while (offset < before.size) {
			const bytesRead = fs.readSync(fd, HASH_BUFFER, 0, Math.min(HASH_BUFFER.length, before.size - offset), offset);
			if (bytesRead <= 0) throw new Error(`file changed while hashing: ${filePath}`);
			digest.update(HASH_BUFFER.subarray(0, bytesRead));
			offset += bytesRead;
		}
		const after = fs.fstatSync(fd);
		if (after.dev !== before.dev || after.ino !== before.ino || after.size !== before.size || after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs) {
			throw new Error(`file changed while hashing: ${filePath}`);
		}
		return before.size;
	} finally {
		fs.closeSync(fd);
	}
}

export function computePackageSourceSnapshot(packageRoot: string): PackageSourceSnapshot {
	const digest = createHash("sha256");
	const ordered = listPackageSourceSnapshotFiles(packageRoot);
	let totalBytes = 0;
	for (const relative of ordered) {
		const filePath = path.join(packageRoot, ...relative.split("/"));
		const remainingTotal = SNAPSHOT_MAX_TOTAL_BYTES - totalBytes;
		if (remainingTotal < 0) throw new Error(`source snapshot exceeds total byte limit (${totalBytes} > ${SNAPSHOT_MAX_TOTAL_BYTES})`);
		const hashedSize = updateHashFromRegularFile(digest, filePath, Math.min(SNAPSHOT_MAX_FILE_BYTES, remainingTotal), (size) => {
			digest.update(`${Buffer.byteLength(relative, "utf-8")}:${relative}:${size}:`, "utf-8");
		});
		totalBytes += hashedSize;
	}
	return {
		algorithm: "sha256",
		scope: "pi-subagents-npm-files-v1",
		sha256: digest.digest("hex"),
		fileCount: ordered.length,
	};
}

function inspectFileIdentity(filePath: string, maxBytes: number): FileIdentity {
	const resolvedPath = fs.realpathSync(filePath);
	const digest = createHash("sha256");
	updateHashFromRegularFile(digest, resolvedPath, maxBytes);
	return {
		path: filePath,
		resolvedPath,
		sha256: digest.digest("hex"),
	};
}

function compactDiagnostic(value: unknown): string {
	const compact = String(value ?? "").replace(/[\p{Cc}\p{Cf}]/gu, " ").replace(/\s+/g, " ").trim();
	return compact.length <= DIAGNOSTIC_MAX_CHARS ? compact : `${compact.slice(0, DIAGNOSTIC_MAX_CHARS - 1)}…`;
}

function gitFailureReason(result: ReturnType<typeof spawnSync>, operation: string): string {
	if (result.error) {
		const code = (result.error as NodeJS.ErrnoException).code;
		return compactDiagnostic(`${operation} ${code ?? result.error.name}: ${result.error.message}`);
	}
	if (result.signal) return compactDiagnostic(`${operation} terminated by ${result.signal}`);
	const detail = compactDiagnostic(result.stderr || result.stdout);
	return compactDiagnostic(`${operation} exited ${result.status ?? "unknown"}${detail ? `: ${detail}` : ""}`);
}

function inspectGitIdentity(packageRoot: string, executable = "git"): RuntimeIdentity["git"] {
	const options = { encoding: "utf-8" as const, timeout: GIT_TIMEOUT_MS, maxBuffer: GIT_MAX_BUFFER };
	const revision = spawnSync(executable, ["-C", packageRoot, "rev-parse", "HEAD", "HEAD^{tree}"], options);
	if (revision.status !== 0) return { available: false, reason: gitFailureReason(revision, "git rev-parse") };
	const tokens = revision.stdout.trim().split(/\s+/).filter(Boolean);
	if (tokens.length !== 2 || !tokens.every((token) => /^[0-9a-f]{40}$/i.test(token))) {
		return { available: false, reason: "git rev-parse returned malformed object ids" };
	}
	const [head, tree] = tokens as [string, string];
	const status = spawnSync(executable, ["-C", packageRoot, "status", "--porcelain=v1", "--untracked-files=normal"], options);
	if (status.status !== 0) return { available: false, reason: gitFailureReason(status, "git status") };
	const dirtyEntryCount = status.stdout.split(/\r?\n/).filter((line) => line.length > 0).length;
	return { available: true, head, tree, dirtyEntryCount };
}

export function inspectRuntimeIdentity(packageRoot = PACKAGE_ROOT, options: RuntimeIdentityOptions = {}): RuntimeIdentity {
	const settingsPath = options.settingsPath ?? path.join(getAgentDir(), "settings.json");
	const piEntryPath = options.piEntryPath ?? process.argv[1];
	const failures: RuntimeIdentity["failures"] = {};
	let packageName: string | undefined;
	let packageVersion: string | undefined;
	let packageSnapshot: PackageSourceSnapshot | undefined;
	let nodeExecutable: FileIdentity | undefined;
	let piEntry: FileIdentity | undefined;
	let settings: FileIdentity | undefined;
	let git: RuntimeIdentity["git"];

	try {
		const packageJson = JSON.parse(fs.readFileSync(path.join(packageRoot, "package.json"), "utf-8")) as { name?: unknown; version?: unknown };
		if (typeof packageJson.name !== "string" || typeof packageJson.version !== "string") throw new Error("package.json requires string name and version");
		packageName = packageJson.name;
		packageVersion = packageJson.version;
	} catch (error) {
		failures.package = compactDiagnostic(errorText(error));
	}
	try {
		packageSnapshot = computePackageSourceSnapshot(packageRoot);
	} catch (error) {
		failures["source snapshot"] = compactDiagnostic(errorText(error));
	}
	try {
		git = inspectGitIdentity(packageRoot, options.gitExecutablePath);
	} catch (error) {
		git = { available: false, reason: compactDiagnostic(errorText(error)) };
	}
	try {
		nodeExecutable = inspectFileIdentity(options.nodeExecutablePath ?? process.execPath, NODE_IDENTITY_MAX_BYTES);
	} catch (error) {
		failures["Node executable"] = compactDiagnostic(errorText(error));
	}
	if (piEntryPath && fs.existsSync(piEntryPath)) {
		try {
			piEntry = inspectFileIdentity(piEntryPath, PI_ENTRY_IDENTITY_MAX_BYTES);
		} catch (error) {
			failures["Pi entry"] = compactDiagnostic(errorText(error));
		}
	}
	if (fs.existsSync(settingsPath)) {
		try {
			settings = inspectFileIdentity(settingsPath, SETTINGS_IDENTITY_MAX_BYTES);
		} catch (error) {
			failures.settings = compactDiagnostic(errorText(error));
		}
	}
	return {
		extensionModulePath: EXTENSION_MODULE_PATH,
		packageRoot,
		...(packageName !== undefined ? { packageName } : {}),
		...(packageVersion !== undefined ? { packageVersion } : {}),
		...(packageSnapshot ? { packageSnapshot } : {}),
		git,
		...(nodeExecutable ? { nodeExecutable } : {}),
		...(piEntry ? { piEntry } : {}),
		...(settings ? { settings } : {}),
		settingsPath,
		failures,
	};
}

function formatFileIdentity(identity: FileIdentity): string {
	const resolution = identity.path === identity.resolvedPath ? identity.path : `${identity.path} → ${identity.resolvedPath}`;
	return `${resolution}; sha256 ${identity.sha256}`;
}

function formatRuntimeIdentitySection(input: DoctorReportInput): string[] {
	let identity: RuntimeIdentity;
	try {
		identity = input.runtimeIdentity ?? inspectRuntimeIdentity();
	} catch (error) {
		return [`- runtime identity: failed — ${compactDiagnostic(errorText(error))}`];
	}
	const git = identity.git.available
		? `HEAD ${identity.git.head}; tree ${identity.git.tree}; worktree ${identity.git.dirtyEntryCount === 0 ? "clean" : `dirty (${identity.git.dirtyEntryCount} entries)`}`
		: `unavailable (${identity.git.reason})`;
	const unavailable = (field: RuntimeIdentityField, fallback = "not available") => identity.failures[field]
		? `unavailable (${identity.failures[field]})`
		: fallback;
	return [
		`- extension module: ${identity.extensionModulePath}`,
		`- package root: ${identity.packageRoot}`,
		`- package: ${identity.packageName !== undefined && identity.packageVersion !== undefined ? `${identity.packageName}@${identity.packageVersion}` : unavailable("package")}`,
		`- source snapshot: ${identity.packageSnapshot ? `sha256 ${identity.packageSnapshot.sha256} (${identity.packageSnapshot.scope}; ${identity.packageSnapshot.fileCount} files)` : unavailable("source snapshot")}`,
		`- git: ${git}`,
		`- Node executable: ${identity.nodeExecutable ? formatFileIdentity(identity.nodeExecutable) : unavailable("Node executable")}`,
		`- Pi entry: ${identity.piEntry ? formatFileIdentity(identity.piEntry) : unavailable("Pi entry")}`,
		`- settings: ${identity.settings ? formatFileIdentity(identity.settings) : unavailable("settings", `missing (${identity.settingsPath})`)}`,
	];
}

function formatExistingDirectory(label: string, dirPath: string): string {
	try {
		if (!fs.existsSync(dirPath)) return `- ${label}: missing (${dirPath})`;
		const stats = fs.statSync(dirPath);
		if (!stats.isDirectory()) throw new Error(`not a directory: ${dirPath}`);
		fs.accessSync(dirPath, fs.constants.R_OK | fs.constants.W_OK);
		return `- ${label}: ok (${dirPath})`;
	} catch (error) {
		return `- ${label}: failed (${dirPath}) — ${errorText(error)}`;
	}
}

function formatSourceCounts(counts: Record<AgentSource, number>): string {
	return `builtin ${counts.builtin}, package ${counts.package}, user ${counts.user}, project ${counts.project}`;
}

function formatSkillSourceCounts(skills: Array<{ source: SkillSource }>): string {
	const counts = new Map<SkillSource, number>();
	for (const skill of skills) counts.set(skill.source, (counts.get(skill.source) ?? 0) + 1);
	const ordered: SkillSource[] = [
		"project",
		"project-settings",
		"project-package",
		"user",
		"user-settings",
		"user-package",
		"extension",
		"builtin",
		"unknown",
	];
	const parts = ordered
		.map((source) => `${source} ${counts.get(source) ?? 0}`)
		.filter((part) => !part.endsWith(" 0"));
	return parts.length > 0 ? parts.join(", ") : "none";
}

function formatConfiguredSessionDir(input: DoctorReportInput): string {
	if (input.requestedSessionDir) {
		return path.resolve(input.expandTilde?.(input.requestedSessionDir) ?? input.requestedSessionDir);
	}
	if (input.config.defaultSessionDir) {
		return path.resolve(input.expandTilde?.(input.config.defaultSessionDir) ?? input.config.defaultSessionDir);
	}
	return "not configured";
}

function formatSessionLines(input: DoctorReportInput): string[] {
	const sessionFile = input.currentSessionFile ?? null;
	const lines = [
		lineFromCheck("configured session dir", () => `- configured session dir: ${formatConfiguredSessionDir(input)}`),
		`- current session file: ${sessionFile ?? "not available"}`,
		`- current session dir: ${sessionFile ? path.dirname(sessionFile) : "not available"}`,
		`- current session id: ${input.currentSessionId ?? input.state.currentSessionId ?? "not available"}`,
	];
	if (input.sessionError) lines.push(`- session manager: failed — ${input.sessionError}`);
	return lines;
}

function formatDiscovery(input: DoctorReportInput, deps: DoctorDeps): string[] {
	return [
		lineFromCheck("agents/chains", () => {
			const discovered = deps.discoverAgentsAll(input.cwd);
			const agentCounts = {
				builtin: discovered.builtin.length,
				package: discovered.package?.length ?? 0,
				user: discovered.user.length,
				project: discovered.project.length,
			};
			const chainCounts = discovered.chains.reduce<Record<AgentSource, number>>((counts, chain) => {
				counts[chain.source] += 1;
				return counts;
			}, { builtin: 0, package: 0, user: 0, project: 0 });
			return [
				`- agents: total ${agentCounts.builtin + agentCounts.package + agentCounts.user + agentCounts.project} (${formatSourceCounts(agentCounts)})`,
				`- chains: total ${discovered.chains.length} (${formatSourceCounts(chainCounts)})`,
			].join("\n");
		}),
		lineFromCheck("skills", () => {
			const skills = deps.discoverAvailableSkills(input.cwd);
			return `- skills: total ${skills.length} (${formatSkillSourceCounts(skills)})`;
		}),
	];
}

function formatIntercomDiagnostic(diagnostic: IntercomBridgeDiagnostic, context: "fresh" | "fork" | undefined): string[] {
	const lines = [
		`- bridge: ${diagnostic.active ? "active" : "inactive"}${diagnostic.reason ? ` (${diagnostic.reason})` : ""}`,
		`- mode: ${diagnostic.mode}; context: ${context ?? "unspecified"}`,
		`- orchestrator target: ${diagnostic.orchestratorTarget ?? "not available"}`,
		`- supervisor channel: ${diagnostic.supervisorChannelAvailable ? "available" : "unavailable"} (${diagnostic.extensionDir})`,
	];
	return lines;
}

function formatSpawnBudgetSection(input: DoctorReportInput): string[] {
	const snapshot = getSpawnBudgetSnapshot(input.state, input.config, input.currentSessionId ?? input.state.currentSessionId);
	return [
		`- usage: ${formatSpawnBudgetSummary(snapshot)}`,
		`- recent grants: ${snapshot.grantHistory.length === 0
			? "none"
			: snapshot.grantHistory.map((grant) => `+${grant.amount} at ${new Date(grant.grantedAt).toISOString()} (${grant.previousLimit} → ${grant.limit})`).join("; ")}`,
		"- reset boundary: a new parent session resets usage and grants; compaction does not",
	];
}

function formatPermissionSystemSection(): string[] {
	const lines: string[] = [];
	const parentSession = process.env["PI_SUBAGENT_PARENT_SESSION"] ?? "";
	const trimmed = parentSession.trim();
	if (trimmed) {
		lines.push(`- parent session: set (${trimmed})`);
	} else {
		lines.push("- parent session: not set — ask forwarding from subprocess children will not reach a parent UI");
	}
	const isChild = process.env["PI_SUBAGENT_CHILD"] === "1";
	lines.push(`- subagent process: ${isChild ? "yes (PI_SUBAGENT_CHILD=1)" : "no"}`);
	// Whether pi-permission-system is installed and where it stores config is
	// outside pi-subagents' control, so we only report the forwarding signal we
	// own. Run `pi list` to confirm the permission extension is installed.
	return lines;
}

export function buildDoctorReport(input: DoctorReportInput): string {
	const paths = input.paths ?? DEFAULT_PATHS;
	const deps = { ...DEFAULT_DEPS, ...input.deps };
	const lines = [
		"Subagents doctor report",
		"",
		"Runtime",
		`- cwd: ${input.cwd}`,
		lineFromCheck("async support", () => `- async support: ${deps.isAsyncAvailable() ? "available" : "unavailable"}`),
		...formatSessionLines(input),
		"",
		"Runtime identity",
		...formatRuntimeIdentitySection(input),
		"",
		"Filesystem",
		formatExistingDirectory("temp root", paths.tempRootDir),
		formatExistingDirectory("async runs", paths.asyncDir),
		formatExistingDirectory("results", paths.resultsDir),
		formatExistingDirectory("chain runs", paths.chainRunsDir),
		"",
		"Discovery",
		...formatDiscovery(input, deps),
		"",
		"Spawn budget",
		...formatSpawnBudgetSection(input),
		"",
		"Permission system",
		...formatPermissionSystemSection(),
		"",
		"Intercom bridge",
		...lineFromCheck("intercom bridge", () => formatIntercomDiagnostic(deps.diagnoseIntercomBridge({
			config: input.config.intercomBridge,
			context: input.context,
			orchestratorTarget: input.orchestratorTarget,
			cwd: input.cwd,
		}), input.context).join("\n")).split("\n"),
	];
	return lines.join("\n");
}

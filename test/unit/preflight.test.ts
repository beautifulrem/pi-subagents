import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { registerSubagentCapabilityCeiling, resolveSubagentCapabilityCeiling } from "../../src/api/capability-ceiling.ts";
import { resolveSubagentLaunchContract, SUBAGENT_LAUNCH_CONTRACT_VERSION, type SubagentLaunchContractInput } from "../../src/api/preflight.ts";
import { clearSkillCache } from "../../src/agents/skills.ts";
import { EXTRA_AGENT_DIRS_ENV } from "../../src/agents/agents.ts";
import { computeMcpServerHash } from "../../src/runs/shared/mcp-direct-tool-allowlist.ts";

let tempDir = "";
let previousAgentDir: string | undefined;
let previousExtraAgentDirs: string | undefined;
let userAgentsDir = "";
let userSkillsDir = "";

function writeAgent(filePath: string, body: string): void {
	fs.mkdirSync(path.dirname(filePath), { recursive: true });
	fs.writeFileSync(filePath, body, "utf-8");
}

function writeSkill(cwd: string, name: string): void {
	const skillDir = path.join(cwd, ".pi", "skills", name);
	fs.mkdirSync(skillDir, { recursive: true });
	fs.writeFileSync(path.join(skillDir, "SKILL.md"), `---\ndescription: ${name}\n---\n\nUse ${name}.\n`, "utf-8");
}

function writeJson(filePath: string, value: unknown): void {
	fs.mkdirSync(path.dirname(filePath), { recursive: true });
	fs.writeFileSync(filePath, JSON.stringify(value, null, 2), "utf-8");
}

function writeMcpFixture(): void {
	const agentDir = process.env.PI_CODING_AGENT_DIR;
	assert.equal(typeof agentDir, "string");
	const definition = { command: "github-mcp" };
	writeJson(path.join(agentDir, "mcp.json"), { mcpServers: { github: definition } });
	writeJson(path.join(agentDir, "mcp-cache.json"), {
		version: 1,
		servers: {
			github: {
				configHash: computeMcpServerHash(definition),
				cachedAt: Date.now(),
				tools: [{ name: "search_repositories" }, { name: "create_issue" }],
				resources: [],
			},
		},
	});
}

function resolveHermeticPreflight(input: SubagentLaunchContractInput) {
	return resolveSubagentLaunchContract(input, {
		discovery: { userAgentsDir, userSkillsDir },
	});
}

describe("public launch contract preflight", () => {
	beforeEach(() => {
		tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-preflight-"));
		previousAgentDir = process.env.PI_CODING_AGENT_DIR;
		previousExtraAgentDirs = process.env[EXTRA_AGENT_DIRS_ENV];
		process.env.PI_CODING_AGENT_DIR = path.join(tempDir, "agent-dir");
		delete process.env[EXTRA_AGENT_DIRS_ENV];
		userAgentsDir = path.join(tempDir, "isolated-user-agents");
		userSkillsDir = path.join(tempDir, "isolated-user-skills");
		clearSkillCache();
	});

	afterEach(() => {
		clearSkillCache();
		if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
		if (previousExtraAgentDirs === undefined) delete process.env[EXTRA_AGENT_DIRS_ENV];
		else process.env[EXTRA_AGENT_DIRS_ENV] = previousExtraAgentDirs;
		fs.rmSync(tempDir, { recursive: true, force: true });
	});

	it("uses one injected discovery boundary for selected agents, shadow candidates, and skills", async () => {
		const cwd = path.join(tempDir, "repo");
		const suffix = path.basename(tempDir).replace(/[^A-Za-z0-9_-]/g, "-");
		const agentName = `hermetic-agent-${suffix}`;
		const skillName = `hermetic-skill-${suffix}`;
		const projectAgentPath = path.join(cwd, ".pi", "agents", `${agentName}.md`);
		const userAgentPath = path.join(userAgentsDir, `${agentName}.md`);
		const userSkillPath = path.join(userSkillsDir, `${skillName}.md`);

		fs.mkdirSync(cwd, { recursive: true });
		writeAgent(userAgentPath, `---\nname: ${agentName}\ndescription: Isolated user candidate\n---\nUser candidate.\n`);
		writeAgent(userSkillPath, `---\ndescription: Isolated user skill\n---\nUse the isolated skill.\n`);
		writeAgent(projectAgentPath, `---\nname: ${agentName}\ndescription: Selected project candidate\nskills:\n  - ${skillName}\n---\nProject candidate.\n`);

		const result = await resolveHermeticPreflight({ agent: agentName, cwd });

		assert.equal(result.ok, true);
		assert.equal(result.contract.agent.filePath, projectAgentPath);
		assert.deepEqual(result.contract.skills.resolved.map((skill) => skill.path), [userSkillPath]);
		assert.ok(result.contract.agent.shadowedCandidates.some((candidate) => candidate.filePath === userAgentPath && candidate.selected === false));
	});

	it("resolves a deterministic contract without creating launch directories", async () => {
		const cwd = path.join(tempDir, "repo");
		fs.mkdirSync(cwd, { recursive: true });
		writeSkill(cwd, "project-skill");
		writeAgent(path.join(cwd, ".pi", "agents", "worker.md"), `---
name: worker
description: Project worker
tools:
  - read
  - write
  - /tmp/private-tool.ts
model: test/primary
fallbackModels:
  - test/fallback
thinking: high
skills:
  - project-skill
output: report.md
---
Project prompt.
`);
		const sessionRoot = path.join(tempDir, "sessions");
		const handle = registerSubagentCapabilityCeiling({ sessionId: "preflight-session", ceiling: { allowedTools: ["read"], denyExtensions: true }, source: "test" });
		try {
			const ceiling = resolveSubagentCapabilityCeiling("preflight-session");
			const input = {
				agent: "worker",
				cwd,
				task: "Inspect the repo",
				runId: "run-123",
				sessionRoot,
				availableModels: [
					{ provider: "test", id: "primary", fullId: "test/primary" },
					{ provider: "test", id: "fallback", fullId: "test/fallback" },
				],
				capabilityCeiling: ceiling,
			};
			const result = await resolveHermeticPreflight(input);

			assert.equal(result.ok, true);
			assert.equal(result.contract.version, SUBAGENT_LAUNCH_CONTRACT_VERSION);
			assert.equal(result.contract.agent.source, "project");
			assert.equal(result.contract.model, "test/primary:high");
			assert.deepEqual(result.contract.modelCandidates, ["test/primary:high", "test/fallback:high"]);
			assert.deepEqual(result.contract.skills.requested, ["project-skill"]);
			assert.deepEqual(result.contract.tools.effectiveAllowlist, ["read"]);
			assert.deepEqual(result.contract.tools.capabilityAudit?.removedTools, ["write"]);
			assert.equal(result.contract.tools.capabilityAudit?.removedExtensionCount, 1);
			assert.equal(result.contract.roots.sessionFile, path.join(sessionRoot, "run-123", "run-0", "session.jsonl"));
			assert.equal(result.contract.roots.outputPath, path.join(cwd, ".pi-subagents", "artifacts", "outputs", "run-123", "report.md"));
			assert.match(result.contract.digest, /^[a-f0-9]{64}$/);
			const repeated = await resolveHermeticPreflight(input);
			assert.equal(repeated.ok, true);
			assert.equal(repeated.contract.digest, result.contract.digest);
			assert.equal(fs.existsSync(sessionRoot), false);
			assert.equal(fs.existsSync(path.join(cwd, ".pi-subagents")), false);
		} finally {
			handle.dispose();
		}
	});

	it("returns closed failures for missing agents, skills, and invalid inputs", async () => {
		const cwd = path.join(tempDir, "repo");
		fs.mkdirSync(cwd, { recursive: true });
		writeAgent(path.join(cwd, ".pi", "agents", "worker.md"), `---\nname: worker\ndescription: Project worker\nskills:\n  - missing-skill\n---\nProject prompt.\n`);

		assert.deepEqual(await resolveHermeticPreflight({ agent: "missing", cwd }), { ok: false, code: "missing_agent", message: "Unknown agent: missing", diagnostics: [] });
		const missingSkill = await resolveHermeticPreflight({ agent: "worker", cwd });
		assert.equal(missingSkill.ok, false);
		assert.equal(missingSkill.code, "missing_skill");
		assert.equal((await resolveHermeticPreflight({ agent: "worker", cwd: path.join(tempDir, "missing") })).code, "invalid_cwd");
		assert.equal((await resolveHermeticPreflight({ agent: "worker", cwd, context: "bogus" as never })).code, "unsupported_mode");
		assert.equal((await resolveHermeticPreflight({ agent: "worker", cwd, artifactDir: "bogus" as never })).code, "invalid_artifact_dir");
	});

	it("projects MCP, extension, fanout, structured-output, and fork diagnostics", async () => {
		const cwd = path.join(tempDir, "repo");
		fs.mkdirSync(cwd, { recursive: true });
		writeMcpFixture();
		writeAgent(path.join(cwd, ".pi", "agents", "fanout.md"), `---
name: fanout
description: Project fanout
tools:
  - read
  - subagent
  - /tmp/tool-ext.ts
  - mcp:github/search_repositories
extensions:
  - /tmp/config-ext.ts
subagentOnlyExtensions:
  - /tmp/subagent-only.ts
defaultContext: fork
---
Project prompt.
`);

		const result = await resolveHermeticPreflight({ agent: "fanout", cwd, outputSchema: { type: "object", additionalProperties: false } });
		assert.equal(result.ok, true);
		assert.equal(result.contract.context, "fork");
		assert.ok(result.contract.diagnostics.some((diagnostic) => diagnostic.code === "host_required"));
		assert.deepEqual(result.contract.tools.declaredBuiltin, ["read", "subagent"]);
		assert.equal(result.contract.tools.fanoutAuthorized, true);
		assert.deepEqual(result.contract.tools.internalTools, ["structured_output"]);
		assert.deepEqual(result.contract.tools.effectiveMcpTools, ["github_search_repositories"]);
		assert.deepEqual(result.contract.tools.requiredChildTools, ["read", "subagent", "github_search_repositories", "structured_output"]);
		assert.ok(result.contract.tools.extensionArgs.includes("/tmp/config-ext.ts"));
		assert.ok(result.contract.tools.extensionArgs.includes("/tmp/subagent-only.ts"));
	});

	it("fails closed when a capability ceiling denies read required for child skills", async () => {
		const cwd = path.join(tempDir, "repo");
		fs.mkdirSync(cwd, { recursive: true });
		writeSkill(cwd, "project-skill");
		writeAgent(path.join(cwd, ".pi", "agents", "worker.md"), `---\nname: worker\ndescription: Project worker\ntools:\n  - read\nskills:\n  - project-skill\n---\nProject prompt.\n`);
		const result = await resolveHermeticPreflight({ agent: "worker", cwd, capabilityCeiling: { version: 1, allowedTools: [], denyExtensions: false, sources: ["test"] } });
		assert.equal(result.ok, false);
		assert.equal(result.code, "denied_required_tool");
		assert.match(result.message, /excludes required tool 'read'/);
	});
});

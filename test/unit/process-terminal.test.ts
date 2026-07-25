import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import {
	buildProcessTerminalCandidate,
	finalizeProcessTerminal,
	processTerminalPath,
	readProcessTerminal,
	sanitizeProcessTerminal,
	writeProcessTerminalCandidate,
} from "../../src/runs/background/process-terminal.ts";
import { summarizeAsyncStatus } from "../../src/runs/background/async-status.ts";

test("process-terminal proof requires matching runner and writer close records", () => {
	const asyncDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-process-terminal-"));
	try {
		writeProcessTerminalCandidate(asyncDir, {
			version: 1,
			runId: "run-1",
			runnerProcessInstanceId: "runner-1",
			expectedWriters: { "0": 1, "1": 0 },
			writers: { "0": [{ processInstanceId: "writer-1", kind: "pi-writer", attempt: 0, closeObservedAt: 10, exitCode: 0, signal: null }], "1": [] },
		});
		fs.writeFileSync(path.join(asyncDir, "status.json"), JSON.stringify({
			runId: "run-1",
			state: "complete",
			mode: "chain",
			startedAt: 1,
			lifecycleArtifactVersion: 3,
			steps: [{ agent: "worker", status: "complete" }, { agent: "skipped", status: "failed", exitCode: -1 }],
		}));
		fs.writeFileSync(path.join(asyncDir, "events.jsonl"), "");

		const mismatch = finalizeProcessTerminal(asyncDir, "run-1", { processInstanceId: "runner-2", closeObservedAt: 20, exitCode: 0, signal: null });
		assert.equal(mismatch.state, "unknown");
		assert.equal(mismatch.reason, "runner-instance-mismatch");

		fs.rmSync(processTerminalPath(asyncDir), { force: true });
		const observed = finalizeProcessTerminal(asyncDir, "run-1", { processInstanceId: "runner-1", closeObservedAt: 30, exitCode: 0, signal: null });
		assert.equal(observed.state, "observed");
		assert.equal(observed.instances?.length, 2);
		const status = JSON.parse(fs.readFileSync(path.join(asyncDir, "status.json"), "utf8"));
		assert.equal(status.processTerminal.state, "observed");
		assert.equal(status.steps[0].processTerminal.state, "observed");
		assert.deepEqual(status.steps[0].processTerminal.instances.map((entry: { processInstanceId: string }) => entry.processInstanceId), ["runner-1", "writer-1"]);
		assert.equal(status.steps[1].processTerminal.state, "not-started");
		assert.deepEqual(status.steps[1].processTerminal.instances, []);

		const publicSummary = summarizeAsyncStatus(asyncDir, status);
		assert.equal(publicSummary.steps[0]?.processTerminal?.state, "observed");
		assert.deepEqual(publicSummary.steps[0]?.processTerminal?.instances?.map((entry) => entry.processInstanceId), ["runner-1", "writer-1"]);
		assert.equal(publicSummary.steps[1]?.processTerminal?.state, "not-started");
		assert.deepEqual(publicSummary.steps[1]?.processTerminal?.instances, []);
	} finally {
		fs.rmSync(asyncDir, { recursive: true, force: true });
	}
});

test("process-terminal candidate maps writers by stable stepIndex and ignores aggregate-only results", () => {
	const candidate = buildProcessTerminalCandidate({
		runId: "stable-map",
		runnerProcessInstanceId: "stable-runner",
		stepCount: 3,
		results: [
			{},
			{
				stepIndex: 2,
				writerAttemptCount: 1,
				writerProcesses: [{ processInstanceId: "writer-2", kind: "pi-writer", attempt: 0, closeObservedAt: 20, exitCode: 0, signal: null }],
			},
			{
				stepIndex: 0,
				writerAttemptCount: 1,
				writerProcesses: [{ processInstanceId: "writer-0", kind: "pi-writer", attempt: 0, closeObservedAt: 10, exitCode: 0, signal: null }],
			},
		],
	});

	assert.deepEqual(Object.keys(candidate.writers), ["0", "1", "2"]);
	assert.deepEqual(candidate.expectedWriters, { "0": 1, "1": 0, "2": 1 });
	assert.deepEqual(candidate.writers[1], []);
	assert.equal(candidate.writers[2]?.[0]?.processInstanceId, "writer-2");
	assert.throws(() => buildProcessTerminalCandidate({
		runId: "missing-index",
		runnerProcessInstanceId: "runner",
		stepCount: 1,
		results: [{ writerAttemptCount: 1, writerProcesses: [] }],
	}), /missing a stable stepIndex/);
	assert.throws(() => buildProcessTerminalCandidate({
		runId: "duplicate-index",
		runnerProcessInstanceId: "runner",
		stepCount: 1,
		results: [{ stepIndex: 0 }, { stepIndex: 0 }],
	}), /Duplicate process-terminal writer result/);
	for (const stepIndex of [-1, 1, 0.5]) {
		assert.throws(() => buildProcessTerminalCandidate({
			runId: "invalid-index",
			runnerProcessInstanceId: "runner",
			stepCount: 1,
			results: [{ stepIndex }],
		}), /outside the status step range/);
	}
});

test("process-terminal rejects missing writer close evidence", () => {
	const asyncDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-process-terminal-"));
	try {
		writeProcessTerminalCandidate(asyncDir, {
			version: 1,
			runId: "run-missing-writer",
			runnerProcessInstanceId: "runner-missing-writer",
			expectedWriters: { "0": 1 },
			writers: { "0": [] },
		});
		fs.writeFileSync(path.join(asyncDir, "status.json"), JSON.stringify({ runId: "run-missing-writer", state: "complete", lifecycleArtifactVersion: 3, steps: [{ agent: "worker", status: "complete" }] }));
		fs.writeFileSync(path.join(asyncDir, "events.jsonl"), "");
		const proof = finalizeProcessTerminal(asyncDir, "run-missing-writer", { processInstanceId: "runner-missing-writer", closeObservedAt: 40, exitCode: 1, signal: null });
		assert.equal(proof.state, "unknown");
		assert.equal(proof.reason, "writer-close-unverified");
	} finally {
		fs.rmSync(asyncDir, { recursive: true, force: true });
	}
});

test("malformed process-terminal sidecars project unknown instead of throwing", () => {
	const asyncDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-process-terminal-"));
	try {
		fs.writeFileSync(processTerminalPath(asyncDir), JSON.stringify({ version: 1, state: "bogus" }));
		const proof = readProcessTerminal(asyncDir, { runId: "malformed-run", runnerProcessInstanceId: "malformed-runner" });
		assert.equal(proof?.state, "unknown");
		assert.equal(proof?.reason, "proof-write-failed");
		assert.match(proof?.diagnostic ?? "", /Invalid process-terminal proof/);
		fs.writeFileSync(path.join(asyncDir, "events.jsonl"), "");
		const finalized = finalizeProcessTerminal(asyncDir, "malformed-run", { processInstanceId: "malformed-runner", closeObservedAt: 10, exitCode: 1, signal: null });
		assert.equal(finalized.state, "unknown");
	} finally {
		fs.rmSync(asyncDir, { recursive: true, force: true });
	}
});

test("process-terminal preserves stopped non-resumability and requires lease release acknowledgement", () => {
	const asyncDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-process-terminal-"));
	try {
		writeProcessTerminalCandidate(asyncDir, {
			version: 1,
			runId: "stopped-run",
			runnerProcessInstanceId: "stopped-runner",
			expectedWriters: { "0": 1 },
			writers: { "0": [{ processInstanceId: "stopped-writer", kind: "pi-writer", attempt: 0, closeObservedAt: 10, exitCode: 0, signal: null }] },
			revivalLeaseToken: "lease-token",
			revivalLeaseReleaseAcknowledged: false,
		});
		fs.writeFileSync(path.join(asyncDir, "status.json"), JSON.stringify({ runId: "stopped-run", state: "stopped", lifecycleArtifactVersion: 3, steps: [{ agent: "worker", status: "stopped" }] }));
		fs.writeFileSync(path.join(asyncDir, "events.jsonl"), "");
		const unverified = finalizeProcessTerminal(asyncDir, "stopped-run", { processInstanceId: "stopped-runner", closeObservedAt: 20, exitCode: 0, signal: null });
		assert.equal(unverified.state, "unknown");
		assert.equal(unverified.reason, "canonical-session-release-unverified");

		fs.rmSync(processTerminalPath(asyncDir), { force: true });
		const candidatePath = path.join(asyncDir, "process-terminal-candidate.json");
		const candidate = JSON.parse(fs.readFileSync(candidatePath, "utf8"));
		candidate.revivalLeaseReleaseAcknowledged = true;
		delete candidate.revivalLeaseToken;
		fs.writeFileSync(candidatePath, JSON.stringify(candidate));
		const observed = finalizeProcessTerminal(asyncDir, "stopped-run", { processInstanceId: "stopped-runner", closeObservedAt: 30, exitCode: 0, signal: null });
		assert.equal(observed.state, "observed");
		assert.equal(observed.resumeDisposition, "non-resumable");
	} finally {
		fs.rmSync(asyncDir, { recursive: true, force: true });
	}
});

test("process-terminal rejects cross-run sidecars and inconsistent writer maps", () => {
	const asyncDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-process-terminal-"));
	try {
		fs.writeFileSync(processTerminalPath(asyncDir), JSON.stringify({
			version: 1, state: "observed", runId: "wrong-run", runnerProcessInstanceId: "runner-1", observedAt: 10,
			instances: [{ processInstanceId: "runner-1", kind: "runner", closeObservedAt: 10, exitCode: 0, signal: null }],
		}));
		const crossRun = finalizeProcessTerminal(asyncDir, "actual-run", { processInstanceId: "runner-1", closeObservedAt: 20, exitCode: 0, signal: null });
		assert.equal(crossRun.state, "unknown");
		assert.equal(crossRun.reason, "proof-write-failed");

		fs.rmSync(processTerminalPath(asyncDir), { force: true });
		writeProcessTerminalCandidate(asyncDir, {
			version: 1,
			runId: "actual-run",
			runnerProcessInstanceId: "runner-1",
			expectedWriters: { "0": 0 },
			writers: { "0": [{ processInstanceId: "unexpected-writer", kind: "pi-writer", attempt: 0, closeObservedAt: 10, exitCode: 0, signal: null }] },
		});
		fs.writeFileSync(path.join(asyncDir, "status.json"), JSON.stringify({ runId: "actual-run", state: "complete", lifecycleArtifactVersion: 3, steps: [{ agent: "worker", status: "complete" }] }));
		fs.writeFileSync(path.join(asyncDir, "events.jsonl"), "");
		const inconsistent = finalizeProcessTerminal(asyncDir, "actual-run", { processInstanceId: "runner-1", closeObservedAt: 30, exitCode: 0, signal: null });
		assert.equal(inconsistent.state, "unknown");
		assert.equal(inconsistent.reason, "writer-close-unverified");
	} finally {
		fs.rmSync(asyncDir, { recursive: true, force: true });
	}
});

test("process-terminal rejects missing, out-of-range, and duplicate process mappings", () => {
	const cases = [
		{
			name: "missing step",
			expectedWriters: { "0": 1 },
			writers: { "0": [{ processInstanceId: "writer-0", kind: "pi-writer" as const, attempt: 0, closeObservedAt: 10, exitCode: 0, signal: null }] },
		},
		{
			name: "negative step",
			expectedWriters: { "0": 1, "-1": 0 },
			writers: { "0": [{ processInstanceId: "writer-0", kind: "pi-writer" as const, attempt: 0, closeObservedAt: 10, exitCode: 0, signal: null }], "-1": [] },
		},
		{
			name: "out-of-range step",
			expectedWriters: { "0": 1, "2": 0 },
			writers: { "0": [{ processInstanceId: "writer-0", kind: "pi-writer" as const, attempt: 0, closeObservedAt: 10, exitCode: 0, signal: null }], "2": [] },
		},
		{
			name: "duplicate process id",
			expectedWriters: { "0": 1, "1": 1 },
			writers: {
				"0": [{ processInstanceId: "same-writer", kind: "pi-writer" as const, attempt: 0, closeObservedAt: 10, exitCode: 0, signal: null }],
				"1": [{ processInstanceId: "same-writer", kind: "pi-writer" as const, attempt: 0, closeObservedAt: 11, exitCode: 0, signal: null }],
			},
		},
	];

	for (const entry of cases) {
		const asyncDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-process-terminal-map-"));
		try {
			writeProcessTerminalCandidate(asyncDir, {
				version: 1,
				runId: "mapped-run",
				runnerProcessInstanceId: "mapped-runner",
				expectedWriters: entry.expectedWriters,
				writers: entry.writers,
			});
			fs.writeFileSync(path.join(asyncDir, "status.json"), JSON.stringify({
				runId: "mapped-run",
				state: "complete",
				lifecycleArtifactVersion: 3,
				steps: [{ agent: "first", status: "complete" }, { agent: "second", status: "complete" }],
			}));
			fs.writeFileSync(path.join(asyncDir, "events.jsonl"), "");
			const proof = finalizeProcessTerminal(asyncDir, "mapped-run", { processInstanceId: "mapped-runner", closeObservedAt: 30, exitCode: 0, signal: null });
			assert.equal(proof.state, "unknown", entry.name);
			assert.equal(proof.reason, "writer-close-unverified", entry.name);
		} finally {
			fs.rmSync(asyncDir, { recursive: true, force: true });
		}
	}
});

test("process-terminal sanitizes malformed fallback proofs", () => {
	assert.equal(readProcessTerminal("/no/such/dir", { runId: "run-fallback", runnerProcessInstanceId: "runner-fallback" }), undefined);
	const sanitized = sanitizeProcessTerminal({ version: 1, state: "bogus", runId: "run-fallback", runnerProcessInstanceId: "runner-fallback" }, { runId: "run-fallback", runnerProcessInstanceId: "runner-fallback" }, "status.json");
	assert.equal(sanitized?.state, "unknown");
	assert.equal(sanitized?.reason, "proof-write-failed");
	const inheritedRoot = sanitizeProcessTerminal({
		version: 1,
		state: "not-started",
		runId: "run-fallback",
		childIndex: 0,
		runnerProcessInstanceId: "runner-fallback",
		instances: [{ processInstanceId: "runner-fallback", kind: "runner", closeObservedAt: 1, exitCode: 0, signal: null }],
	}, { runId: "run-fallback", runnerProcessInstanceId: "runner-fallback" }, "status.json step 0");
	assert.equal(inheritedRoot?.state, "unknown");
	assert.equal(inheritedRoot?.instances, undefined);
});

test("process-terminal reports unknown when the runner candidate is unavailable", () => {
	const asyncDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-process-terminal-"));
	try {
		const proof = finalizeProcessTerminal(asyncDir, "run-2", { processInstanceId: "runner-2", closeObservedAt: 40, exitCode: 1, signal: null });
		assert.deepEqual(proof, { version: 1, state: "unknown", runId: "run-2", runnerProcessInstanceId: "runner-2", reason: "runner-candidate-missing" });
	} finally {
		fs.rmSync(asyncDir, { recursive: true, force: true });
	}
});

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import test from "node:test";

test("isolates test temporary artifacts from the user runtime", () => {
	const root = process.env.PI_SUBAGENT_TEST_TEMP_ROOT;
	assert.ok(root);
	assert.equal(os.tmpdir(), root);
	assert.ok(fs.statSync(root).isDirectory());
});

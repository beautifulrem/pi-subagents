import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const base = process.env.PI_SUBAGENT_TEST_TMP_BASE ?? os.tmpdir();
const root = fs.mkdtempSync(path.join(base, "pi-st-"));

process.env.PI_SUBAGENT_TEST_TMP_BASE = base;
process.env.PI_SUBAGENT_TEST_TEMP_ROOT = root;
process.env.TMPDIR = root;
process.env.TMP = root;
process.env.TEMP = root;

process.once("exit", () => {
	fs.rmSync(root, { recursive: true, force: true });
});

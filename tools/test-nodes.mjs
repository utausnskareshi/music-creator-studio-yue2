#!/usr/bin/env node
// `npm run test:nodes`: syntax-check the ComfyUI node pack and run its standalone tests with ComfyUI's embedded
// Python (the node pack imports ComfyUI modules, so the system Python cannot run them). Nothing is written into
// the node pack (no __pycache__: the folder is bundled into the installer as it is).
// Python: MCS_PYTHON, else <data root>/runtime/ComfyUI_windows_portable/python_embeded/python.exe with the data
// root from MCS_DATA_ROOT or C:\MCSYuE2. The tests use the ComfyUI next to that Python (MCS_COMFY_DIR overrides it)
// and look for the MMS_FA weights under the same data root (MCS_TORCH_HOME overrides it). Extra arguments go to the
// test script (--no-model, --comfy <dir>).
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";

const root = process.env.MCS_DATA_ROOT || "C:\\MCSYuE2";
const python = process.env.MCS_PYTHON || join(root, "runtime", "ComfyUI_windows_portable", "python_embeded", "python.exe");
if (!existsSync(python)) {
  console.error(`embedded Python not found: ${python} (set MCS_PYTHON or MCS_DATA_ROOT)`);
  process.exit(2);
}
const env = { ...process.env };
// the ComfyUI of the Python actually used (python_embeded and ComfyUI side by side in the portable layout)
if (!env.MCS_COMFY_DIR) env.MCS_COMFY_DIR = join(dirname(python), "..", "ComfyUI");
if (!env.MCS_TORCH_HOME && process.env.MCS_DATA_ROOT) env.MCS_TORCH_HOME = join(root, "models", "torch");
const pack = join("comfy-nodes", "mcs_yue2_nodes");
const sources = readdirSync(pack)
  .filter((f) => f.endsWith(".py"))
  .map((f) => join(pack, f));
const tests = join("comfy-nodes", "tests", "test_mcs_yue2_nodes.py");
const run = (argv) => spawnSync(python, argv, { stdio: "inherit", env }).status ?? 1;
// compile() in memory (read as bytes: a BOM or coding cookie is handled like py_compile): py_compile would write
// .pyc files next to the sources whatever -B says.
const check = "import sys\nfor f in sys.argv[1:]:\n    with open(f, 'rb') as h:\n        compile(h.read(), f, 'exec')\n";
let status = run(["-B", "-c", check, ...sources, tests]);
if (status === 0) status = run(["-B", "-X", "utf8", tests, ...process.argv.slice(2)]);
process.exit(status);

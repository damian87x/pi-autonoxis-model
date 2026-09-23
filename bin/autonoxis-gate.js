#!/usr/bin/env node
import { parseArgs, readState, runGate } from "../src/gate.mjs";

let opts;
try { opts = parseArgs(process.argv.slice(2)); } catch (e) { console.error(`autonoxis-gate: ${e.message}`); process.exit(2); }
try {
  const result = await runGate(opts, readState(opts));
  console.log(opts.json ? JSON.stringify(result, null, 2) : `${result.passed ? "PASS" : "FAIL"} p=${result.probability} (threshold ${result.threshold})`);
  process.exit(result.passed ? 0 : 1);
} catch (e) {
  console.error(`autonoxis-gate: ${e.message}`);
  process.exit(opts.failOpen ? 0 : 2);
}

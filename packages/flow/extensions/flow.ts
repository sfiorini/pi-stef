import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { homedir } from "node:os";
import { registerSfFlow } from "../src/register.js";
import { registerDiscoveredFlows } from "../src/yaml/register.js";

export default function (pi: ExtensionAPI): void {
  registerSfFlow(pi);
  // Register bundled + user workflow `/<name>` commands. Global defaults are
  // cwd-independent; project workflows cover the project Pi was opened in. Fire
  // and forget — best-effort, errors are warned inside.
  void registerDiscoveredFlows(pi, { repoRoot: process.cwd(), home: homedir() });
}

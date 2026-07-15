import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerSfFlow } from "../src/register.js";

export default function (pi: ExtensionAPI): void {
  registerSfFlow(pi);
}

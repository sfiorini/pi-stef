import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { registerCatalog } from "../src/register.js";

export default function catalogExtension(pi: ExtensionAPI): void {
  registerCatalog(pi);
}

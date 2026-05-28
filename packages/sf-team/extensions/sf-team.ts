import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { registerSfTeam } from "../src/register";

export default function sfTeamExtension(pi: ExtensionAPI): void {
  registerSfTeam(pi);
}

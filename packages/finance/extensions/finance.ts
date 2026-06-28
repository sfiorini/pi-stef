import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerFinanceTools } from "../src/tools";

export default function financeExtension(pi: ExtensionAPI): void {
  registerFinanceTools(pi);
}

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { loadConfig } from "./config";
import { log } from "./logger";
import { getConfigPath } from "./paths";
import { toProviderConfig } from "./register";
import { validate } from "./validate";

export default async function azureFoundryProvider(pi: ExtensionAPI): Promise<void> {
  const raw = loadConfig() as unknown;

  if (!raw || typeof raw !== "object" || !Array.isArray((raw as { deployments?: unknown }).deployments)) {
    log.error(`Config at ${getConfigPath()} must be an object with a 'deployments' array. Skipping registration.`);
    return;
  }

  const deployments = (raw as { deployments: unknown[] }).deployments;
  if (deployments.length === 0) return;

  const seenIds = new Set<string>();
  let registered = 0;

  for (let i = 0; i < deployments.length; i++) {
    const candidate = deployments[i] as { id?: unknown };
    const candidateId = typeof candidate?.id === "string" ? candidate.id : undefined;
    if (candidateId && seenIds.has(candidateId)) {
      log.warn(`Skipped deployments[${i}]: duplicate id "${candidateId}"`);
      continue;
    }

    const result = validate({ deployments: [deployments[i]] });
    if (!result.ok) {
      for (const issue of result.issues) {
        log.warn(`Skipped deployments[${i}]: ${issue.path} - ${issue.message}`);
      }
      continue;
    }

    const deployment = result.value.deployments[0];
    if (!process.env[deployment.apiKeyEnv]) {
      log.info(`Deployment "${deployment.id}" registered, but env var ${deployment.apiKeyEnv} is not set - calls will 401 until you export it.`);
    }

    pi.registerProvider(deployment.id, toProviderConfig(deployment));
    seenIds.add(deployment.id);
    registered++;
  }

  log.info(`Registered ${registered} Azure deployment(s).`);
}

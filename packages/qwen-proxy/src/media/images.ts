import type { UpstreamClient, ImageResult } from "../upstream/client";
import type { RetryDeps } from "../pool/retry";
import type { withPoolRetry as WithPoolRetry } from "../pool/retry";

export const SIZE_TO_RATIO: Record<string, string> = {
  "1024x1024": "1:1",
  "1792x1024": "16:9",
  "1024x1792": "9:16",
};

/** Map an OpenAI-style size string to an aspect ratio. Default "1:1". */
export function sizeToRatio(size?: string): string {
  if (!size) return "1:1";
  return SIZE_TO_RATIO[size] ?? "1:1";
}

export interface MediaImageDeps extends RetryDeps {
  client: Pick<UpstreamClient, "imageGeneration" | "imageEdit">;
  retry: typeof WithPoolRetry;
}

export interface GenerateImageParams {
  prompt: string;
  size?: string;
  /** n>1 coerced to 1 at adapter layer — ignored here */
  n?: number;
}

export interface EditImageParams {
  image: string;
  prompt: string;
}

/**
 * Generate image via upstream.
 * Returns {created, urls}.
 */
export async function generateImage(
  deps: MediaImageDeps,
  params: GenerateImageParams,
): Promise<ImageResult> {
  const ratio = sizeToRatio(params.size);
  return deps.retry(deps, async (_accountId, bearer) => {
    return deps.client.imageGeneration(bearer, {
      prompt: params.prompt,
      size: ratio,
    });
  });
}

/**
 * Edit image via upstream.
 * Returns {created, urls}.
 */
export async function editImage(
  deps: MediaImageDeps,
  params: EditImageParams,
): Promise<ImageResult> {
  return deps.retry(deps, async (_accountId, bearer) => {
    return deps.client.imageEdit(bearer, {
      image: params.image,
      prompt: params.prompt,
    });
  });
}

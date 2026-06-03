import { FigmaAuthorization } from '../auth/FigmaAuthorization';
import { FigmaApiError } from '../client/FigmaErrors';
import { FIGMA_API_BASE } from '../client/FigmaClient';
import type {
  FigmaNodesResponse,
  FigmaNode,
} from '../schemas';
import { FigmaNodesResponseSchema } from '../schemas';
import { parseFigmaReference, requireNodeId } from '../url';

export type { FigmaApiError } from '../client/FigmaErrors';

/** REST API client for Figma node fetching via personal access token. */
export class FigmaApi {
  private auth: FigmaAuthorization;

  constructor(auth?: FigmaAuthorization) {
    this.auth = auth ?? new FigmaAuthorization();
  }

  /** Parse a Figma URL into fileKey and nodeId, throwing on invalid input. */
  parseUrl(url: string): { fileKey: string; nodeId: string } {
    const ref = parseFigmaReference(url);
    return { fileKey: ref.fileKey, nodeId: requireNodeId(ref) };
  }

  /** Fetch node data from Figma API. */
  async getNodes(
    fileKey: string,
    nodeIds: string[],
    init?: RequestInit,
  ): Promise<FigmaNodesResponse> {
    if (nodeIds.length === 0) {
      throw new Error('At least one node ID is required');
    }

    const ids = nodeIds.join(',');
    const url = `${FIGMA_API_BASE}/files/${fileKey}/nodes?ids=${encodeURIComponent(ids)}`;

    const response = await this.auth.fetch(url, init);

    if (!response.ok) {
      const errorBody = await response.text().catch(() => 'Unknown error');
      throw new FigmaApiError(
        `Figma API error: ${response.status} ${response.statusText}`,
        response.status,
        errorBody,
      );
    }

    const json = (await response.json()) as unknown;
    const parsed = FigmaNodesResponseSchema.safeParse(json);

    if (!parsed.success) {
      throw new FigmaApiError(
        `Invalid Figma API response: ${parsed.error.message}`,
        response.status,
        json,
      );
    }

    return parsed.data;
  }

  /** Fetch a single node by Figma URL. */
  async getNodeByUrl(url: string, init?: RequestInit): Promise<FigmaNode> {
    const { fileKey, nodeId } = this.parseUrl(url);
    const response = await this.getNodes(fileKey, [nodeId], init);

    const nodeData = response.nodes[nodeId];
    if (!nodeData) {
      throw new FigmaApiError(
        `Node not found in response: ${nodeId}`,
        undefined,
        response,
      );
    }

    return nodeData.document;
  }
}

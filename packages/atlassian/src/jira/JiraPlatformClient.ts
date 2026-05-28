import { mkdir, writeFile } from "node:fs/promises";
import { extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { AtlassianClient } from "../http/AtlassianClient";
import type { QueryValue } from "../http/AtlassianClient";
import { plainTextToAdf, textOrAdfToAdf } from "../text/adf";

export interface JiraHttp {
  get<T>(path: string, options?: { query?: Record<string, QueryValue>; signal?: AbortSignal }): Promise<T>;
  post<T>(path: string, body?: unknown, options?: { query?: Record<string, QueryValue>; signal?: AbortSignal }): Promise<T>;
  put<T>(path: string, body?: unknown, options?: { query?: Record<string, QueryValue>; signal?: AbortSignal }): Promise<T>;
  delete<T>(path: string, options?: { query?: Record<string, QueryValue>; signal?: AbortSignal }): Promise<T>;
  getBuffer(path: string, options?: { signal?: AbortSignal }): Promise<ArrayBuffer>;
  readonly baseUrl?: string;
}

export interface IssueFieldInput {
  fields?: Record<string, unknown>;
  projectKey?: string;
  projectId?: string | number;
  issueTypeName?: string;
  issueTypeId?: string;
  summary?: string;
  description?: string | unknown;
}

export interface DownloadedAttachment {
  id: string;
  originalFilename: string;
  filename: string;
  outputPath: string;
  mimeType?: string;
  size?: number;
}

export interface AttachmentDownloadResult {
  outputDir: string;
  attachments: DownloadedAttachment[];
}

const DEFAULT_ATTACHMENT_OUTPUT_DIR = fileURLToPath(new URL("../../.sf-runtime/atlassian/attachments", import.meta.url));
const JIRA_WORKLOG_STARTED_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}[+-]\d{4}$/;

export class JiraPlatformClient {
  constructor(private readonly http: JiraHttp = new AtlassianClient()) {}

  get baseUrl(): string {
    return this.http.baseUrl ?? "";
  }

  async listProjects(params: { startAt?: number; maxResults?: number; orderBy?: string; query?: string; typeKey?: string; categoryId?: number; action?: string; signal?: AbortSignal } = {}): Promise<unknown> {
    const { signal, ...query } = params;
    return this.http.get("/rest/api/3/project/search", options(query, signal));
  }

  async searchIssues(params: { jql: string; fields?: string[]; expand?: string[]; properties?: string[]; maxResults?: number; nextPageToken?: string; fieldsByKeys?: boolean; reconcileIssues?: number[]; signal?: AbortSignal }): Promise<unknown> {
    const { signal, ...body } = params;
    return this.http.post("/rest/api/3/search/jql", clean(body), { signal });
  }

  async createIssue(params: IssueFieldInput & { update?: Record<string, unknown>; signal?: AbortSignal }): Promise<unknown> {
    const { update, signal, ...fieldInput } = params;
    return this.http.post("/rest/api/3/issue", clean({ fields: buildIssueFields(fieldInput), update }), { signal });
  }

  async updateIssue(params: IssueFieldInput & { issueIdOrKey: string; update?: Record<string, unknown>; notifyUsers?: boolean; overrideScreenSecurity?: boolean; overrideEditableFlag?: boolean; signal?: AbortSignal }): Promise<void> {
    const { issueIdOrKey, update, notifyUsers, overrideScreenSecurity, overrideEditableFlag, signal, ...fieldInput } = params;
    await this.http.put(
      `/rest/api/3/issue/${encodeURIComponent(issueIdOrKey)}`,
      clean({ fields: buildIssueFields(fieldInput), update }),
      options({ notifyUsers, overrideScreenSecurity, overrideEditableFlag }, signal),
    );
  }

  async deleteIssue(params: { issueIdOrKey: string; deleteSubtasks?: boolean; signal?: AbortSignal }): Promise<void> {
    const { issueIdOrKey, deleteSubtasks, signal } = params;
    await this.http.delete(`/rest/api/3/issue/${encodeURIComponent(issueIdOrKey)}`, options({ deleteSubtasks }, signal));
  }

  async getIssue(params: { issueIdOrKey: string; fields?: string[]; expand?: string[]; properties?: string[]; fieldsByKeys?: boolean; updateHistory?: boolean; signal?: AbortSignal }): Promise<unknown> {
    const { issueIdOrKey, signal, ...query } = params;
    return this.http.get(`/rest/api/3/issue/${encodeURIComponent(issueIdOrKey)}`, options(query, signal));
  }

  async getTransitions(params: { issueIdOrKey: string; transitionId?: string; includeUnavailableTransitions?: boolean; skipRemoteOnlyCondition?: boolean; signal?: AbortSignal }): Promise<unknown> {
    const { issueIdOrKey, signal, ...query } = params;
    return this.http.get(`/rest/api/3/issue/${encodeURIComponent(issueIdOrKey)}/transitions`, options(query, signal));
  }

  async transitionIssue(params: { issueIdOrKey: string; transitionId: string; fields?: Record<string, unknown>; update?: Record<string, unknown>; historyMetadata?: Record<string, unknown>; comment?: string | unknown; signal?: AbortSignal }): Promise<void> {
    const { issueIdOrKey, transitionId, comment, signal, ...rest } = params;
    await this.http.post(
      `/rest/api/3/issue/${encodeURIComponent(issueIdOrKey)}/transitions`,
      clean({
        transition: { id: transitionId },
        ...rest,
        update: mergeCommentUpdate(rest.update, comment),
      }),
      { signal },
    );
  }

  async addComment(params: { issueIdOrKey: string; body: string | unknown; visibility?: Record<string, unknown>; properties?: unknown[]; signal?: AbortSignal }): Promise<unknown> {
    const { issueIdOrKey, body, visibility, properties, signal } = params;
    return this.http.post(
      `/rest/api/3/issue/${encodeURIComponent(issueIdOrKey)}/comment`,
      clean({ body: textOrAdfToAdf(body), visibility, properties }),
      { signal },
    );
  }

  async getComments(params: { issueIdOrKey: string; startAt?: number; maxResults?: number; orderBy?: string; expand?: string[]; signal?: AbortSignal }): Promise<unknown> {
    const { issueIdOrKey, signal, ...query } = params;
    return this.http.get(`/rest/api/3/issue/${encodeURIComponent(issueIdOrKey)}/comment`, options(query, signal));
  }

  async getRemoteLinks(params: { issueIdOrKey: string; globalId?: string; signal?: AbortSignal }): Promise<unknown> {
    const { issueIdOrKey, signal, ...query } = params;
    return this.http.get(`/rest/api/2/issue/${encodeURIComponent(issueIdOrKey)}/remotelink`, options(query, signal));
  }

  async getWorklog(params: { issueIdOrKey: string; startAt?: number; maxResults?: number; startedAfter?: number; startedBefore?: number; expand?: string[]; signal?: AbortSignal }): Promise<unknown> {
    const { issueIdOrKey, signal, ...query } = params;
    return this.http.get(`/rest/api/3/issue/${encodeURIComponent(issueIdOrKey)}/worklog`, options(query, signal));
  }

  async addWorklog(params: { issueIdOrKey: string; timeSpent?: string; timeSpentSeconds?: number; started: string; comment?: string | unknown; adjustEstimate?: string; newEstimate?: string; reduceBy?: string; signal?: AbortSignal }): Promise<unknown> {
    if (!JIRA_WORKLOG_STARTED_PATTERN.test(params.started)) {
      throw new Error("Jira worklog started must use YYYY-MM-DDTHH:mm:ss.SSSZ with a numeric offset, for example 2026-05-04T09:30:00.000+0000.");
    }
    const { issueIdOrKey, adjustEstimate, newEstimate, reduceBy, signal, comment, ...body } = params;
    return this.http.post(
      `/rest/api/3/issue/${encodeURIComponent(issueIdOrKey)}/worklog`,
      clean({ ...body, comment: comment === undefined ? undefined : textOrAdfToAdf(comment) }),
      options({ adjustEstimate, newEstimate, reduceBy }, signal),
    );
  }

  async getIssueLinkTypes(params: { signal?: AbortSignal } = {}): Promise<unknown> {
    return this.http.get("/rest/api/3/issueLinkType", { signal: params.signal });
  }

  async createIssueLink(params: { typeName?: string; typeId?: string; inwardIssueKey: string; outwardIssueKey: string; comment?: string | unknown; signal?: AbortSignal }): Promise<void> {
    const { typeName, typeId, inwardIssueKey, outwardIssueKey, comment, signal } = params;
    await this.http.post(
      "/rest/api/3/issueLink",
      clean({
        type: typeId ? { id: typeId } : { name: typeName },
        inwardIssue: { key: inwardIssueKey },
        outwardIssue: { key: outwardIssueKey },
        comment: comment === undefined ? undefined : { body: textOrAdfToAdf(comment) },
      }),
      { signal },
    );
  }

  async removeIssueLink(params: { linkId: string; signal?: AbortSignal }): Promise<void> {
    await this.http.delete(`/rest/api/3/issueLink/${encodeURIComponent(params.linkId)}`, { signal: params.signal });
  }

  async getProjectVersions(params: { projectIdOrKey: string; expand?: string; signal?: AbortSignal }): Promise<unknown> {
    const { projectIdOrKey, signal, ...query } = params;
    return this.http.get(`/rest/api/3/project/${encodeURIComponent(projectIdOrKey)}/versions`, options(query, signal));
  }

  async createVersion(params: { projectId?: number; project?: string; name: string; description?: string; archived?: boolean; released?: boolean; releaseDate?: string; startDate?: string; signal?: AbortSignal }): Promise<unknown> {
    const { signal, ...body } = params;
    return this.http.post("/rest/api/3/version", clean(body), { signal });
  }

  async getProjectIssues(params: { projectIdOrKey: string; fields?: string[]; maxResults?: number; nextPageToken?: string; signal?: AbortSignal }): Promise<unknown> {
    const { projectIdOrKey, signal, ...rest } = params;
    return this.searchIssues({ jql: `project = "${projectIdOrKey.replace(/"/g, '\\"')}"`, ...rest, signal });
  }

  async searchFields(params: { startAt?: number; maxResults?: number; type?: string; id?: string[]; query?: string; orderBy?: string; expand?: string[]; signal?: AbortSignal } = {}): Promise<unknown> {
    const { signal, ...query } = params;
    return this.http.get("/rest/api/3/field/search", options(query, signal));
  }

  async getUserProfile(params: { accountId?: string; username?: string; key?: string; expand?: string; signal?: AbortSignal }): Promise<unknown> {
    const { signal, ...query } = params;
    return this.http.get("/rest/api/3/user", options(query, signal));
  }

  async batchGetChangelogs(params: { issueIdsOrKeys: string[]; fieldIds?: string[]; maxResults?: number; nextPageToken?: string; signal?: AbortSignal }): Promise<unknown> {
    const { signal, ...body } = params;
    return this.http.post("/rest/api/3/changelog/bulkfetch", clean(body), { signal });
  }

  async batchCreateIssues(params: { issues: Array<IssueFieldInput & { update?: Record<string, unknown> }>; signal?: AbortSignal }): Promise<unknown> {
    const { issues, signal } = params;
    return this.http.post(
      "/rest/api/3/issue/bulk",
      { issueUpdates: issues.map(({ update, ...fieldInput }) => clean({ fields: buildIssueFields(fieldInput), update })) },
      { signal },
    );
  }

  async batchCreateVersions(params: { versions: Array<Parameters<JiraPlatformClient["createVersion"]>[0]>; signal?: AbortSignal }): Promise<unknown[]> {
    const results: unknown[] = [];
    for (const version of params.versions) {
      results.push(await this.createVersion({ ...version, signal: params.signal }));
    }
    return results;
  }

  async downloadAttachments(params: { issueIdOrKey?: string; attachmentIds?: string[]; outputDir?: string; signal?: AbortSignal }): Promise<AttachmentDownloadResult> {
    const attachments = await this.resolveAttachments(params);
    const outputDir = resolve(params.outputDir ?? DEFAULT_ATTACHMENT_OUTPUT_DIR);
    await mkdir(outputDir, { recursive: true });

    const usedNames = new Set<string>();
    const downloaded: DownloadedAttachment[] = [];
    for (const attachment of attachments) {
      const id = getString(attachment.id);
      if (!id) continue;
      const originalFilename = getString(attachment.filename) || `attachment-${id}`;
      const filename = uniqueFilename(sanitizeFilename(originalFilename), usedNames);
      const outputPath = resolve(join(outputDir, filename));
      if (!outputPath.startsWith(`${outputDir}/`) && outputPath !== outputDir) {
        throw new Error(`Refusing to write attachment outside output directory: ${originalFilename}`);
      }
      const bytes = Buffer.from(await this.http.getBuffer(`/rest/api/3/attachment/content/${encodeURIComponent(id)}`, { signal: params.signal }));
      await writeFile(outputPath, bytes);
      downloaded.push({
        id,
        originalFilename,
        filename,
        outputPath,
        mimeType: getString(attachment.mimeType) || undefined,
        size: getNumber(attachment.size),
      });
    }

    return { outputDir, attachments: downloaded };
  }

  private async resolveAttachments(params: { issueIdOrKey?: string; attachmentIds?: string[]; signal?: AbortSignal }): Promise<Array<Record<string, unknown>>> {
    const byId = new Map<string, Record<string, unknown>>();
    if (params.issueIdOrKey) {
      const issue = asRecord(await this.getIssue({ issueIdOrKey: params.issueIdOrKey, fields: ["attachment"], signal: params.signal }));
      const attachments = asArray(asRecord(issue.fields).attachment);
      for (const attachment of attachments.map(asRecord)) {
        const id = getString(attachment.id);
        if (id) byId.set(id, attachment);
      }
    }
    for (const id of params.attachmentIds ?? []) {
      if (byId.has(id)) continue;
      byId.set(id, asRecord(await this.http.get(`/rest/api/3/attachment/${encodeURIComponent(id)}`, { signal: params.signal })));
    }
    return [...byId.values()];
  }
}

function buildIssueFields(input: IssueFieldInput): Record<string, unknown> {
  const fields: Record<string, unknown> = { ...(input.fields ?? {}) };
  if (input.projectKey || input.projectId) fields.project = input.projectId ? { id: String(input.projectId) } : { key: input.projectKey };
  if (input.issueTypeId || input.issueTypeName) fields.issuetype = input.issueTypeId ? { id: input.issueTypeId } : { name: input.issueTypeName };
  if (input.summary !== undefined) fields.summary = input.summary;
  if (input.description !== undefined) fields.description = textOrAdfToAdf(input.description);
  return fields;
}

function mergeCommentUpdate(update: Record<string, unknown> | undefined, comment: string | unknown): Record<string, unknown> | undefined {
  if (comment === undefined) return update;
  const existing = asRecord(update);
  const comments = Array.isArray(existing.comment) ? existing.comment : [];
  return { ...existing, comment: [...comments, { add: { body: textOrAdfToAdf(comment) } }] };
}

function clean<T extends Record<string, unknown>>(value: T): T {
  return Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined)) as T;
}

function options(query: Record<string, unknown>, signal?: AbortSignal): { query?: Record<string, QueryValue>; signal?: AbortSignal } {
  const cleaned = clean(query) as Record<string, QueryValue>;
  return Object.keys(cleaned).length ? { query: cleaned, signal } : { signal };
}

function sanitizeFilename(value: string): string {
  const sanitized = value.replace(/[\\/]/g, "_").replace(/[^A-Za-z0-9._-]/g, "_").replace(/^_+/, "");
  return sanitized || "attachment";
}

function uniqueFilename(filename: string, usedNames: Set<string>): string {
  if (!usedNames.has(filename)) {
    usedNames.add(filename);
    return filename;
  }
  const extension = extname(filename);
  const basename = extension ? filename.slice(0, -extension.length) : filename;
  let index = 2;
  while (usedNames.has(`${basename}-${index}${extension}`)) index += 1;
  const next = `${basename}-${index}${extension}`;
  usedNames.add(next);
  return next;
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
}

function getString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function getNumber(value: unknown): number | undefined {
  return typeof value === "number" ? value : undefined;
}

export { plainTextToAdf };

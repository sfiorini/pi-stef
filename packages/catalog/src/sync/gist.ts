import { execFile } from "node:child_process";
import { Octokit } from "@octokit/rest";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Map of filename → file content for gist operations. */
export interface GistFiles {
  [filename: string]: string;
}

/** Result of a gist create or update operation. */
export interface GistResult {
  id: string;
  url?: string;
}

/** Minimal shape of a gist returned from list/find operations. */
export interface GistSummary {
  id: string;
  description?: string;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Execute a command via `execFile` and return a promise.
 */
function exec(
  command: string,
  args: string[],
  options?: { stdin?: string },
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = execFile(
      command,
      args,
      { maxBuffer: 1024 * 1024 },
      (error, stdout, stderr) => {
        if (error) {
          reject(error);
          return;
        }
        resolve({
          stdout: typeof stdout === "string" ? stdout : String(stdout ?? ""),
          stderr: typeof stderr === "string" ? stderr : String(stderr ?? ""),
        });
      },
    );
    if (options?.stdin !== undefined && child.stdin) {
      child.stdin.write(options.stdin);
      child.stdin.end();
    }
  });
}

/**
 * Lazy-initialized Octokit instance (only created when needed as fallback).
 */
let _octokit: InstanceType<typeof Octokit> | null = null;
function getOctokit(): InstanceType<typeof Octokit> {
  if (!_octokit) {
    _octokit = new Octokit();
  }
  return _octokit;
}

/** Reset the cached Octokit (used by tests to ensure fresh mocks). */
export function _resetOctokit(): void {
  _octokit = null;
}

/**
 * Build the JSON body for the GitHub Gists API from a GistFiles map.
 */
function gistApiBody(files: GistFiles): Record<string, { content: string }> {
  const result: Record<string, { content: string }> = {};
  for (const [name, content] of Object.entries(files)) {
    result[name] = { content };
  }
  return result;
}

// ---------------------------------------------------------------------------
// createGist
// ---------------------------------------------------------------------------

/**
 * Create a new GitHub Gist with the given files and description.
 *
 * Tries `gh api` first; falls back to the Octokit REST API if the
 * `gh` CLI is unavailable.
 */
export async function createGist(
  files: GistFiles,
  description: string,
): Promise<GistResult> {
  // --- Try gh CLI first ---
  try {
    const body = JSON.stringify({
      description,
      public: false,
      files: gistApiBody(files),
    });

    const { stdout } = await exec("gh", [
      "api",
      "--method", "POST",
      "/gists",
      "--input", "-",
    ], { stdin: body });

    const data = JSON.parse(stdout);
    return { id: data.id, url: data.html_url };
  } catch (ghError) {
    // gh was found but the API call failed, or gh was not found (ENOENT).
    // Fall through to octokit in either case.

    // --- Fallback: Octokit REST API ---
    const octokit = getOctokit();
    const response = await octokit.gists.create({
      description,
      public: false,
      files: gistApiBody(files),
    });

    return {
      id: response.data.id!,
      url: response.data.html_url ?? undefined,
    };
  }
}

// ---------------------------------------------------------------------------
// readGist
// ---------------------------------------------------------------------------

/**
 * Fetch a GitHub Gist by ID and return its files.
 *
 * Tries `gh gist view --json` first; falls back to Octokit.
 */
export async function readGist(gistId: string): Promise<{
  id: string;
  files: Record<string, { content: string }>;
}> {
  // --- Try gh CLI first ---
  try {
    const { stdout } = await exec("gh", [
      "gist", "view", gistId, "--json", "id,files",
    ]);

    const data = JSON.parse(stdout);
    return {
      id: data.id,
      files: data.files,
    };
  } catch {
    // --- Fallback: Octokit REST API ---
    const octokit = getOctokit();
    const response = await octokit.gists.get({ gist_id: gistId });

    const files: Record<string, { content: string }> = {};
    for (const [name, file] of Object.entries(response.data.files ?? {})) {
      files[name] = { content: (file as { content?: string }).content ?? "" };
    }

    return { id: response.data.id!, files };
  }
}

// ---------------------------------------------------------------------------
// updateGist
// ---------------------------------------------------------------------------

/**
 * Update an existing GitHub Gist with new file contents.
 *
 * Tries `gh api` first; falls back to Octokit.
 */
export async function updateGist(
  gistId: string,
  files: GistFiles,
): Promise<GistResult> {
  // --- Try gh CLI first ---
  try {
    const body = JSON.stringify({
      files: gistApiBody(files),
    });

    const { stdout } = await exec("gh", [
      "api",
      "--method", "PATCH",
      `/gists/${gistId}`,
      "--input", "-",
    ], { stdin: body });

    const data = JSON.parse(stdout);
    return { id: data.id, url: data.html_url };
  } catch {
    // --- Fallback: Octokit REST API ---
    const octokit = getOctokit();
    const response = await octokit.gists.update({
      gist_id: gistId,
      files: gistApiBody(files),
    });

    return {
      id: response.data.id!,
      url: response.data.html_url ?? undefined,
    };
  }
}

// ---------------------------------------------------------------------------
// findGistByDescription
// ---------------------------------------------------------------------------

/**
 * Find an existing Gist by its description field.
 *
 * Tries `gh gist list --json` first; falls back to Octokit.
 * Returns `undefined` if no matching gist is found.
 */
export async function findGistByDescription(
  description: string,
): Promise<GistSummary | undefined> {
  // --- Try gh CLI first ---
  try {
    const { stdout } = await exec("gh", [
      "gist", "list", "--json", "id,description",
    ]);

    const gists: Array<{ id: string; description?: string }> = JSON.parse(stdout);
    return gists.find((g) => g.description === description);
  } catch {
    // --- Fallback: Octokit REST API ---
    try {
      const octokit = getOctokit();
      const response = await octokit.gists.list();

      const raw = response.data as Array<{ id: string; description: string | null | undefined }>;
      const found = raw.find((g) => g.description === description);
      if (!found) return undefined;
      return { id: found.id, description: found.description ?? undefined };
    } catch {
      return undefined;
    }
  }
}

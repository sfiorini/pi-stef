/**
 * Per-payload secret scan, ported from `do-task` SKILL.md.
 *
 * Locked plan decision #21: every reviewer/developer/planner spawn payload
 * (task body + appended system prompt) is scanned before exec. The scan is
 * STATELESS — no caching, no rate limiting — and returns a structured report
 * the spawner uses to refuse exec on any hit.
 *
 * Patterns are anchored regexes for the common credential families. A hit
 * identifies the family and returns a minimally redacted snippet (first 4
 * chars + `***`) so callers can include it in error messages without leaking
 * the secret value itself.
 */

export interface SecretHit {
  kind: string;
  /** Redacted preview ("AKIA****") so callers can show what tripped without leaking. */
  preview: string;
  /** 0-based offset where the match started. Useful for diagnostics. */
  offset: number;
}

interface PatternEntry {
  kind: string;
  pattern: RegExp;
}

const PATTERNS: PatternEntry[] = [
  // AWS access key id (AKIA / ASIA prefix, 16-char alnum)
  { kind: "aws-access-key-id", pattern: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g },
  // AWS secret (40-char base64-ish in close proximity to "aws_secret"); coarser pattern
  { kind: "aws-secret-access-key", pattern: /\b(?:aws_secret_access_key|aws-secret-access-key)\s*[:=]\s*["']?[A-Za-z0-9/+=]{40}["']?/gi },
  // GitHub PAT classic
  { kind: "github-pat", pattern: /\bghp_[A-Za-z0-9]{36,251}\b/g },
  // GitHub fine-grained PAT
  { kind: "github-pat-fg", pattern: /\bgithub_pat_[A-Za-z0-9_]{60,}\b/g },
  // GitHub OAuth tokens
  { kind: "github-oauth", pattern: /\bgho_[A-Za-z0-9]{36,251}\b/g },
  // GitHub user-to-server / app tokens
  { kind: "github-app", pattern: /\b(?:ghu_|ghs_|ghr_)[A-Za-z0-9]{36,251}\b/g },
  // Slack tokens
  { kind: "slack-token", pattern: /\bxox[abprs]-[A-Za-z0-9-]{10,}\b/g },
  // OpenAI API keys
  { kind: "openai-key", pattern: /\bsk-(?:proj-)?[A-Za-z0-9_-]{20,}\b/g },
  // Anthropic API keys
  { kind: "anthropic-key", pattern: /\bsk-ant-[A-Za-z0-9-]{40,}\b/g },
  // JWT tokens (eyJ-prefixed three-segment base64url)
  { kind: "jwt", pattern: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{5,}\b/g },
  // PEM private key blocks
  { kind: "pem-private-key", pattern: /-----BEGIN (?:RSA|EC|OPENSSH|DSA|PGP|ENCRYPTED) PRIVATE KEY-----/g },
  // Generic private key blocks
  { kind: "pem-private-key-generic", pattern: /-----BEGIN PRIVATE KEY-----/g },
  // dotenv-style API_KEY/TOKEN/SECRET assignments with high-entropy values
  {
    kind: "dotenv-assignment",
    pattern: /(?:^|\n)\s*[A-Z][A-Z0-9_]*(?:_KEY|_TOKEN|_SECRET|_PASSWORD)\s*=\s*["']?[A-Za-z0-9!@#$%^&*()_+={}\[\]:;<>,.?\/|`~\\-]{16,}["']?/g,
  },
];

export interface ScanReport {
  hits: SecretHit[];
}

export function scanForSecrets(payload: string): ScanReport {
  if (typeof payload !== "string" || payload.length === 0) return { hits: [] };
  const hits: SecretHit[] = [];
  for (const { kind, pattern } of PATTERNS) {
    pattern.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(payload)) !== null) {
      const text = match[0];
      hits.push({ kind, preview: redact(text), offset: match.index });
      // Avoid pathological infinite loops on zero-width matches.
      if (match.index === pattern.lastIndex) pattern.lastIndex += 1;
    }
  }
  return { hits };
}

function redact(text: string): string {
  if (text.length <= 4) return "****";
  return `${text.slice(0, 4)}****`;
}

export class SecretsInPayloadError extends Error {
  readonly hits: SecretHit[];
  constructor(role: string, hits: SecretHit[]) {
    super(
      `sf-team refused to spawn ${role} agent: ${hits.length} secret pattern(s) detected in payload (` +
        hits.map((h) => `${h.kind}=${h.preview}`).join(", ") +
        ")",
    );
    this.name = "SecretsInPayloadError";
    this.hits = hits;
  }
}

/**
 * Auth module: CookieJar (ssxmod refresh) + AuthScheduler (per-account JWT
 * refresh + on-demand 401) + createInternalLogin (S2 built-in login).
 */

import { createHash } from "node:crypto";
import * as jose from "jose";
import type Database from "better-sqlite3";
import type { QwenProxyConfig } from "../config/types";
import type { Logger } from "../server/logger";
import { generateCookies, type CookiePair } from "./ssxmod";
import { upsertToken, recordLoginFailure } from "../store/repo";

// ── Public types ────────────────────────────────────────────────────────────

export interface LoginResult {
  bearer: string;
  expiresAt: number | null;
}

export type LoginFn = (email: string, password: string) => Promise<LoginResult>;

export interface AuthSchedulerDeps {
  db: Database.Database;
  config: QwenProxyConfig;
  cookies: CookieJar;
  login: LoginFn;
  log: Logger;
  now?: () => number;
}

// ── decodeExpiryMs ──────────────────────────────────────────────────────────

/**
 * Decode a JWT bearer token and return its `exp` claim in milliseconds.
 * Returns null if the token is not a valid JWT or has no `exp` claim.
 * Uses jose.decodeJwt (no signature verification).
 */
export function decodeExpiryMs(bearer: string): number | null {
  try {
    const claims = jose.decodeJwt(bearer);
    if (claims.exp != null) {
      return claims.exp * 1000; // seconds → ms
    }
    return null;
  } catch {
    return null;
  }
}

// ── CookieJar ───────────────────────────────────────────────────────────────

export class CookieJar {
  private intervalMs: number;
  private pair: CookiePair;
  private interval: ReturnType<typeof setInterval> | null = null;

  constructor(intervalMs: number) {
    this.intervalMs = intervalMs;
    this.pair = generateCookies();
  }

  get(): CookiePair {
    return this.pair;
  }

  start(): void {
    if (this.interval !== null) return; // idempotent: don't leak a second interval
    // Refresh immediately
    this.pair = generateCookies();
    this.interval = setInterval(() => {
      this.pair = generateCookies();
    }, this.intervalMs);
  }

  stop(): void {
    if (this.interval !== null) {
      clearInterval(this.interval);
      this.interval = null;
    }
  }
}

// ── AuthScheduler ───────────────────────────────────────────────────────────

interface AccountTimer {
  type: "timeout" | "interval";
  id: ReturnType<typeof setTimeout> | ReturnType<typeof setInterval>;
}

export class AuthScheduler {
  private db: Database.Database;
  private config: QwenProxyConfig;
  private cookies: CookieJar;
  private login: LoginFn;
  private log: Logger;
  private now: () => number;
  private timers = new Map<number, AccountTimer>();
  private nonJwtWarned = new Set<number>();
  private mutexes = new Map<number, Promise<LoginResult> | null>();
  private pendingStartLogins: Promise<void>[] = [];

  constructor(deps: AuthSchedulerDeps) {
    this.db = deps.db;
    this.config = deps.config;
    this.cookies = deps.cookies;
    this.login = deps.login;
    this.log = deps.log;
    this.now = deps.now ?? (() => Date.now());
  }

  async start(): Promise<void> {
    // Start cookie refresh interval
    this.cookies.start();

    // Collect all accounts
    const accounts = this.db
      .prepare("SELECT id, email, password FROM accounts")
      .all() as { id: number; email: string; password: string }[];

    // Shuffle accounts for staggered startup (Fisher-Yates)
    const shuffled = [...accounts];
    for (let i = shuffled.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
    }

    const loginPromises: Promise<void>[] = [];
    for (const acct of shuffled) {
      const delay = Math.floor(Math.random() * this.config.staggerMs);
      const p = new Promise<void>((resolve) => {
        setTimeout(() => {
          this.loginAndSchedule(acct.id, acct.email, acct.password)
            .catch((err) => {
              this.log.error("startup login failed", {
                accountId: acct.id,
                error: err instanceof Error ? err.message : String(err),
              });
            })
            .finally(resolve);
        }, delay);
      });
      loginPromises.push(p);
    }

    this.pendingStartLogins = loginPromises;
    await Promise.all(loginPromises);
  }

  /**
   * Wait for any pending staggered startup logins to complete.
   * Useful in tests after advancing fake timers.
   */
  async awaitStart(): Promise<void> {
    await Promise.all(this.pendingStartLogins);
  }

  private async loginAndSchedule(
    accountId: number,
    email: string,
    password: string,
  ): Promise<LoginResult> {
    try {
      const result = await this.login(email, password);
      upsertToken(this.db, accountId, result.bearer, result.expiresAt);
      this.scheduleAccount(accountId, result.expiresAt);
      return result;
    } catch (err) {
      recordLoginFailure(
        this.db,
        accountId,
        err instanceof Error ? err.message : String(err),
      );
      throw err;
    }
  }

  scheduleAccount(accountId: number, expiresAt: number | null): void {
    // Clear any existing timer for this account
    this.clearAccountTimer(accountId);

    if (expiresAt != null) {
      // JWT path: setTimeout at max(jwtRefreshMs, expiresAt - refreshThresholdMs)
      const delay = Math.max(
        this.config.jwtRefreshMs,
        expiresAt - this.config.refreshThresholdMs - this.now(),
      );

      const timerId = setTimeout(() => {
        this.handleRefresh(accountId);
      }, delay);

      this.timers.set(accountId, { type: "timeout", id: timerId });
    } else {
      // Non-JWT path: fixed interval + warn once
      if (!this.nonJwtWarned.has(accountId)) {
        this.nonJwtWarned.add(accountId);
        this.log.warn(
          "token is not a decodable JWT; using fixed refresh cadence",
          { accountId },
        );
      }

      const timerId = setInterval(() => {
        this.handleRefresh(accountId);
      }, this.config.jwtRefreshMs);

      this.timers.set(accountId, { type: "interval", id: timerId });
    }
  }

  private async handleRefresh(accountId: number): Promise<void> {
    try {
      await this.loginWithMutex(accountId);
    } catch (err) {
      this.log.error("refresh login failed", {
        accountId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  async refreshOnDemand(accountId: number): Promise<LoginResult> {
    return this.loginWithMutex(accountId);
  }

  /**
   * Shared mutex for both timer-triggered and on-demand refreshes.
   * If a login is already in flight for this account, waits for it.
   */
  private async loginWithMutex(accountId: number): Promise<LoginResult> {
    const existing = this.mutexes.get(accountId);
    if (existing) {
      return existing;
    }

    const promise = this.doRefresh(accountId);
    this.mutexes.set(accountId, promise);

    try {
      return await promise;
    } finally {
      this.mutexes.delete(accountId);
    }
  }

  private async doRefresh(accountId: number): Promise<LoginResult> {
    const acct = this.db
      .prepare("SELECT id, email, password FROM accounts WHERE id = ?")
      .get(accountId) as
      | { id: number; email: string; password: string }
      | undefined;

    if (!acct) {
      throw new Error(`Account ${accountId} not found`);
    }

    try {
      const result = await this.login(acct.email, acct.password);
      upsertToken(this.db, accountId, result.bearer, result.expiresAt);
      this.scheduleAccount(accountId, result.expiresAt);
      return result;
    } catch (err) {
      recordLoginFailure(
        this.db,
        accountId,
        err instanceof Error ? err.message : String(err),
      );
      throw err;
    }
  }

  stop(): void {
    for (const [, timer] of this.timers) {
      if (timer.type === "timeout") {
        clearTimeout(timer.id as ReturnType<typeof setTimeout>);
      } else {
        clearInterval(timer.id as ReturnType<typeof setInterval>);
      }
    }
    this.timers.clear();
    this.cookies.stop();
  }

  private clearAccountTimer(accountId: number): void {
    const existing = this.timers.get(accountId);
    if (existing) {
      if (existing.type === "timeout") {
        clearTimeout(existing.id as ReturnType<typeof setTimeout>);
      } else {
        clearInterval(existing.id as ReturnType<typeof setInterval>);
      }
      this.timers.delete(accountId);
    }
  }
}

// ── createInternalLogin ─────────────────────────────────────────────────────

type Fetcher = typeof globalThis.fetch;

export function createInternalLogin(
  config: QwenProxyConfig,
  fetcher?: Fetcher,
): LoginFn {
  const _fetch = fetcher ?? globalThis.fetch;

  return async (email: string, password: string): Promise<LoginResult> => {
    // Hash password at send-time only
    const hashedPassword = createHash("sha256")
      .update(password, "utf8")
      .digest("hex");

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), config.loginTimeoutMs);

    try {
      const res = await _fetch(`${config.authUrl}/api/v1/auths/signin`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, password: hashedPassword }),
        signal: controller.signal,
      });

      if (!res.ok) {
        const body = await res.text().catch(() => "");
        throw new Error(
          `Login failed: ${res.status} ${body.slice(0, 200)}`,
        );
      }

      const data = (await res.json()) as { token: string };
      return {
        bearer: data.token,
        expiresAt: decodeExpiryMs(data.token),
      };
    } finally {
      clearTimeout(timeout);
    }
  };
}

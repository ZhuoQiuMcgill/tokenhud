/**
 * Keeps limits fresh while alerts are armed (T29). `tokenhud hook` reads only limits.json,
 * so an MCP server whose session has an armed alert refreshes that alert's account every
 * 5 minutes, through T8's on-demand refresh: the fetch lease, T16's groups and T18's fetch
 * cap all apply, and a TUI's or another server's recent fetch counts. With no armed alert
 * it asks for nothing: each tick only reads alerts.json.
 */

/** How often the server looks for armed alerts. */
export const ALERT_REFRESH_MS = 5 * 60_000;
/**
 * The age at which an armed alert's account is fetched: just under the tick, so data this
 * server's own last tick fetched is due by the next one, and a fetch by anyone else (the
 * TUI's round, an agent's `limits` call) within it saves the request.
 */
export const ALERT_MAX_AGE_S = 270;

export interface AlertWatchOptions {
  /** The accounts (root identities) with an alert armed for this session. */
  armed: () => string[];
  /** T8's on-demand refresh (`LimitsService.refresh`); it never throws. */
  refresh: (account: string, maxAgeS: number) => Promise<unknown>;
  log?: (message: string) => void;
  intervalMs?: number;
}

export class AlertWatch {
  readonly #o: AlertWatchOptions;
  #timer: ReturnType<typeof setInterval> | null = null;
  #running: Promise<string[]> | null = null;

  constructor(options: AlertWatchOptions) {
    this.#o = options;
  }

  /** Ticks every 5 minutes; the timer never keeps the process alive. */
  start(): void {
    if (this.#timer !== null) return;
    this.#timer = setInterval(() => void this.tick(), this.#o.intervalMs ?? ALERT_REFRESH_MS);
    this.#timer.unref();
  }

  stop(): void {
    if (this.#timer !== null) clearInterval(this.#timer);
    this.#timer = null;
  }

  /** Refreshes each account with an armed alert; resolves with them. Ticks never overlap. */
  tick(): Promise<string[]> {
    this.#running ??= this.#tick().finally(() => {
      this.#running = null;
    });
    return this.#running;
  }

  async #tick(): Promise<string[]> {
    let accounts: string[];
    try {
      accounts = this.#o.armed();
    } catch (error) {
      this.#o.log?.(`alerts: cannot read the armed alerts (${(error as Error).message})`);
      return [];
    }
    for (const account of accounts) await this.#o.refresh(account, ALERT_MAX_AGE_S);
    return accounts;
  }
}

/**
 * Signing in to a GitHub App with the device flow: the person enters a short
 * code on github.com, and the app never holds a client secret — neither to
 * sign in nor to renew, because a device-flow token renews without one.
 */

export interface DeviceCode {
  deviceCode: string;
  userCode: string;
  verificationUri: string;
  expiresAt: number;
  /** Seconds between polls; GitHub raises it when asked too often. */
  interval: number;
}

/** What GitHub grants. The expiries are null for an App that opted out of expiring tokens. */
export interface Grant {
  accessToken: string;
  accessExpiresAt: number | null;
  refreshToken: string | null;
  refreshExpiresAt: number | null;
}

/** `code` is GitHub's own error code — `access_denied`, `expired_token`, `bad_refresh_token` — or `http` when it did not answer. */
export class OAuthError extends Error {
  override name = "OAuthError";
  constructor(
    message: string,
    public readonly code: string
  ) {
    super(message);
  }
}

const sleep = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    signal.addEventListener("abort", () => (clearTimeout(timer), reject(signal.reason)), { once: true });
  });

export class DeviceFlow {
  constructor(
    private readonly clientId: string,
    private readonly webUrl = "https://github.com",
    /** The poll interval's unit, for tests that cannot wait seconds. */
    private readonly second = 1000
  ) {}

  private async post(route: string, body: Record<string, string>): Promise<Record<string, unknown>> {
    let res: Response;
    try {
      res = await fetch(`${this.webUrl}${route}`, {
        method: "POST",
        headers: { Accept: "application/json", "Content-Type": "application/json", "User-Agent": "tomrade" },
        body: JSON.stringify({ client_id: this.clientId, ...body }),
        signal: AbortSignal.timeout(20_000)
      });
    } catch (error) {
      // "Could not reach GitHub" alone cannot be told apart from a blocked proxy, a DNS failure or a slow link.
      const why = error instanceof Error ? (error.name === "TimeoutError" ? "timed out" : String((error.cause as { code?: string } | undefined)?.code ?? error.message)) : "unknown";
      throw new OAuthError(`Could not reach GitHub (${why})`, "http");
    }
    if (!res.ok) throw new OAuthError(`GitHub answered ${res.status}`, "http");
    return (await res.json()) as Record<string, unknown>;
  }

  async start(): Promise<DeviceCode> {
    const r = await this.post("/login/device/code", {});
    if (typeof r.device_code !== "string") throw new OAuthError(String(r.error_description ?? r.error ?? "GitHub did not start a sign-in"), String(r.error ?? "http"));
    return {
      deviceCode: r.device_code,
      userCode: String(r.user_code),
      verificationUri: String(r.verification_uri),
      expiresAt: Date.now() + Number(r.expires_in ?? 900) * 1000,
      interval: Number(r.interval ?? 5)
    };
  }

  /** Until the person approves, declines, or the code runs out. */
  async poll(code: DeviceCode, signal: AbortSignal): Promise<Grant> {
    let interval = code.interval;
    for (;;) {
      await sleep(interval * this.second, signal);
      if (Date.now() > code.expiresAt) throw new OAuthError("The code expired before it was entered", "expired_token");
      const r = await this.post("/login/oauth/access_token", { device_code: code.deviceCode, grant_type: "urn:ietf:params:oauth:grant-type:device_code" });
      if (typeof r.access_token === "string") return grantOf(r);
      if (r.error === "authorization_pending") continue;
      if (r.error === "slow_down") {
        interval = Number(r.interval ?? interval + 5);
        continue;
      }
      if (r.error === "access_denied") throw new OAuthError("The sign-in was declined on GitHub", "access_denied");
      if (r.error === "expired_token") throw new OAuthError("The code expired before it was entered", "expired_token");
      throw new OAuthError(String(r.error_description ?? r.error ?? "GitHub did not sign you in"), String(r.error ?? "http"));
    }
  }

  async refresh(refreshToken: string): Promise<Grant> {
    const r = await this.post("/login/oauth/access_token", { grant_type: "refresh_token", refresh_token: refreshToken });
    if (typeof r.access_token === "string") return grantOf(r);
    throw new OAuthError(String(r.error_description ?? r.error ?? "GitHub did not renew the sign-in"), String(r.error ?? "http"));
  }
}

function grantOf(r: Record<string, unknown>): Grant {
  const at = (seconds: unknown) => (typeof seconds === "number" && seconds > 0 ? Date.now() + seconds * 1000 : null);
  return {
    accessToken: String(r.access_token),
    accessExpiresAt: at(r.expires_in),
    refreshToken: typeof r.refresh_token === "string" ? r.refresh_token : null,
    refreshExpiresAt: at(r.refresh_token_expires_in)
  };
}

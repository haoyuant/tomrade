import { describe, expect, it } from "vitest";
import type { Git } from "@tomrade/storage";
import { classifyRemoteFailure, readRemoteIdentity, remoteFailureDetail, remoteFailureMessage } from "@tomrade/code-link";

describe("remote reachability", () => {
  it.each([
    "fatal: Authentication failed for 'https://github.com/acme/private.git/'",
    "fatal: could not read Username for 'https://github.com': terminal prompts disabled",
    "git@github.com: Permission denied (publickey).",
    "remote: Repository not found.",
    "The requested URL returned error: 403",
    "Invalid username or token."
  ])("classifies a credential failure: %s", (stderr) => {
    expect(classifyRemoteFailure(stderr)).toBe("credentials");
  });

  it.each(["Could not resolve host: github.com", "Connection timed out", "Failed to connect to github.com", "Connection refused", "Network is unreachable", "fatal: unable to access 'https://github.com/acme/app': TLS failed"])(
    "classifies a network failure: %s",
    (stderr) => {
      expect(classifyRemoteFailure(stderr)).toBe("network");
    }
  );

  it("keeps unknown errors separate and explains private repository visibility", () => {
    expect(classifyRemoteFailure("fatal: the remote end hung up unexpectedly")).toBe("unknown");
    expect(remoteFailureMessage("remote: Repository not found.")).toContain("private repository");
  });

  it("keeps only the scrubbed last line as detail", () => {
    expect(remoteFailureDetail("first\nfatal: unable to access 'https://secret@example.com/acme/app': nope\n")).toBe("fatal: unable to access 'https://example.com/acme/app': nope");
  });

  it("returns an HTTPS username without returning the credential password", async () => {
    let stdin = "";
    const git: Git = async (_args, opts) => {
      stdin = opts?.stdin ?? "";
      return { code: 0, stdout: "protocol=https\nhost=github.com\nusername=octocat\npassword=top-secret\n" };
    };
    const identity = await readRemoteIdentity(git, "/checkout", "https://github.com/acme/app.git");
    expect(identity).toEqual({ host: "github.com", login: "octocat" });
    expect(JSON.stringify(identity)).not.toContain("top-secret");
    expect(stdin).toBe("protocol=https\nhost=github.com\npath=acme/app\n\n");
  });
});

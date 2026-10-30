import { describe, expect, it } from "vitest";
import { classifyFailure, failureLine } from "../src/sync-failure.js";

describe("why an exchange with the remote failed", () => {
  it("tells a remote out of reach from one the transfer lost midway", () => {
    expect(classifyFailure("reach", "fatal: unable to access 'https://github.com/acme/docs.git/': Could not resolve host: github.com")).toBe("network");
    expect(classifyFailure("reach", "fatal: unable to access 'https://github.com/acme/docs.git/': Failed to connect to 127.0.0.1 port 7897 after 2 ms: Couldn't connect to server")).toBe("network");
    expect(classifyFailure("reach", "fatal: '/backups/missing.git' does not appear to be a git repository\nfatal: Could not read from remote repository.")).toBe("network");
    expect(classifyFailure("fetch", "error: RPC failed; curl 56 Recv failure: Connection was reset\nfatal: early EOF\nfatal: fetch-pack: invalid index-pack output")).toBe("interrupted");
    expect(classifyFailure("push", "error: RPC failed; HTTP 500 curl 22\nfatal: the remote end hung up unexpectedly")).toBe("interrupted");
    // Before any transfer began, a reset connection is the network, not a lost download.
    expect(classifyFailure("reach", "fatal: unable to access 'https://github.com/acme/docs.git/': Recv failure: Connection was reset")).toBe("network");
  });

  it("names a lock another git holds or left behind", () => {
    expect(classifyFailure("fetch", "fatal: Unable to create 'C:/Users/me/files/.git/files-sync/transport/e0fe/.git/shallow.lock': File exists.\n\nAnother git process seems to be running in this repository")).toBe("locked");
  });

  it("puts the account apart from the helper that should have handed it over", () => {
    expect(classifyFailure("reach", "remote: Invalid username or token.\nfatal: Authentication failed for 'https://github.com/acme/docs.git/'")).toBe("credentials");
    expect(classifyFailure("reach", "remote: Repository not found.\nfatal: repository 'https://github.com/acme/docs.git/' not found")).toBe("credentials");
    expect(classifyFailure("push", "remote: Permission to acme/docs.git denied to someone.\nfatal: unable to access 'https://github.com/acme/docs.git/': The requested URL returned error: 403")).toBe("credentials");
    expect(classifyFailure("reach", "git@github.com: Permission denied (publickey).\nfatal: Could not read from remote repository.")).toBe("credentials");
    expect(classifyFailure("reach", "/c/Users/me/AppData/Roaming/Tomrade/bin/tomrade-credential: line 2: /old/Tomrade.exe: No such file or directory\nfatal: could not read Username for 'https://github.com': terminal prompts disabled")).toBe("helper");
  });

  it("knows a push someone else beat, and leaves the rest to what git said", () => {
    expect(classifyFailure("push", "To https://github.com/acme/docs.git\n ! [rejected]        HEAD -> main (fetch first)\nerror: failed to push some refs to 'https://github.com/acme/docs.git'\nhint: Updates were rejected because the remote contains work that you do not")).toBe("moved");
    expect(classifyFailure("push", "remote: refused by policy\nTo /srv/docs.git\n ! [remote rejected] HEAD -> main (pre-receive hook declined)\nerror: failed to push some refs to '/srv/docs.git'")).toBe("other");
  });

  it("keeps the line that says why, never a credential and never a hint", () => {
    expect(failureLine("remote: refused by policy\nTo /srv/docs.git\n ! [remote rejected] HEAD -> main (pre-receive hook declined)\nerror: failed to push some refs to '/srv/docs.git'")).toBe("remote: refused by policy");
    expect(failureLine(" ! [rejected]        HEAD -> main (fetch first)\nerror: failed to push some refs\nhint: Updates were rejected")).toBe("! [rejected]        HEAD -> main (fetch first)");
    expect(failureLine("fatal: unable to access 'https://x-access-token:ghs_secret@github.com/acme/docs.git/': Could not resolve host: github.com")).toBe("fatal: unable to access 'https://github.com/acme/docs.git/': Could not resolve host: github.com");
    expect(failureLine("/bin/tomrade-credential: cannot execute: required file not found\nfatal: could not read Username")).toBe("/bin/tomrade-credential: cannot execute: required file not found");
    expect(failureLine("")).toBe("");
  });
});

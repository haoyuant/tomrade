import { afterEach, expect, it, vi } from "vitest";
import { GitHub, GitHubError } from "../src/api.js";

const answering = (...responses: Response[]) => {
  const fetchMock = vi.fn(async () => responses.shift()!);
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
};

const headersOf = (call: unknown[]) => (call[1] as { headers: Record<string, string> }).headers;

afterEach(() => vi.unstubAllGlobals());

it("hands back the answer with its ETag, then null when GitHub says it still holds", async () => {
  const fetchMock = answering(new Response('{"a":1}', { status: 200, headers: { ETag: '"one"' } }), new Response(null, { status: 304 }));
  const api = new GitHub(() => "token");
  const first = await api.conditional<{ a: number }>("/r", null);
  expect(first).toEqual({ etag: '"one"', body: { a: 1 } });
  expect(headersOf(fetchMock.mock.calls[0]!)["If-None-Match"]).toBeUndefined();
  expect(await api.conditional("/r", first!.etag)).toBeNull();
  expect(headersOf(fetchMock.mock.calls[1]!)["If-None-Match"]).toBe('"one"');
});

it("fails the way every other call does", async () => {
  answering(new Response("{}", { status: 404 }));
  await expect(new GitHub(() => "token").conditional("/gone", null)).rejects.toBeInstanceOf(GitHubError);
  await expect(new GitHub(() => "").conditional("/r", null)).rejects.toThrow("No GitHub token");
});

it("leaves ordinary calls as they were", async () => {
  const fetchMock = answering(new Response('{"login":"ann"}', { status: 200 }), new Response(null, { status: 204 }));
  const api = new GitHub(() => "token");
  expect(await api.request("GET", "/user")).toEqual({ login: "ann" });
  expect(await api.request("POST", "/x", { a: 1 })).toBeUndefined();
  expect(headersOf(fetchMock.mock.calls[1]!)["Content-Type"]).toBe("application/json");
});

import { expect, it } from "vitest";
import { modelErrorKind, modelRefusal, providerMessage } from "@tomradex/domain";

const gemini = (code: number, message: string, status: string) => `LLM request failed ${code}: ${JSON.stringify([{ error: { code, message, status } }])}`;

it("reads a wrong or missing key as auth, whoever says it", () => {
  for (const message of [
    gemini(400, "API key not valid. Please pass a valid API key.", "INVALID_ARGUMENT"),
    `400 {"error":{"code":400,"message":"API key expired. Please renew the API key.","status":"INVALID_ARGUMENT","details":[{"reason":"API_KEY_INVALID"}]}}`,
    gemini(403, "Method doesn't allow unregistered callers (callers without established identity). Please use API Key or other form of API consumer identity to call this API.", "PERMISSION_DENIED"),
    `LLM request failed 401: {"error":{"message":"Incorrect API key provided: sk-abc. You can find your API key at https://platform.openai.com/account/api-keys.","type":"invalid_request_error","code":"invalid_api_key"}}`,
    `401 {"type":"error","error":{"type":"authentication_error","message":"invalid x-api-key"}}`,
    `LLM request failed 403: {"type":"error","error":{"type":"permission_error","message":"Your API key does not have permission to use the specified resource."}}`,
    "401 Authentication Fails, Your api key is invalid"
  ]) {
    expect(modelErrorKind(message), message).toBe("auth");
    expect(modelRefusal(message), message).toBeNull();
  }
});

it("reads a model the key cannot use as a model problem, with why", () => {
  const cases: [string, "method" | "tier" | "unknown" | null][] = [
    [gemini(404, "models/gemini-2.5-flash-live-preview is not found for API version v1beta, or is not supported for generateContent. Call ListModels to see the list of available models and their supported methods.", "NOT_FOUND"), "method"],
    [`LLM request failed 404: {"error":{"message":"This is not a chat model and thus not supported in the v1/chat/completions endpoint. Did you mean to use v1/completions?","type":"invalid_request_error","code":null}}`, "method"],
    [`LLM request failed 404: {"error":{"message":"This model is only supported in v1/responses and not in v1/chat/completions.","type":"invalid_request_error"}}`, "method"],
    [gemini(429, "You exceeded your current quota, please check your plan and billing details.\n* Quota exceeded for metric: generativelanguage.googleapis.com/generate_content_free_tier_requests, limit: 0, model: gemini-2.5-pro", "RESOURCE_EXHAUSTED"), "tier"],
    [`LLM request failed 403: {"error":{"message":"Project \`proj_abc\` does not have access to model \`gpt-5\`","type":"invalid_request_error","code":"model_not_found"}}`, "tier"],
    [gemini(403, "This model is not available on the free tier.", "PERMISSION_DENIED"), "tier"],
    [`LLM request failed 404: {"error":{"message":"The model \`gpt-9\` does not exist or you do not have access to it.","type":"invalid_request_error","code":"model_not_found"}}`, "unknown"],
    [`404 {"type":"error","error":{"type":"not_found_error","message":"model: claude-nope"}}`, null]
  ];
  for (const [message, why] of cases) {
    expect(modelErrorKind(message), message).toBe("model");
    expect(modelRefusal(message), message).toBe(why);
  }
});

it("keeps quota, rate and the rest apart from the model", () => {
  expect(modelErrorKind(gemini(429, "Resource has been exhausted (e.g. check quota).", "RESOURCE_EXHAUSTED"))).toBe("quota");
  expect(modelErrorKind("LLM request failed 429: Too Many Requests")).toBe("rate");
  expect(modelErrorKind("LLM request failed 402: Insufficient Balance")).toBe("quota");
  expect(modelErrorKind("LLM request failed 503: The model is overloaded")).toBe("server");
});

it("reads a service that was not reached as network, in fetch's words and the SDKs'", () => {
  for (const message of ["fetch failed", "TypeError: fetch failed\n\ncaused by Error: connect ECONNREFUSED 127.0.0.1:65031", "Connection error.", "Request timed out."]) {
    expect(modelErrorKind(message), message).toBe("network");
  }
});

it("pulls the provider's own words out of a failed call", () => {
  expect(providerMessage(gemini(403, "This model is not available on the free tier.", "PERMISSION_DENIED"))).toBe("This model is not available on the free tier.");
  expect(providerMessage(`LLM request failed 404: {"error":{"message":"The model \\"x\\" is gone`)).toBe(`The model "x" is gone…`);
  expect(providerMessage("fetch failed")).toBeNull();
});

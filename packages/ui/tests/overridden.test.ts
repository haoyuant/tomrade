import { expect, it } from "vitest";
import type { Item } from "@tomradex/domain";
import { overriddenSubmission } from "../src/lib/overridden";

const submission = { id: "s", deliveryId: "d", report: "r", artifactIds: [], submittedBy: "human" as const, submittedAt: 1 };
const review = (decision: "accepted" | "changes-requested") => ({ id: "v", submissionId: "s", decision, comment: "", reviewedBy: "human" as const, reviewedAt: 2 });
const ticket = (over: Partial<Item>, reviews: ReturnType<typeof review>[] = []) =>
  ({ kind: "ticket", status: "doing", workType: "coding", evidence: { resources: [], submissions: [submission], reviews }, ...over }) as unknown as Item;
const done = { status: "done" } as const;

it("warns when finishing over a delivery that was sent back, or a coding one nobody reviewed", () => {
  expect(overriddenSubmission(ticket({}, [review("changes-requested")]), done)).toMatchObject({ sentBack: true });
  expect(overriddenSubmission(ticket({ status: "verifying" }), done)).toMatchObject({ sentBack: false });
});

it("stays quiet for everything else", () => {
  expect(overriddenSubmission(ticket({}, [review("accepted")]), done)).toBeNull();
  expect(overriddenSubmission(ticket({ workType: "general", status: "verifying" }), done)).toBeNull();
  expect(overriddenSubmission(ticket({}), { status: "verifying" })).toBeNull();
  expect(overriddenSubmission(ticket({ status: "done" }, [review("changes-requested")]), done)).toBeNull();
  expect(overriddenSubmission({ ...ticket({}), evidence: { resources: [], submissions: [], reviews: [] } } as Item, done)).toBeNull();
});

import { expect, it } from "vitest";
import { fresh } from "@tomradex/testkit";
import { exportState, importState } from "@tomradex/storage";

it("requires Files versions, distinguishes inputs, pins review outputs and preserves rejected history", async () => {
  const { ctx, items, project, board } = await fresh();
  const item = items.create({ projectId: project.id, boardId: board.id, title: "Write the guide", workType: "general", by: "human" });
  const resource = { name: "Guide", role: "output" as const, file: { fileId: "guide", versionId: "v1" } };
  await expect(items.addResource(project.id, item.id, resource, "ai:test")).rejects.toThrow("Files plugin is unavailable");
  expect(items.get(project.id, item.id)?.version).toBe(1);
  const disposeFiles = items.files({ async getVersion(scope, ref) { return scope === project.id && ref.fileId === "guide" && ["v1", "v2"].includes(ref.versionId) ? ref : null; }, async describe() { return []; } });
  await expect(items.addResource(project.id, item.id, { ...resource, file: { fileId: "guide", versionId: "unknown" } }, "human")).rejects.toThrow("does not exist");
  let updated = await items.addResource(project.id, item.id, { ...resource, role: "input" }, "human");
  const inputId = updated.evidence.resources[0].id;
  expect(items.deliveries.list(project.id, item.id)).toEqual([]);
  expect(() => items.submitDelivery(project.id, item.id, { report: "Ready", artifactIds: [inputId] }, "ai:test")).toThrow("output artifacts");
  updated = await items.addResource(project.id, item.id, resource, "ai:test");
  const firstArtifact = updated.evidence.resources.at(-1)!;
  const firstDelivery = items.deliveries.active(project.id, item.id)!;
  updated = items.submitDelivery(project.id, item.id, { report: "First draft", artifactIds: [firstArtifact.id] }, "ai:test");
  const firstSubmission = updated.evidence.submissions.at(-1)!;
  expect(updated.status).toBe("verifying");
  expect(() => items.update(project.id, item.id, { status: "done" }, "ai:test")).toThrow("human acceptance");
  expect(() => items.reviewDelivery(project.id, item.id, { submissionId: firstSubmission.id, decision: "accepted" }, updated.version - 1)).toThrow();
  updated = items.reviewDelivery(project.id, item.id, { submissionId: firstSubmission.id, decision: "changes-requested", comment: "Add an example" }, updated.version);
  expect(updated.status).toBe("doing");
  expect(items.deliveries.active(project.id, item.id)?.id).toBe(firstDelivery.id);
  updated = await items.addResource(project.id, item.id, { ...resource, file: { fileId: "guide", versionId: "v2" } }, "ai:test");
  const secondArtifact = updated.evidence.resources.at(-1)!;
  updated = items.submitDelivery(project.id, item.id, { report: "Added example", artifactIds: [secondArtifact.id] }, "ai:test");
  const secondSubmission = updated.evidence.submissions.at(-1)!;
  expect(() => items.reviewDelivery(project.id, item.id, { submissionId: firstSubmission.id, decision: "accepted" }, updated.version)).toThrow("no longer");
  updated = items.reviewDelivery(project.id, item.id, { submissionId: secondSubmission.id, decision: "accepted" }, updated.version);
  expect(updated.status).toBe("done");
  expect(items.deliveries.current(project.id, item.id)?.state).toBe("completed");
  expect(updated.evidence.resources.find(r => r.id === firstArtifact.id)?.file.versionId).toBe("v1");
  expect(updated.evidence.reviews.map(r => r.decision)).toEqual(["changes-requested", "accepted"]);
  const snapshot = exportState(ctx.db.for(project.id), project.id);
  ctx.oplog.undoLast(project.id, item.id);
  expect(items.get(project.id, item.id)?.evidence.reviews).toHaveLength(1);
  expect(items.deliveries.active(project.id, item.id)?.id).toBe(firstDelivery.id);
  importState(ctx.db.for(project.id), snapshot);
  expect(items.get(project.id, item.id)?.evidence).toEqual(updated.evidence);
  disposeFiles();
  await ctx.fiber.dispose();
});

it("accepts a human report without files, and direct human completion records its acceptance", async () => {
  const { ctx, items, project, board } = await fresh();
  const item = items.create({ projectId: project.id, boardId: board.id, title: "Collect printed materials", workType: "general", by: "human" });
  let updated = items.submitDelivery(project.id, item.id, { report: "Collected the materials at the venue" }, "human");
  updated = items.reviewDelivery(project.id, item.id, { submissionId: updated.evidence.submissions[0].id, decision: "accepted" }, updated.version);
  expect(updated.status).toBe("done");
  expect(updated.evidence.resources).toEqual([]);
  items.update(project.id, item.id, { status: "todo" }, "human");
  updated = items.update(project.id, item.id, { status: "done" }, "human");
  expect(updated.evidence.reviews).toHaveLength(2);
  expect(updated.evidence.submissions[1].deliveryId).not.toBe(updated.evidence.submissions[0].deliveryId);
  await ctx.fiber.dispose();
});

it("settles evidence a sync left inconsistent: accept the latest submission, or drop dangling references", async () => {
  const { ctx, items, project, board } = await fresh();
  const item = items.create({ projectId: project.id, boardId: board.id, title: "Build the thing", workType: "coding", by: "human" });
  let updated = items.submitDelivery(project.id, item.id, { report: "Collected" }, "human");
  const submission = updated.evidence.submissions[0];
  updated = items.reviewDelivery(project.id, item.id, { submissionId: submission.id, decision: "changes-requested" }, updated.version);
  updated = items.update(project.id, item.id, { status: "done" }, "human", { baseVersion: updated.version });

  const accepted = items.settleEvidence(project.id, item.id, "accept", updated.version);
  expect(accepted.status).toBe("done");
  expect(accepted.evidence.reviews.filter(r => r.submissionId === submission.id).map(r => r.decision)).toEqual(["accepted"]);

  const review = (id: string, submissionId: string) => ({ id, submissionId, decision: "accepted" as const, comment: "", reviewedBy: "human" as const, reviewedAt: 1 });
  const messy = { ...accepted.evidence, reviews: [...accepted.evidence.reviews, review("gone", "no-such-submission"), review("again", submission.id)], submissions: [{ ...submission, artifactIds: ["missing"] }] };
  ctx.db.for(project.id).prepare("UPDATE items SET evidence_json = ? WHERE id = ?").run(JSON.stringify(messy), item.id);
  const tidy = items.settleEvidence(project.id, item.id, "tidy", accepted.version);
  expect(tidy.evidence.reviews.map(r => r.id)).toEqual(["again"]);
  expect(tidy.evidence.submissions[0].artifactIds).toEqual([]);
  await ctx.fiber.dispose();
});

it("lets a verdict be changed: changes requested can still be accepted, and a done ticket taken back", async () => {
  const { ctx, items, project, board } = await fresh();
  const item = items.create({ projectId: project.id, boardId: board.id, title: "Build it", workType: "coding", by: "human" });
  let updated = items.submitDelivery(project.id, item.id, { report: "Ready" }, "human");
  const submission = updated.evidence.submissions[0];
  updated = items.reviewDelivery(project.id, item.id, { submissionId: submission.id, decision: "changes-requested" }, updated.version);
  expect(updated.status).toBe("doing");
  expect(() => items.reviewDelivery(project.id, item.id, { submissionId: submission.id, decision: "changes-requested" }, updated.version)).toThrow("already has that verdict");

  updated = items.reviewDelivery(project.id, item.id, { submissionId: submission.id, decision: "accepted", comment: "Fine after all" }, updated.version);
  expect(updated.status).toBe("done");
  expect(updated.evidence.reviews.map(r => r.decision)).toEqual(["accepted"]);

  updated = items.reviewDelivery(project.id, item.id, { submissionId: submission.id, decision: "changes-requested" }, updated.version);
  expect(updated.status).toBe("doing");
  expect(updated.evidence.reviews.map(r => r.decision)).toEqual(["changes-requested"]);
  await ctx.fiber.dispose();
});

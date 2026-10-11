import { z } from "zod";
import type { FileDescription } from "./attachments.js";
import type { Author } from "./types.js";

/** Metadata only. File bytes and immutable versions belong to the Files plugin. */
export interface FileReference { fileId: string; versionId: string }
export interface DeliveryResource {
  id: string;
  name: string;
  role: "input" | "output";
  deliveryId: string | null;
  file: FileReference;
  createdBy: Author;
  createdAt: number;
}
export interface DeliverySubmission {
  id: string;
  deliveryId: string;
  report: string;
  artifactIds: string[];
  submittedBy: Author;
  submittedAt: number;
}
export interface DeliveryReview {
  id: string;
  submissionId: string;
  decision: "accepted" | "changes-requested";
  comment: string;
  reviewedBy: "human";
  reviewedAt: number;
}
export interface TicketEvidence {
  resources: DeliveryResource[];
  submissions: DeliverySubmission[];
  reviews: DeliveryReview[];
}
export const emptyEvidence = (): TicketEvidence => ({ resources: [], submissions: [], reviews: [] });
export const fileReferenceSchema = z.object({ fileId: z.string().min(1), versionId: z.string().min(1) });
export const addResourceSchema = z.object({ name: z.string().trim().min(1), role: z.enum(["input", "output"]), file: fileReferenceSchema });
export const submitDeliverySchema = z.object({ report: z.string().trim().min(1), artifactIds: z.array(z.string()).default([]) });
export const reviewDeliverySchema = z.object({ submissionId: z.string().min(1), decision: z.enum(["accepted", "changes-requested"]), comment: z.string().default("") });

/** The future Files plugin supplies this resolver; no fallback file store exists. */
export interface FilesResolver {
  getVersion(projectId: string, reference: FileReference): Promise<FileReference | null>;
  /** The files behind these ids as they are now; an id with no file here is left out. */
  describe(projectId: string, fileIds: string[]): Promise<FileDescription[]>;
}

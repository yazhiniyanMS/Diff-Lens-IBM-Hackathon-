import { z } from "zod";

// Every substantive claim is tagged fact (directly observed from the repo)
// or inference (AI reasoning), and inferences must carry evidence pointing
// at what grounded them.
const Provenance = z.enum(["fact", "inference"]);

const Evidence = z.object({
  file: z.string(),
  lines: z.array(z.number()).optional().default([]),
  note: z.string().optional().default(""),
});

const ClaimedItem = z.object({
  summary: z.string(),
  provenance: Provenance,
  evidence: z.array(Evidence).default([]),
});

export const AnalysisResultSchema = z.object({
  intent: z.string(),
  intentProvenance: Provenance.default("inference"),
  behavioralChanges: z.array(ClaimedItem).default([]),
  affectedWorkflows: z.array(z.string()).default([]),
  impactedModules: z
    .array(
      z.object({
        file: z.string(),
        relationship: z.string(),
        reason: z.string(),
        provenance: Provenance,
        evidence: z.array(Evidence).default([]),
      })
    )
    .default([]),
  apiContractChanges: z.array(ClaimedItem).default([]),
  schemaInterfaceImpact: z.array(ClaimedItem).default([]),
  relatedTests: z.array(z.object({ file: z.string(), reason: z.string() })).default([]),
  missingTests: z
    .array(
      z.object({
        title: z.string(),
        rationale: z.string(),
        targetFile: z.string().optional().default(""),
        suggestedAssertions: z.array(z.string()).default([]),
        evidence: z.array(Evidence).default([]),
      })
    )
    .default([]),
  documentationGaps: z
    .array(
      z.object({
        file: z.string(),
        issue: z.string(),
        evidence: z.array(Evidence).default([]),
      })
    )
    .default([]),
  securityConcerns: z.array(ClaimedItem).default([]),
  backwardCompatibilityConcerns: z.array(ClaimedItem).default([]),
  untouchedFiles: z
    .array(
      z.object({
        file: z.string(),
        reason: z.string(),
        evidence: z.array(Evidence).default([]),
      })
    )
    .default([]),
  reviewQuestions: z.array(z.string()).default([]),
});

const PatchOperation = z.object({
  file: z.string(),
  kind: z.enum(["replace_all", "insert_after_match"]),
  find: z.string().optional(),
  replace: z.string().optional(),
  match: z.string().optional(),
  insertText: z.string().optional(),
});

export const PatchProposalSchema = z.object({
  findingId: z.string(),
  summary: z.string(),
  unifiedDiff: z.string(),
  targetFiles: z.array(z.string()),
  rationale: z.string(),
  operations: z.array(PatchOperation).default([]),
});

export const FindingSchema = z.object({
  id: z.string(),
  category: z.string(),
  title: z.string(),
  summary: z.string(),
  risk: z.enum(["informational", "low", "medium", "high"]),
  riskRuleId: z.string(),
  riskRationale: z.string(),
  provenance: Provenance,
  evidence: z.array(Evidence).default([]),
  status: z.enum(["needs_review", "accepted", "dismissed", "fixed"]).default("needs_review"),
  actionable: z.boolean().default(false),
});

export function safeParseAnalysis(data) {
  return AnalysisResultSchema.safeParse(data);
}

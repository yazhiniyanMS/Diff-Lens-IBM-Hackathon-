/**
 * Provider-agnostic interface. Concrete providers (mock, IBM Bob) implement
 * these capabilities. The rest of the application only talks to this
 * interface so swapping the underlying model never touches the pipeline,
 * the routes, or the UI.
 */
export class AIProvider {
  /** @returns {string} human-readable provider name for the UI/evidence trail */
  get name() {
    throw new Error("not implemented");
  }

  /**
   * Given a structured evidence package (diff, repo context, signals),
   * produce the full intent + impact + risk analysis. Must return data
   * conforming to AnalysisResultSchema (server/lib/schemas.js).
   */
  async analyzeChange(_evidencePackage) {
    throw new Error("not implemented");
  }

  /**
   * Propose a patch (unified diff) that addresses a single finding, given
   * the finding and the same evidence package used for analysis.
   * Must return data conforming to PatchProposalSchema.
   */
  async generatePatch(_finding, _evidencePackage) {
    throw new Error("not implemented");
  }

  /**
   * Given a before/after pair of a proposed simplification/refactor,
   * assess (in prose, not a boolean guarantee) whether behavior appears
   * preserved and what would need to be verified.
   */
  async assessEquivalence(_beforeCode, _afterCode, _context) {
    throw new Error("not implemented");
  }
}

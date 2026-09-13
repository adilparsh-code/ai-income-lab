"use client";

import { useState } from "react";
import { BusinessManagerRequest, BusinessManagerResult, BusinessManagerScope, ActionType, DecisionState } from "@/lib/agents/types";

const SCOPES: BusinessManagerScope[] = [
  "OPPORTUNITY_SELECTION", "VALIDATION_DECISION", "PRODUCT_DECISION",
  "EXPERIMENT_DECISION", "REVENUE_IMPROVEMENT", "FULL_BUSINESS_REVIEW",
];

const RISK_TOLERANCES: ("LOW" | "MEDIUM" | "HIGH")[] = ["LOW", "MEDIUM", "HIGH"];

const ACTION_LABELS: Record<ActionType, string> = {
  RESEARCH: "Research",
  VALIDATE: "Validate",
  BUILD_PRODUCT: "Build Product",
  RUN_EXPERIMENT: "Run Experiment",
  ANALYZE: "Analyze",
  IMPROVE_PRODUCT: "Improve Product",
  REVIEW_REVENUE: "Review Revenue",
  COLLECT_DATA: "Collect Data",
  HUMAN_REVIEW: "Human Review",
  NO_ACTION: "No Action",
};

const DECISION_LABELS: Record<DecisionState, string> = {
  PROCEED: "Proceed",
  VALIDATE_FIRST: "Validate First",
  IMPROVE: "Improve",
  COLLECT_MORE_DATA: "Collect More Data",
  HUMAN_REVIEW: "Human Review",
  BLOCKED: "Blocked",
  NO_ACTION: "No Action",
};

export default function BusinessManagerPage() {
  const [opportunityId, setOpportunityId] = useState("");
  const [productId, setProductId] = useState("");
  const [experimentId, setExperimentId] = useState("");
  const [objective, setObjective] = useState("");
  const [decisionScope, setDecisionScope] = useState<BusinessManagerScope>("FULL_BUSINESS_REVIEW");
  const [riskTolerance, setRiskTolerance] = useState<"LOW" | "MEDIUM" | "HIGH">("MEDIUM");
  const [preferredActionType, setPreferredActionType] = useState<ActionType | "">("");
  const [isExecuting, setIsExecuting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<BusinessManagerResult | null>(null);

  const executeBusinessManager = async () => {
    setIsExecuting(true);
    setError(null);
    setResult(null);

    try {
      const request: BusinessManagerRequest = {
        objective,
        decisionScope,
        riskTolerance,
        opportunityId: opportunityId || undefined,
        productId: productId || undefined,
        experimentId: experimentId || undefined,
        preferredActionType: preferredActionType || undefined,
      };

      const response = await fetch("/api/agents/execute", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ agentType: "business-manager", action: "execute", input: request }),
      });

      const data = await response.json();
      if (data.success) {
        setResult(data.output);
      } else {
        setError(data.error || "Business Manager execution failed");
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "An unknown error occurred");
    } finally {
      setIsExecuting(false);
    }
  };

  const isFormValid = objective.trim().length > 0;

  const getEvidenceBadgeColor = (type: string) => {
    switch (type) {
      case "VERIFIED_DATA": return "bg-green-100 text-green-800";
      case "AI_INFERENCE": return "bg-blue-100 text-blue-800";
      case "USER_ENTERED": return "bg-purple-100 text-purple-800";
      default: return "bg-gray-100 text-gray-800";
    }
  };

  const getHalalBadgeColor = (status: string) => {
    switch (status) {
      case "HALAL": return "bg-green-100 text-green-800";
      case "REVIEW_REQUIRED": return "bg-amber-100 text-amber-800";
      case "NOT_ALLOWED": return "bg-red-100 text-red-800";
      default: return "bg-gray-100 text-gray-800";
    }
  };

  const getDecisionColor = (decision: DecisionState) => {
    switch (decision) {
      case "PROCEED": return "bg-green-100 text-green-800 border-green-200";
      case "VALIDATE_FIRST": return "bg-blue-100 text-blue-800 border-blue-200";
      case "IMPROVE": return "bg-purple-100 text-purple-800 border-purple-200";
      case "COLLECT_MORE_DATA": return "bg-amber-100 text-amber-800 border-amber-200";
      case "HUMAN_REVIEW": return "bg-orange-100 text-orange-800 border-orange-200";
      case "BLOCKED": return "bg-red-100 text-red-800 border-red-200";
      default: return "bg-gray-100 text-gray-800";
    }
  };

  const getActionColor = (action: ActionType) => {
    const colors: Record<ActionType, string> = {
      RESEARCH: "bg-indigo-100 text-indigo-800",
      VALIDATE: "bg-sky-100 text-sky-800",
      BUILD_PRODUCT: "bg-emerald-100 text-emerald-800",
      RUN_EXPERIMENT: "bg-cyan-100 text-cyan-800",
      ANALYZE: "bg-violet-100 text-violet-800",
      IMPROVE_PRODUCT: "bg-teal-100 text-teal-800",
      REVIEW_REVENUE: "bg-rose-100 text-rose-800",
      COLLECT_DATA: "bg-amber-100 text-amber-800",
      HUMAN_REVIEW: "bg-orange-100 text-orange-800",
      NO_ACTION: "bg-gray-100 text-gray-800",
    };
    return colors[action] || "bg-gray-100 text-gray-800";
  };

  return (
    <div className="container mx-auto px-4 py-8 max-w-5xl">
      <div className="mb-8">
        <h1 className="text-3xl font-bold mb-2">Business Manager</h1>
        <p className="text-gray-600">Orchestrates research, validation, product, and analytics insights to produce a transparent, evidence-aware Next Best Action.</p>
        <div className="mt-2 inline-block px-3 py-1 bg-amber-100 text-amber-800 rounded-full text-sm font-medium">
          MOCKED CAPABILITY - Recommendations are AI inferences based on available database state. All actions require human approval.
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-8">
        <div className="bg-white rounded-lg shadow-md p-6">
          <h2 className="text-xl font-semibold mb-4">Business Manager Request</h2>

          <div className="space-y-4">
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Decision Objective *</label>
              <textarea
                value={objective}
                onChange={(e) => setObjective(e.target.value)}
                placeholder="What business decision are you looking to make? e.g., 'Decide what to work on next'"
                className="w-full border border-gray-300 rounded-lg p-3 text-sm focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500"
                rows={3}
              />
            </div>

            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Decision Scope *</label>
              <select
                value={decisionScope}
                onChange={(e) => setDecisionScope(e.target.value as BusinessManagerScope)}
                className="w-full border border-gray-300 rounded-lg p-3 text-sm focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500"
              >
                {SCOPES.map(s => (
                  <option key={s} value={s}>{s.replace(/_/g, " ")}</option>
                ))}
              </select>
            </div>


            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Risk Tolerance</label>
              <select
                value={riskTolerance}
                onChange={(e) => setRiskTolerance(e.target.value as "LOW" | "MEDIUM" | "HIGH")}
                className="w-full border border-gray-300 rounded-lg p-3 text-sm focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500"
              >
                {RISK_TOLERANCES.map(r => (
                  <option key={r} value={r}>{r} Risk Tolerance</option>
                ))}
              </select>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Opportunity ID (optional)</label>
                <input
                  type="text"
                  value={opportunityId}
                  onChange={(e) => setOpportunityId(e.target.value)}
                  placeholder="e.g., clx1234567890"
                  className="w-full border border-gray-300 rounded-lg p-3 text-sm focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500"
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Product ID (optional)</label>
                <input
                  type="text"
                  value={productId}
                  onChange={(e) => setProductId(e.target.value)}
                  placeholder="e.g., clx0987654321"
                  className="w-full border border-gray-300 rounded-lg p-3 text-sm focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500"
                />
              </div>
            </div>


            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Experiment ID (optional)</label>
              <input
                type="text"
                value={experimentId}
                onChange={(e) => setExperimentId(e.target.value)}
                placeholder="e.g., clx1122334455"
                className="w-full border border-gray-300 rounded-lg p-3 text-sm focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500"
              />
            </div>

            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Preferred Action Type (optional)</label>
              <select
                value={preferredActionType || ""}
                onChange={(e) => setPreferredActionType(e.target.value as ActionType || "")}
                className="w-full border border-gray-300 rounded-lg p-3 text-sm focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500"
              >
                <option value="">No preference</option>
                {Object.entries(ACTION_LABELS).map(([key, label]) => (
                  <option key={key} value={key}>{label}</option>
                ))}
              </select>
            </div>

            <button
              onClick={executeBusinessManager}
              disabled={!isFormValid || isExecuting}
              className="w-full bg-indigo-600 hover:bg-indigo-700 disabled:bg-gray-400 text-white font-semibold py-3 px-4 rounded-lg transition-colors flex items-center justify-center gap-2"
            >
              {isExecuting ? (
                <>
                  <svg className="animate-spin h-5 w-5" viewBox="0 0 24 24" fill="none">
                    <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                    <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                  </svg>
                  Analyzing...
                </>
              ) : (
                <>
                  <svg className="h-5 w-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" />
                  </svg>
                  Get Next Best Action
                </>
              )}
            </button>
          </div>
        </div>


        <div className="bg-white rounded-lg shadow-md p-6">
          <h2 className="text-xl font-semibold mb-4">Result</h2>

          {error && (
            <div className="bg-red-50 border border-red-200 rounded-lg p-4 text-sm text-red-700 mb-4">
              <strong className="block mb-1">Error:</strong>
              {error}
            </div>
          )}

          {!result && !error && (
            <div className="text-gray-500 text-sm py-8 text-center">
              Execute the Business Manager to receive a Next Best Action recommendation based on available evidence.
            </div>
          )}

          {result && (
            <div className="space-y-5">
              {/* STATUS BADGES */}
              <div className="flex gap-2 items-center flex-wrap">
                <span className={`px-3 py-1 rounded-full text-sm font-semibold ${getHalalBadgeColor(result.halalStatus)}`}>
                  {result.halalStatus}
                </span>
                <span className={`px-3 py-1 rounded-full text-sm font-semibold border ${getDecisionColor(result.decision)}`}>
                  {DECISION_LABELS[result.decision]}
                </span>
                {result.humanReviewRequired && (
                  <span className="px-3 py-1 rounded-full text-sm font-semibold bg-orange-100 text-orange-800">
                    Human Review Required
                  </span>
                )}
                <span className="px-3 py-1 rounded-full text-sm font-semibold bg-slate-100 text-slate-700">
                  {result.capabilityStatus}
                </span>
              </div>
              <div className="bg-gray-50 border border-gray-200 rounded-lg p-4">
                <span className="text-sm font-medium text-gray-600">Decision Rationale:</span>
                <p className="text-sm text-gray-700 mt-1">{result.decisionRationale}</p>
              </div>
              {result.missingInformation && result.missingInformation.length > 0 && (
                <div className="bg-amber-50 border border-amber-200 rounded-lg p-4">
                  <span className="text-sm font-medium text-amber-800">Missing Information (collect for better decisions):</span>
                  <ul className="text-sm text-amber-800 mt-1 list-disc list-inside">
                    {result.missingInformation.map((m, i) => <li key={i}>{m}</li>)}
                  </ul>
                </div>
              )}

              {/* PRIMARY NEXT BEST ACTION */}
              <div className="bg-indigo-50 border border-indigo-200 rounded-lg p-5">
                <h3 className="text-lg font-bold text-indigo-900 mb-3">PRIMARY NEXT BEST ACTION</h3>
                <div className="space-y-2">
                  <div>
                    <span className="text-sm font-medium text-gray-600">Action:</span>
                    <div className="mt-1 flex items-center gap-2">
                      <span className={`px-3 py-1 rounded-full text-sm font-semibold ${getActionColor(result.nextBestAction.action)}`}>
                        {ACTION_LABELS[result.nextBestAction.action]}
                      </span>
                      <span className={`px-2 py-0.5 rounded text-[10px] font-medium ${getEvidenceBadgeColor(result.nextBestAction.evidenceType)}`}>
                        {result.nextBestAction.evidenceType}
                      </span>
                    </div>
                  </div>
                  <div>
                    <span className="text-sm font-medium text-gray-600">Reason:</span>
                    <p className="text-sm text-gray-700 mt-0.5">{result.nextBestAction.reason}</p>
                  </div>
                  <div className="flex gap-4">
                    <div>
                      <span className="text-sm font-medium text-gray-600">Priority:</span>
                      <p className="text-sm text-gray-700 mt-0.5">{result.nextBestAction.priority}</p>
                    </div>
                    <div>
                      <span className="text-sm font-medium text-gray-600">Confidence:</span>
                      <p className="text-sm text-gray-700 mt-0.5">{(result.confidence * 100).toFixed(0)}%</p>
                    </div>
                  </div>


                  <div>
                    <span className="text-sm font-medium text-gray-600">Evidence:</span>
                    <p className="text-sm text-gray-700 mt-0.5">{result.nextBestAction.evidence}</p>
                  </div>
                  <div>
                    <span className="text-sm font-medium text-gray-600">Expected Purpose:</span>
                    <p className="text-sm text-gray-700 mt-0.5">{result.nextBestAction.expectedPurpose}</p>
                  </div>
                  {result.nextBestAction.blockers.length > 0 && (
                    <div>
                      <span className="text-sm font-medium text-gray-600">Blockers:</span>
                      <ul className="text-sm text-gray-700 mt-0.5 list-disc list-inside">
                        {result.nextBestAction.blockers.map((b, i) => <li key={i}>{b}</li>)}
                      </ul>
                    </div>
                  )}
                  <div className="flex gap-4 pt-1">
                    <div>
                      <span className="text-sm font-medium text-gray-600">Human Approval Required:</span>
                      <p className={`text-sm mt-0.5 font-semibold ${result.nextBestAction.humanApprovalRequired ? 'text-amber-700' : 'text-green-600'}`}>
                        {result.nextBestAction.humanApprovalRequired ? "Yes" : "No"}
                      </p>
                    </div>
                    <div>
                      <span className="text-sm font-medium text-gray-600">Execution Eligible:</span>
                      <p className={`text-sm mt-0.5 font-semibold ${result.nextBestAction.executionEligible ? 'text-green-600' : 'text-red-600'}`}>
                        {result.nextBestAction.executionEligible ? "Yes" : "No"}
                      </p>
                    </div>
                  </div>
                </div>
              </div>

              {/* AGENT COORDINATION SUMMARIES */}
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <div className="bg-white border border-gray-200 rounded-lg p-4">
                  <div className="flex justify-between items-start">
                    <h4 className="font-semibold text-sm text-gray-800">Research Summary</h4>
                    <span className={`px-2 py-0.5 rounded text-[10px] font-medium ${getEvidenceBadgeColor(result.researchEvidenceType)}`}>{result.researchEvidenceType}</span>
                  </div>
                  <p className="text-sm text-gray-600 mt-1">{result.researchSummary}</p>
                </div>
                <div className="bg-white border border-gray-200 rounded-lg p-4">
                  <div className="flex justify-between items-start">
                    <h4 className="font-semibold text-sm text-gray-800">Validation Summary</h4>
                    <span className={`px-2 py-0.5 rounded text-[10px] font-medium ${getEvidenceBadgeColor(result.validationEvidenceType)}`}>{result.validationEvidenceType}</span>
                  </div>
                  <p className="text-sm text-gray-600 mt-1">{result.validationSummary}</p>
                </div>
                <div className="bg-white border border-gray-200 rounded-lg p-4">
                  <div className="flex justify-between items-start">
                    <h4 className="font-semibold text-sm text-gray-800">Product Summary</h4>
                    <span className={`px-2 py-0.5 rounded text-[10px] font-medium ${getEvidenceBadgeColor(result.productEvidenceType)}`}>{result.productEvidenceType}</span>
                  </div>
                  <p className="text-sm text-gray-600 mt-1">{result.productSummary}</p>
                </div>
                <div className="bg-white border border-gray-200 rounded-lg p-4">
                  <div className="flex justify-between items-start">
                    <h4 className="font-semibold text-sm text-gray-800">Analytics Summary</h4>
                    <span className={`px-2 py-0.5 rounded text-[10px] font-medium ${getEvidenceBadgeColor(result.analyticsEvidenceType)}`}>{result.analyticsEvidenceType}</span>
                  </div>
                  <p className="text-sm text-gray-600 mt-1">{result.analyticsSummary}</p>
                </div>
              </div>

              {/* ALTERNATIVE ACTIONS CONSIDERED */}
              {result.alternativeActionsConsidered.length > 0 && (
                <div className="bg-white border border-gray-200 rounded-lg p-4">
                  <h4 className="font-semibold text-sm text-gray-800 mb-2">Alternative Actions Considered (Why Not)</h4>
                  <div className="space-y-2">
                    {result.alternativeActionsConsidered.map((alt, i) => (
                      <div key={i} className="flex items-start gap-2">
                        <span className="px-2 py-0.5 rounded bg-slate-100 text-slate-700 text-xs font-medium whitespace-nowrap">{alt.action}</span>
                        <span className="text-sm text-gray-600">Not selected: {alt.reasonRejected}</span>
                        <span className={`px-1.5 py-0.5 rounded text-[10px] font-medium ${getEvidenceBadgeColor(alt.evidenceType)} whitespace-nowrap`}>{alt.evidenceType}</span>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {/* RISKS AND ASSUMPTIONS */}
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <div className="bg-red-50 border border-red-200 rounded-lg p-4">
                  <h4 className="font-semibold text-sm text-red-800 mb-2">Risks</h4>
                  <ul className="text-sm text-red-700 list-disc list-inside space-y-1">
                    {result.risks.map((r, i) => <li key={i}>{r}</li>)}
                  </ul>
                </div>
                <div className="bg-blue-50 border border-blue-200 rounded-lg p-4">
                  <h4 className="font-semibold text-sm text-blue-800 mb-2">Assumptions</h4>
                  <ul className="text-sm text-blue-700 list-disc list-inside space-y-1">
                    {result.assumptions.map((a, i) => <li key={i}>{a}</li>)}
                  </ul>
                </div>
              </div>

              {/* EVIDENCE PROVENANCE */}
              <div className="bg-white border border-gray-200 rounded-lg p-4">
                <h4 className="font-semibold text-sm text-gray-800 mb-2">Evidence Provenance</h4>
                <div className="space-y-2">
                  {result.evidence.map(e => (
                    <div key={e.id} className="flex items-start gap-2">
                      <span className={`px-2 py-0.5 rounded text-[10px] font-medium whitespace-nowrap ${getEvidenceBadgeColor(e.type)}`}>{e.type}</span>
                      <div>
                        <span className="text-sm text-gray-700">{e.content}</span>
                        {e.source && <span className="text-xs text-gray-500 ml-1">({e.source})</span>}
                      </div>
                    </div>
                  ))}
                </div>
              </div>

              <div className="bg-slate-50 border border-slate-200 rounded-lg p-3 text-sm text-slate-600">
                <span className="font-medium">AgentLog ID:</span> {result.agentLogId || 'not recorded'}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}


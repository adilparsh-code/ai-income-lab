"use client";

import { useState } from "react";
import { ProductRequest, ProductResult, ProductType, MonetizationModel } from "@/lib/agents/types";

const PRODUCT_TYPES: ProductType[] = [
  "DIGITAL_PRODUCT", "SAAS", "WEB_APP", "MOBILE_APP",
  "TEMPLATE", "PRINTABLE", "COURSE", "TOOL", "SERVICE_PRODUCT",
];

const MONETIZATION_MODELS: MonetizationModel[] = [
  "ONE_TIME_PURCHASE", "SUBSCRIPTION", "FREEMIUM",
  "SERVICE", "LICENSE", "AFFILIATE", "AD_SUPPORTED",
];

export default function ProductAgentPage() {
  const [opportunityId, setOpportunityId] = useState("");
  const [productObjective, setProductObjective] = useState("");
  const [productType, setProductType] = useState<ProductType>("DIGITAL_PRODUCT");
  const [targetAudience, setTargetAudience] = useState("");
  const [customerProblem, setCustomerProblem] = useState("");
  const [preferredPlatform, setPreferredPlatform] = useState("");
  const [constraints, setConstraints] = useState("");
  const [budgetConstraints, setBudgetConstraints] = useState("");
  const [monetizationPreference, setMonetizationPreference] = useState<MonetizationModel>("ONE_TIME_PURCHASE");
  const [isExecuting, setIsExecuting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<ProductResult | null>(null);

  const executeProduct = async () => {
    setIsExecuting(true);
    setError(null);
    setResult(null);

    try {
      const constraintsArray = constraints.split("\n").filter(c => c.trim());
      const request: ProductRequest = {
        opportunityId: opportunityId || undefined,
        productObjective,
        productType,
        targetAudience: targetAudience || undefined,
        customerProblem: customerProblem || undefined,
        preferredPlatform: preferredPlatform || undefined,
        constraints: constraintsArray.length > 0 ? constraintsArray : undefined,
        budgetConstraints: budgetConstraints || undefined,
        monetizationPreference,
      };

      const response = await fetch("/api/agents/execute", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          agentType: "product",
          action: "execute_product",
          input: request,
        }),
      });

      const data = await response.json();
      if (data.success) {
        setResult(data.output);
      } else {
        setError(data.error || "Product Agent execution failed");
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "An unknown error occurred");
    } finally {
      setIsExecuting(false);
    }
  };

  const isFormValid = productObjective.trim().length > 0;

  const getEvidenceBadgeColor = (type: string) => {
    switch (type) {
      case "AI_INFERENCE": return "bg-blue-100 text-blue-800";
      case "VERIFIED_DATA": return "bg-green-100 text-green-800";
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

  return (
    <div className="container mx-auto px-4 py-8 max-w-5xl">
      <div className="mb-8">
        <h1 className="text-3xl font-bold mb-2">Product Agent</h1>
        <p className="text-gray-600">
          Converts an eligible opportunity and its research/validation context into a structured product concept and build specification.
        </p>
        <div className="mt-2 inline-block px-3 py-1 bg-yellow-100 text-yellow-800 rounded-full text-sm font-medium">
          Results are AI_INFERENCE - product concepts are hypotheses, no real product has been built
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-8">
        <div className="bg-white rounded-lg shadow-md p-6">
          <h2 className="text-xl font-semibold mb-4">Product Request</h2>
          <div className="space-y-4">
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Opportunity ID (optional)</label>
              <input type="text" value={opportunityId} onChange={(e) => setOpportunityId(e.target.value)} placeholder="Enter existing opportunity ID" className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-indigo-500" />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Product Objective *</label>
              <textarea value={productObjective} onChange={(e) => setProductObjective(e.target.value)} placeholder="Describe the product objective" rows={3} className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-indigo-500" />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Product Type</label>
              <select value={productType} onChange={(e) => setProductType(e.target.value as ProductType)} className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-indigo-500">
                {PRODUCT_TYPES.map(t => <option key={t} value={t}>{t.replace(/_/g, " ")}</option>)}
              </select>
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Target Audience</label>
              <input type="text" value={targetAudience} onChange={(e) => setTargetAudience(e.target.value)} placeholder="Who is this product for?" className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-indigo-500" />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Customer Problem</label>
              <textarea value={customerProblem} onChange={(e) => setCustomerProblem(e.target.value)} placeholder="What problem does this solve?" rows={2} className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-indigo-500" />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Preferred Platform</label>
              <input type="text" value={preferredPlatform} onChange={(e) => setPreferredPlatform(e.target.value)} placeholder="Web, iOS, Android, etc." className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-indigo-500" />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Constraints (one per line)</label>
              <textarea value={constraints} onChange={(e) => setConstraints(e.target.value)} placeholder="Enter constraints, one per line" rows={2} className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-indigo-500" />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Budget Constraints</label>
              <input type="text" value={budgetConstraints} onChange={(e) => setBudgetConstraints(e.target.value)} placeholder="Budget limit or range" className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-indigo-500" />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Monetization Preference</label>
              <select value={monetizationPreference} onChange={(e) => setMonetizationPreference(e.target.value as MonetizationModel)} className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-indigo-500">
                {MONETIZATION_MODELS.map(m => <option key={m} value={m}>{m.replace(/_/g, " ")}</option>)}
              </select>
            </div>
            <button onClick={executeProduct} disabled={!isFormValid || isExecuting} className="w-full px-4 py-2 bg-indigo-600 text-white rounded-md hover:bg-indigo-700 disabled:bg-gray-400 disabled:cursor-not-allowed font-medium">
              {isExecuting ? "Executing..." : "Execute Product Agent"}
            </button>
          </div>
        </div>

        <div className="bg-white rounded-lg shadow-md p-6">
          <h2 className="text-xl font-semibold mb-4">Product Result</h2>
          {error && (
            <div className="p-4 mb-4 bg-red-50 border border-red-200 rounded-lg">
              <p className="text-red-700 font-medium">Error</p>
              <p className="text-red-600 text-sm">{error}</p>
            </div>
          )}
          {result && (
            <div className="space-y-4">
              <div className="flex gap-2 items-center flex-wrap">
                <span className={`px-2 py-0.5 rounded text-xs font-medium ${getHalalBadgeColor(result.halalStatus)}`}>{result.halalStatus}</span>
                <span className="px-2 py-0.5 rounded text-xs font-medium bg-slate-100 text-slate-700">{result.capabilityStatus}</span>
                {result.humanReviewRequired && <span className="px-2 py-0.5 rounded text-xs font-medium bg-amber-100 text-amber-800">HUMAN REVIEW REQUIRED</span>}
              </div>
              <div>
                <p className="text-sm font-medium text-gray-700">Recommendation</p>
                <p className="text-sm text-gray-600">{result.recommendation}</p>
              </div>
            </div>
          )}
          {!result && !isExecuting && !error && (
            <div className="text-center py-12 text-gray-500">
              <p>Fill out the form and execute to see results</p>
            </div>
          )}
          {isExecuting && (
            <div className="text-center py-12 text-gray-500">
              <p>Executing Product Agent...</p>
            </div>
          )}
        </div>
      </div>

      {result && (
        <div className="mt-8 space-y-6">
          <div className="bg-white rounded-lg shadow-md p-6">
            <h3 className="text-lg font-semibold mb-3">Product Concept</h3>
            <div className="space-y-2">
              <div><span className="font-medium text-sm">Name:</span> <span className="text-sm">{result.productConcept.productNameHypothesis}</span></div>
              <div><span className="font-medium text-sm">Description:</span> <span className="text-sm">{result.productConcept.oneLineDescription}</span></div>
              <div><span className="font-medium text-sm">Customer:</span> <span className="text-sm">{result.productConcept.customer}</span></div>
              <div><span className="font-medium text-sm">Problem:</span> <span className="text-sm">{result.productConcept.problem}</span></div>
              <div><span className="font-medium text-sm">Solution:</span> <span className="text-sm">{result.productConcept.proposedSolution}</span></div>
              <div><span className="font-medium text-sm">Value Proposition:</span> <span className="text-sm">{result.productConcept.coreValueProposition}</span></div>
              <div><span className="font-medium text-sm">Differentiation:</span> <span className="text-sm">{result.productConcept.differentiationHypothesis}</span></div>
              <div><span className="font-medium text-sm">Format:</span> <span className="text-sm">{result.productConcept.productFormat}</span></div>
              <div><span className="font-medium text-sm">Primary Use Case:</span> <span className="text-sm">{result.productConcept.primaryUseCase}</span></div>
              <div><span className={`px-2 py-0.5 rounded text-xs font-medium ${getEvidenceBadgeColor(result.productConcept.evidenceType)}`}>{result.productConcept.evidenceType}</span></div>
            </div>
          </div>

          <div className="bg-white rounded-lg shadow-md p-6">
            <h3 className="text-lg font-semibold mb-3">MVP Features</h3>
            <div className="space-y-2">
              {result.mvpFeatures.map(f => (
                <div key={f.id} className="flex items-start gap-2">
                  <span className={`px-2 py-0.5 rounded text-xs font-medium ${f.priority === "ESSENTIAL" ? "bg-red-100 text-red-800" : f.priority === "IMPORTANT" ? "bg-amber-100 text-amber-800" : "bg-gray-100 text-gray-600"}`}>{f.priority}</span>
                  <div><span className="font-medium text-sm">{f.name}:</span> <span className="text-sm text-gray-600">{f.description}</span></div>
                </div>
              ))}
            </div>
          </div>

          <div className="bg-white rounded-lg shadow-md p-6">
            <h3 className="text-lg font-semibold mb-3">Build Plan</h3>
            <div className="space-y-4">
              {result.buildPhases.map(bp => (
                <div key={bp.phase} className="border border-gray-200 rounded-md p-3">
                  <div className="flex justify-between items-center mb-2">
                    <h4 className="font-medium text-sm">Phase {bp.phase}: {bp.name}</h4>
                  </div>
                  <ul className="list-disc list-inside text-sm text-gray-600 space-y-1">
                    {bp.tasks.map((t, i) => <li key={i}>{t}</li>)}
                  </ul>
                  <p className="text-xs text-gray-500 mt-1"><span className="font-medium">Output:</span> {bp.expectedOutput}</p>
                  <p className="text-xs text-gray-500"><span className="font-medium">Risk:</span> {bp.risk}</p>
                </div>
              ))}
            </div>
          </div>

          <div className="bg-white rounded-lg shadow-md p-6">
            <h3 className="text-lg font-semibold mb-3">Monetization Hypothesis</h3>
            <div className="space-y-2 text-sm">
              <div><span className="font-medium">Model:</span> {result.monetizationModel}</div>
              <div><span className="font-medium">Rationale:</span> {result.monetizationRationale}</div>
              <div><span className="font-medium">Pricing:</span> {result.pricingHypothesis}</div>
            </div>
          </div>

          <div className="bg-white rounded-lg shadow-md p-6">
            <h3 className="text-lg font-semibold mb-3">Risks and Assumptions</h3>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div>
                <h4 className="font-medium text-sm mb-2">Risks</h4>
                <ul className="list-disc list-inside text-sm text-gray-600 space-y-1">
                  {result.risks.map((r, i) => <li key={i}>{r}</li>)}
                </ul>
              </div>
              <div>
                <h4 className="font-medium text-sm mb-2">Assumptions</h4>
                <ul className="list-disc list-inside text-sm text-gray-600 space-y-1">
                  {result.assumptions.map((a, i) => <li key={i}>{a}</li>)}
                </ul>
              </div>
            </div>
          </div>

          <div className="bg-white rounded-lg shadow-md p-6">
            <h3 className="text-lg font-semibold mb-3">Evidence Provenance</h3>
            <div className="space-y-2">
              {result.evidence.map(e => (
                <div key={e.id} className="flex items-start gap-2">
                  <span className={`px-2 py-0.5 rounded text-xs font-medium ${getEvidenceBadgeColor(e.type)}`}>{e.type}</span>
                  <span className="text-sm text-gray-700">{e.content}</span>
                </div>
              ))}
            </div>
          </div>

          <div className="bg-slate-50 border border-slate-200 rounded-lg p-4 text-sm text-slate-600">
            <div><span className="font-medium">Research Context:</span> {result.researchContext}</div>
            <div><span className="font-medium">Validation Context:</span> {result.validationContext}</div>
            <div><span className="font-medium">Confidence:</span> {(result.confidence * 100).toFixed(0)}%</div>
            {result.agentLogId && <div><span className="font-medium">AgentLog ID:</span> {result.agentLogId}</div>}
          </div>
        </div>
      )}
    </div>
  );
}

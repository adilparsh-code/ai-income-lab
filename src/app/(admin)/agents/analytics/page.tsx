"use client";

import { useState } from "react";
import { AnalyticsRequest, AnalyticsResult, AnalyticsScope } from "@/lib/agents/types";

const SCOPES: AnalyticsScope[] = [
  "OVERVIEW", "EXPERIMENTS", "PRODUCTS", "REVENUE", "OPPORTUNITIES", "FULL_BUSINESS",
];

export default function AnalyticsAgentPage() {
  const [analysisScope, setAnalysisScope] = useState<AnalyticsScope>("OVERVIEW");
  const [opportunityId, setOpportunityId] = useState("");
  const [productId, setProductId] = useState("");
  const [experimentId, setExperimentId] = useState("");
  const [startDate, setStartDate] = useState("");
  const [endDate, setEndDate] = useState("");
  const [analysisObjective, setAnalysisObjective] = useState("");
  const [isExecuting, setIsExecuting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<AnalyticsResult | null>(null);

  const executeAnalytics = async () => {
    setIsExecuting(true);
    setError(null);
    setResult(null);

    try {
      const request: AnalyticsRequest = {
        analysisScope,
        analysisObjective,
        opportunityId: opportunityId || undefined,
        productId: productId || undefined,
        experimentId: experimentId || undefined,
        startDate: startDate || undefined,
        endDate: endDate || undefined,
      };

      const response = await fetch("/api/agents/execute", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ agentType: "analytics", action: "execute_analytics", input: request }),
      });

      const data = await response.json();
      if (data.success) {
        setResult(data.output);
      } else {
        setError(data.error || "Analytics Agent execution failed");
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "An unknown error occurred");
    } finally {
      setIsExecuting(false);
    }
  };

  const isFormValid = analysisObjective.trim().length > 0;

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

  return (
    <div className="container mx-auto px-4 py-8 max-w-5xl">
      <div className="mb-8">
        <h1 className="text-3xl font-bold mb-2">Analytics Agent</h1>
        <p className="text-gray-600">Analyzes real database data for experiments, products, revenue, and opportunities. Identifies trends, anomalies, and generates next-best-action recommendations.</p>
        <div className="mt-2 inline-block px-3 py-1 bg-amber-100 text-amber-800 rounded-full text-sm font-medium">
          LIVE DATA - KPIs calculated from real database records. Recommendations are AI inferences.
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-8">
        <div className="bg-white rounded-lg shadow-md p-6">
          <h2 className="text-xl font-semibold mb-4">Analysis Request</h2>
          <div className="space-y-4">
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Analysis Scope</label>
              <select value={analysisScope} onChange={(e) => setAnalysisScope(e.target.value as AnalyticsScope)} className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-indigo-500">
                {SCOPES.map(s => <option key={s} value={s}>{s.replace(/_/g, " ")}</option>)}
              </select>
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Analysis Objective *</label>
              <textarea value={analysisObjective} onChange={(e) => setAnalysisObjective(e.target.value)} placeholder="What do you want to analyze?" rows={2} className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-indigo-500" />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Start Date</label>
                <input type="date" value={startDate} onChange={(e) => setStartDate(e.target.value)} className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-indigo-500" />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">End Date</label>
                <input type="date" value={endDate} onChange={(e) => setEndDate(e.target.value)} className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-indigo-500" />
              </div>
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Opportunity ID (optional)</label>
              <input type="text" value={opportunityId} onChange={(e) => setOpportunityId(e.target.value)} placeholder="Scope to specific opportunity" className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-indigo-500" />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Product ID (optional)</label>
              <input type="text" value={productId} onChange={(e) => setProductId(e.target.value)} placeholder="Scope to specific product" className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-indigo-500" />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Experiment ID (optional)</label>
              <input type="text" value={experimentId} onChange={(e) => setExperimentId(e.target.value)} placeholder="Scope to specific experiment" className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-indigo-500" />
            </div>
            <button onClick={executeAnalytics} disabled={!isFormValid || isExecuting} className="w-full px-4 py-2 bg-indigo-600 text-white rounded-md hover:bg-indigo-700 disabled:bg-gray-400 disabled:cursor-not-allowed font-medium">
              {isExecuting ? "Analyzing..." : "Execute Analytics"}
            </button>
          </div>
        </div>

        <div className="bg-white rounded-lg shadow-md p-6">
          <h2 className="text-xl font-semibold mb-4">Analysis Result</h2>
          {error && (
            <div className="p-4 mb-4 bg-red-50 border border-red-200 rounded-lg">
              <p className="text-red-700 font-medium">Error</p>
              <p className="text-red-600 text-sm">{error}</p>
            </div>
          )}
          {result && (
            <div className="space-y-3">
              <div className="flex gap-2 items-center flex-wrap">
                <span className={`px-2 py-0.5 rounded text-xs font-medium ${getHalalBadgeColor(result.halalStatus)}`}>{result.halalStatus}</span>
                <span className="px-2 py-0.5 rounded text-xs font-medium bg-slate-100 text-slate-700">{result.capabilityStatus}</span>
                {result.humanReviewRequired && <span className="px-2 py-0.5 rounded text-xs font-medium bg-amber-100 text-amber-800">HUMAN REVIEW REQUIRED</span>}
              </div>
              <div className="text-sm text-gray-600"><span className="font-medium">Scope:</span> {result.analysisScope.replace(/_/g, " ")}</div>
              <div className="text-sm text-gray-600"><span className="font-medium">Period:</span> {result.period.label}</div>
              <div className="text-sm text-gray-600"><span className="font-medium">Data:</span> {result.dataSummary.opportunities} opps, {result.dataSummary.experiments} exps, {result.dataSummary.products} prods, {result.dataSummary.revenues} revs</div>
              {result.dataSummary.insufficientDataWarnings.length > 0 && (
                <div className="p-2 bg-amber-50 border border-amber-200 rounded text-xs text-amber-800">
                  {result.dataSummary.insufficientDataWarnings.map((w, i) => <div key={i}>{w}</div>)}
                </div>
              )}
              <div className="text-sm text-gray-600"><span className="font-medium">Recommendation:</span> {result.recommendation}</div>
            </div>
          )}
          {!result && !isExecuting && !error && (
            <div className="text-center py-12 text-gray-500"><p>Configure analysis and execute to see results</p></div>
          )}
          {isExecuting && (
            <div className="text-center py-12 text-gray-500"><p>Analyzing database data...</p></div>
          )}
        </div>
      </div>

      {result && (
        <div className="mt-8 space-y-6">
          <div className="bg-white rounded-lg shadow-md p-6">
            <h3 className="text-lg font-semibold mb-3">KPI Metrics (VERIFIED_DATA = real DB values)</h3>
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
              {result.kpiMetrics.map(kpi => (
                <div key={kpi.id} className="border border-gray-200 rounded-md p-3">
                  <div className="flex justify-between items-start mb-1">
                    <span className="font-medium text-sm text-gray-700">{kpi.label}</span>
                    <span className={`px-1.5 py-0.5 rounded text-[10px] font-medium ${getEvidenceBadgeColor(kpi.evidenceType)}`}>{kpi.evidenceType}</span>
                  </div>
                  <div className="text-lg font-bold text-gray-900">{kpi.value}</div>
                </div>
              ))}
            </div>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
            <div className="bg-white rounded-lg shadow-md p-6">
              <h3 className="text-lg font-semibold mb-3">Experiment Insights</h3>
              <div className="space-y-2">
                {result.experimentInsights.map(ins => (
                  <div key={ins.id} className="border border-gray-200 rounded-md p-2">
                    <div className="flex justify-between items-start"><span className="font-medium text-sm">{ins.label}</span><span className={`px-1.5 py-0.5 rounded text-[10px] font-medium ${getEvidenceBadgeColor(ins.evidenceType)}`}>{ins.evidenceType}</span></div>
                    <p className="text-xs text-gray-600 mt-1">{ins.description}</p>
                  </div>
                ))}
              </div>
            </div>
            <div className="bg-white rounded-lg shadow-md p-6">
              <h3 className="text-lg font-semibold mb-3">Product Insights</h3>
              <div className="space-y-2">
                {result.productInsights.map(ins => (
                  <div key={ins.id} className="border border-gray-200 rounded-md p-2">
                    <div className="flex justify-between items-start"><span className="font-medium text-sm">{ins.label}</span><span className={`px-1.5 py-0.5 rounded text-[10px] font-medium ${getEvidenceBadgeColor(ins.evidenceType)}`}>{ins.evidenceType}</span></div>
                    <p className="text-xs text-gray-600 mt-1">{ins.description}</p>
                  </div>
                ))}
              </div>
            </div>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
            <div className="bg-white rounded-lg shadow-md p-6">
              <h3 className="text-lg font-semibold mb-3">Revenue Insights</h3>
              <div className="space-y-2">
                {result.revenueInsights.map(ins => (
                  <div key={ins.id} className="border border-gray-200 rounded-md p-2">
                    <div className="flex justify-between items-start"><span className="font-medium text-sm">{ins.label}</span><span className={`px-1.5 py-0.5 rounded text-[10px] font-medium ${getEvidenceBadgeColor(ins.evidenceType)}`}>{ins.evidenceType}</span></div>
                    <p className="text-xs text-gray-600 mt-1">{ins.description}</p>
                  </div>
                ))}
              </div>
            </div>
            <div className="bg-white rounded-lg shadow-md p-6">
              <h3 className="text-lg font-semibold mb-3">Opportunity Insights</h3>
              <div className="space-y-2">
                {result.opportunityInsights.map(ins => (
                  <div key={ins.id} className="border border-gray-200 rounded-md p-2">
                    <div className="flex justify-between items-start"><span className="font-medium text-sm">{ins.label}</span><span className={`px-1.5 py-0.5 rounded text-[10px] font-medium ${getEvidenceBadgeColor(ins.evidenceType)}`}>{ins.evidenceType}</span></div>
                    <p className="text-xs text-gray-600 mt-1">{ins.description}</p>
                  </div>
                ))}
              </div>
            </div>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
            <div className="bg-white rounded-lg shadow-md p-6">
              <h3 className="text-lg font-semibold mb-3">Trends</h3>
              <div className="space-y-2">
                {result.trends.map(t => (
                  <div key={t.id} className="border border-gray-200 rounded-md p-2">
                    <div className="flex justify-between items-start">
                      <span className="font-medium text-sm">{t.label}</span>
                      <span className={`px-1.5 py-0.5 rounded text-[10px] font-medium ${t.direction === "INCREASING" ? "bg-green-100 text-green-800" : t.direction === "DECREASING" ? "bg-red-100 text-red-800" : "bg-gray-100 text-gray-600"}`}>{t.direction}</span>
                    </div>
                    <p className="text-xs text-gray-600 mt-1">{t.description}</p>
                  </div>
                ))}
              </div>
            </div>
            <div className="bg-white rounded-lg shadow-md p-6">
              <h3 className="text-lg font-semibold mb-3">Anomalies</h3>
              <div className="space-y-2">
                {result.anomalies.map(a => (
                  <div key={a.id} className="border border-gray-200 rounded-md p-2">
                    <div className="flex justify-between items-start">
                      <span className={`px-1.5 py-0.5 rounded text-[10px] font-medium ${a.severity === "HIGH" ? "bg-red-100 text-red-800" : a.severity === "MEDIUM" ? "bg-amber-100 text-amber-800" : "bg-gray-100 text-gray-600"}`}>{a.severity}</span>
                      <span className={`px-1.5 py-0.5 rounded text-[10px] font-medium ${getEvidenceBadgeColor(a.evidenceType)}`}>{a.evidenceType}</span>
                    </div>
                    <p className="text-xs text-gray-600 mt-1">{a.description}</p>
                  </div>
                ))}
              </div>
            </div>
          </div>

          <div className="bg-white rounded-lg shadow-md p-6">
            <h3 className="text-lg font-semibold mb-3">Recommendations and Next Best Actions</h3>
            <div className="space-y-3">
              <div>
                <h4 className="font-medium text-sm mb-2">Recommendations (AI_INFERENCE)</h4>
                <ul className="list-disc list-inside text-sm text-gray-600 space-y-1">
                  {result.recommendations.map((r, i) => <li key={i}>{r}</li>)}
                </ul>
              </div>
              <div>
                <h4 className="font-medium text-sm mb-2">Next Best Actions</h4>
                <div className="space-y-2">
                  {result.nextBestActions.map(a => (
                    <div key={a.id} className="border border-gray-200 rounded-md p-2">
                      <div className="flex justify-between items-start">
                        <span className="font-medium text-sm">{a.action}</span>
                        <span className="px-1.5 py-0.5 bg-blue-100 text-blue-800 rounded text-[10px]">Priority {a.priority}</span>
                      </div>
                      <p className="text-xs text-gray-600 mt-1">{a.reason}</p>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          </div>

          <div className="bg-white rounded-lg shadow-md p-6">
            <h3 className="text-lg font-semibold mb-3">Evidence Provenance</h3>
            <div className="space-y-2">
              {result.evidence.map(e => (
                <div key={e.id} className="flex items-start gap-2">
                  <span className={`px-2 py-0.5 rounded text-xs font-medium ${getEvidenceBadgeColor(e.type)}`}>{e.type}</span>
                  <div><span className="text-sm text-gray-700">{e.content}</span>{e.source && <span className="text-xs text-gray-500 ml-1">({e.source})</span>}</div>
                </div>
              ))}
            </div>
          </div>

          <div className="bg-slate-50 border border-slate-200 rounded-lg p-4 text-sm text-slate-600 space-y-1">
            <div><span className="font-medium">Confidence:</span> {(result.confidence * 100).toFixed(0)}%</div>
            {result.agentLogId && <div><span className="font-medium">AgentLog ID:</span> {result.agentLogId}</div>}
          </div>
        </div>
      )}
    </div>
  );
}

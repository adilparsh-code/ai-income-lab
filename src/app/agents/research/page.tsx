'use client';

import { useEffect, useState } from 'react';
import { agentRegistry } from '@/lib/agents/agent-registry';
import { ResearchResult } from '@/lib/agents/types';
import { ResearchEvidencePanel } from '@/components/agents/research-evidence';
import type { ResearchEngineStatus } from '@/actions/research';

export default function ResearchAgentPage() {
  const [researchObjective, setResearchObjective] = useState('');
  const [opportunityId, setOpportunityId] = useState('');
  const [targetAudience, setTargetAudience] = useState('');
  const [marketCategory, setMarketCategory] = useState('');
  const [isExecuting, setIsExecuting] = useState(false);
  const [result, setResult] = useState<ResearchResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [meta, setMeta] = useState<{
    provider?: string;
    model?: string;
    capabilityStatus?: string;
    fallbackUsed?: boolean;
  } | null>(null);
  const [engineStatus, setEngineStatus] = useState<ResearchEngineStatus | null>(null);

  useEffect(() => {
    let active = true;
    fetch('/api/research/status')
      .then((r) => (r.ok ? r.json() : null))
      .then((data: ResearchEngineStatus | null) => {
        if (active && data) setEngineStatus(data);
      })
      .catch(() => undefined);
    return () => {
      active = false;
    };
  }, []);

  const researchAgent = agentRegistry.getAgentById('research-agent');

  const executeResearch = async () => {
    setIsExecuting(true);
    setError(null);
    setResult(null);

    try {
      const response = await fetch('/api/agents/execute', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          agentType: 'research',
          action: 'execute_research',
          input: {
            researchObjective,
            opportunityId: opportunityId || undefined,
            targetAudience: targetAudience || undefined,
            marketCategory: marketCategory || undefined,
          },
        }),
      });

      const data = await response.json();
      
      if (!response.ok) {
        throw new Error(data.error || 'Failed to execute research');
      }

      setResult(data.output);
      setMeta({
        provider: data.aiUsage?.provider,
        model: data.aiUsage?.model,
        capabilityStatus: data.output?.capabilityStatus,
        fallbackUsed: data.fallbackUsed,
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'An unknown error occurred');
    } finally {
      setIsExecuting(false);
    }
  };

  const getEvidenceBadgeColor = (type: string) => {
    switch (type) {
      case 'AI_INFERENCE':
        return 'bg-blue-100 text-blue-800';
      case 'VERIFIED_DATA':
        return 'bg-green-100 text-green-800';
      case 'USER_ENTERED':
        return 'bg-purple-100 text-purple-800';
      default:
        return 'bg-gray-100 text-gray-800';
    }
  };

  const getSignalTypeLabel = (type: string) => {
    switch (type) {
      case 'demand':
        return 'Demand';
      case 'risk':
        return 'Risk';
      case 'monetization':
        return 'Monetization';
      case 'competitor':
        return 'Competitor';
      default:
        return type;
    }
  };

  const getSignalBadgeColor = (type: string) => {
    switch (type) {
      case 'demand':
        return 'bg-emerald-100 text-emerald-800';
      case 'risk':
        return 'bg-red-100 text-red-800';
      case 'monetization':
        return 'bg-amber-100 text-amber-800';
      case 'competitor':
        return 'bg-slate-100 text-slate-800';
      default:
        return 'bg-gray-100 text-gray-800';
    }
  };

  return (
    <div className="container mx-auto py-8 px-4">
      <div className="max-w-4xl mx-auto">
        {/* Header */}
        <div className="mb-8">
          <h1 className="text-3xl font-bold mb-2">{researchAgent?.name}</h1>
          <p className="text-gray-600 mb-4">{researchAgent?.description}</p>
          <div className="flex gap-3 items-center flex-wrap">
            <span className="px-3 py-1 rounded-full bg-yellow-100 text-yellow-800 text-sm font-medium">
              {researchAgent?.status}
            </span>
            <span className="px-3 py-1 rounded-full bg-green-100 text-green-800 text-sm font-medium">
              Safe Execution: {researchAgent?.safeExecutionState ? 'Enabled' : 'Disabled'}
            </span>
          </div>
        </div>

        {/* Capabilities Card */}
        <div className="bg-white rounded-xl border p-6 mb-8 shadow-sm">
          <h2 className="text-xl font-semibold mb-3">Current Capabilities</h2>
          <p className="text-gray-600">{researchAgent?.currentCapability}</p>
          {engineStatus && (
            <div
              className={`mt-4 rounded-lg border p-3 text-sm ${
                engineStatus.searchConfigured
                  ? 'border-emerald-200 bg-emerald-50 text-emerald-900'
                  : 'border-sky-200 bg-sky-50 text-sky-900'
              }`}
            >
              <strong>Real research engine:</strong>{' '}
              {engineStatus.searchConfigured
                ? `live discovery via ${engineStatus.searchProviderId}.`
                : 'search discovery is not configured — nothing is fabricated without it.'}{' '}
              <span className="text-xs opacity-80">{engineStatus.searchHint}</span>
            </div>
          )}
        </div>

        {/* Research Execution Form */}
        <div className="bg-white rounded-xl border p-6 mb-8 shadow-sm">
          <h2 className="text-xl font-semibold mb-4">Execute Research</h2>
          
          <div className="space-y-4">
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">
                Research Objective *
              </label>
              <textarea
                value={researchObjective}
                onChange={(e) => setResearchObjective(e.target.value)}
                placeholder="What would you like to research?"
                className="w-full px-3 py-2 border rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
                rows={3}
              />
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  Opportunity ID (optional)
                </label>
                <input
                  type="text"
                  value={opportunityId}
                  onChange={(e) => setOpportunityId(e.target.value)}
                  placeholder="Link to existing opportunity"
                  className="w-full px-3 py-2 border rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
                />
              </div>

              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  Target Audience (optional)
                </label>
                <input
                  type="text"
                  value={targetAudience}
                  onChange={(e) => setTargetAudience(e.target.value)}
                  placeholder="Who is this for?"
                  className="w-full px-3 py-2 border rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
                />
              </div>
            </div>

            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">
                Market/Category (optional)
              </label>
              <input
                type="text"
                value={marketCategory}
                onChange={(e) => setMarketCategory(e.target.value)}
                placeholder="What market category does this belong to?"
                className="w-full px-3 py-2 border rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
              />
            </div>

            <button
              onClick={executeResearch}
              disabled={isExecuting || !researchObjective.trim()}
              className="w-full py-3 px-4 bg-blue-600 text-white rounded-lg font-medium hover:bg-blue-700 disabled:bg-gray-400 disabled:cursor-not-allowed transition-colors"
            >
              {isExecuting ? 'Researching (AI + external evidence)…' : 'Execute Research'}
            </button>
          </div>
        </div>

        {/* Error Display */}
        {error && (
          <div className="bg-red-50 border border-red-200 rounded-xl p-6 mb-8">
            <h3 className="text-lg font-semibold text-red-800 mb-2">Error</h3>
            <p className="text-red-700">{error}</p>
          </div>
        )}

        {/* Results Display */}
        {result && (
          <div className="space-y-6">
            <h2 className="text-2xl font-bold">Research Results</h2>
{meta && (
              <div className="bg-white rounded-xl border p-6 shadow-sm">
                <h3 className="text-lg font-semibold mb-3">Execution Details</h3>
                <div className="flex flex-wrap gap-2 items-center text-sm">
                  <span className="px-2 py-1 rounded-full text-xs font-medium bg-slate-100 text-slate-700">
                    Mode: {meta.capabilityStatus ?? '—'}
                  </span>
                  <span className="px-2 py-1 rounded-full text-xs font-medium bg-slate-100 text-slate-700">
                    Provider: {meta.provider ?? 'none'}
                  </span>
                  <span className="px-2 py-1 rounded-full text-xs font-medium bg-slate-100 text-slate-700">
                    Model: {meta.model ?? '—'}
                  </span>
                  {meta.fallbackUsed && (
                    <span className="px-2 py-1 rounded-full text-xs font-medium bg-amber-100 text-amber-800">
                      Fallback / failure path used
                    </span>
                  )}
                </div>
                <p className="text-xs text-slate-500 mt-3">
                  All AI-generated results are AI_INFERENCE (not verified external data).
                </p>
              </div>
            )}
            
            {/* Overview */}
            <div className="bg-white rounded-xl border p-6 shadow-sm">
              <h3 className="text-lg font-semibold mb-3">Objective</h3>
              <p className="text-gray-800 mb-4">{result.researchObjective}</p>
              <div className="flex gap-4 items-center">
                <span className="text-sm text-gray-600">Confidence: {(result.overallConfidence * 100).toFixed(0)}%</span>
                <span className="px-2 py-1 rounded-full text-xs font-medium bg-yellow-100 text-yellow-800">
                  {result.capabilityStatus}
                </span>
              </div>
            </div>

            {/* Halal Considerations */}
            {result.halalConsiderations.length > 0 && (
              <div className="bg-amber-50 border border-amber-200 rounded-xl p-6">
                <h3 className="text-lg font-semibold text-amber-800 mb-3">Halal Considerations</h3>
                <ul className="list-disc list-inside space-y-1">
                  {result.halalConsiderations.map((item, idx) => (
                    <li key={idx} className="text-amber-700">{item}</li>
                  ))}
                </ul>
              </div>
            )}

            {/* Findings */}
            <div className="bg-white rounded-xl border p-6 shadow-sm">
              <h3 className="text-lg font-semibold mb-4">Findings</h3>
              <div className="space-y-3">
                {result.findings.map((finding) => (
                  <div key={finding.id} className="p-4 border rounded-lg">
                    <div className="flex justify-between items-start mb-2">
                      <p className="text-gray-800">{finding.content}</p>
                      <span className={`px-2 py-1 rounded-full text-xs font-medium ml-3 ${getEvidenceBadgeColor(finding.evidenceType)}`}>
                        {finding.evidenceType}
                      </span>
                    </div>
                  </div>
                ))}
              </div>
            </div>

            {/* Signals */}
            <div className="bg-white rounded-xl border p-6 shadow-sm">
              <h3 className="text-lg font-semibold mb-4">Signals</h3>
              <div className="grid gap-4 md:grid-cols-2">
                {result.signals.map((signal) => (
                  <div key={signal.id} className="p-4 border rounded-lg">
                    <div className="flex justify-between items-start mb-2">
                      <span className={`px-2 py-1 rounded-full text-xs font-medium ${getSignalBadgeColor(signal.type)}`}>
                        {getSignalTypeLabel(signal.type)}
                      </span>
                      <div className="flex gap-2 items-center">
                        {signal.isMocked && (
                          <span className="px-2 py-1 rounded-full text-xs font-medium bg-gray-100 text-gray-600">
                            MOCKED
                          </span>
                        )}
                        <span className={`px-2 py-1 rounded-full text-xs font-medium ${getEvidenceBadgeColor(signal.evidenceType)}`}>
                          {signal.evidenceType}
                        </span>
                      </div>
                    </div>
                    <p className="text-gray-800 text-sm mb-2">{signal.content}</p>
                    <p className="text-xs text-gray-500">Confidence: {(signal.confidence * 100).toFixed(0)}%</p>
                  </div>
                ))}
              </div>
            </div>

            {/* Real research: sources, evidence, provenance, gaps */}
            {(result.sources.length > 0 || result.sourceResearch) && (
              <div className="bg-white rounded-xl border p-6 shadow-sm">
                <h3 className="text-lg font-semibold mb-4">Sources & Evidence</h3>
                <ResearchEvidencePanel result={result} />
              </div>
            )}

            {/* Assumptions & Risks */}
            <div className="grid gap-6 md:grid-cols-2">
              <div className="bg-white rounded-xl border p-6 shadow-sm">
                <h3 className="text-lg font-semibold mb-3">Assumptions</h3>
                <ul className="list-disc list-inside space-y-1">
                  {result.assumptions.map((item, idx) => (
                    <li key={idx} className="text-gray-600 text-sm">{item}</li>
                  ))}
                </ul>
              </div>

              <div className="bg-white rounded-xl border p-6 shadow-sm">
                <h3 className="text-lg font-semibold mb-3">Risks</h3>
                <ul className="list-disc list-inside space-y-1">
                  {result.risks.map((item, idx) => (
                    <li key={idx} className="text-gray-600 text-sm">{item}</li>
                  ))}
                </ul>
              </div>
            </div>

            {result.agentLogId && (
              <div className="bg-slate-50 border border-slate-200 rounded-xl p-4">
                <p className="text-sm text-slate-600">AgentLog ID: {result.agentLogId}</p>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
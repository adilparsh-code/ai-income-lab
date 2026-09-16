'use client';

import { useState } from 'react';
import { ValidationRequest, ValidationResult, ValidationMethod } from '@/lib/agents/types';

export default function ValidationAgentPage() {
  const [opportunityId, setOpportunityId] = useState('');
  const [validationObjective, setValidationObjective] = useState('');
  const [targetAudience, setTargetAudience] = useState('');
  const [keyAssumptions, setKeyAssumptions] = useState('');
  const [preferredValidationMethod, setPreferredValidationMethod] = useState<ValidationMethod>('SURVEY');
  const [isExecuting, setIsExecuting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<ValidationResult | null>(null);

  const validationMethods: ValidationMethod[] = [
    'LANDING_PAGE', 'SURVEY', 'INTERVIEW', 'PREORDER', 
    'CONTENT_TEST', 'PRICE_TEST', 'EXPERIMENT', 'MANUAL_RESEARCH'
  ];

  const executeValidation = async () => {
    setIsExecuting(true);
    setError(null);
    setResult(null);
    
    try {
      const assumptionsArray = keyAssumptions.split('\n').filter(a => a.trim());
      const request: ValidationRequest = {
        opportunityId: opportunityId || undefined,
        validationObjective,
        targetAudience: targetAudience || undefined,
        keyAssumptions: assumptionsArray.length > 0 ? assumptionsArray : undefined,
        preferredValidationMethod
      };

      const response = await fetch('/api/agents/execute', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          agentType: 'validation',
          action: 'execute_validation',
          input: request
        })
      });

      const data = await response.json();
      if (data.success) {
        setResult(data.output);
      } else {
        setError(data.error || 'Validation execution failed');
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'An unknown error occurred');
    } finally {
      setIsExecuting(false);
    }
  };

  const isFormValid = validationObjective.trim().length > 0;

  return (
    <div className="container mx-auto px-4 py-8 max-w-5xl">
      <div className="mb-8">
        <h1 className="text-3xl font-bold mb-2">Validation Agent</h1>
        <p className="text-gray-600">
          Evaluate whether an opportunity is worth testing. Identifies risky assumptions, prioritizes tests, 
          and defines validation requirements.
        </p>
        <div className="mt-2 inline-block px-3 py-1 bg-yellow-100 text-yellow-800 rounded-full text-sm font-medium">
          Results are AI_INFERENCE - all validation findings are hypotheses until verified by real-world evidence or a human
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-8">
        {/* Input Form */}
        <div className="bg-white rounded-lg shadow-md p-6">
          <h2 className="text-xl font-semibold mb-4">Validation Request</h2>
          
          <div className="space-y-4">
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">
                Opportunity ID (optional)
              </label>
              <input
                type="text"
                value={opportunityId}
                onChange={(e) => setOpportunityId(e.target.value)}
                placeholder="Enter existing opportunity ID"
                className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
              />
            </div>

            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">
                Validation Objective <span className="text-red-500">*</span>
              </label>
              <textarea
                value={validationObjective}
                onChange={(e) => setValidationObjective(e.target.value)}
                placeholder="What do you want to validate? (e.g., 'Validate that small business owners will pay for accounting automation')"
                rows={3}
                className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
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
                placeholder="Who is your target audience?"
                className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
              />
            </div>

            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">
                Key Assumptions (optional, one per line)
              </label>
              <textarea
                value={keyAssumptions}
                onChange={(e) => setKeyAssumptions(e.target.value)}
                placeholder="Enter key assumptions to validate, one per line"
                rows={4}
                className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
              />
            </div>

            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">
                Preferred Validation Method
              </label>
              <select
                value={preferredValidationMethod}
                onChange={(e) => setPreferredValidationMethod(e.target.value as ValidationMethod)}
                className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
              >
                {validationMethods.map(method => (
                  <option key={method} value={method}>{method.replace(/_/g, ' ')}</option>
                ))}
              </select>
            </div>

            <button
              onClick={executeValidation}
              disabled={!isFormValid || isExecuting}
              className="w-full bg-blue-600 text-white py-2 px-4 rounded-md hover:bg-blue-700 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:ring-offset-2 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
            >
              {isExecuting ? 'Executing Validation...' : 'Execute Validation'}
            </button>
          </div>
        </div>

        {/* Results Display */}
        <div className="bg-white rounded-lg shadow-md p-6">
          <h2 className="text-xl font-semibold mb-4">Validation Results</h2>
          
          {error && (
            <div className="bg-red-50 border border-red-200 text-red-700 p-4 rounded-md mb-4">
              {error}
            </div>
          )}

          {isExecuting && (
            <div className="flex items-center justify-center py-12">
              <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-blue-600"></div>
              <span className="ml-3 text-gray-600">Running validation analysis...</span>
            </div>
          )}

          {result && (
            <div className="space-y-6">
              {/* Status Badges */}
              <div className="flex flex-wrap gap-2">
                <span className={`px-3 py-1 rounded-full text-xs font-medium ${
                  result.humanReviewRequired ? 'bg-yellow-100 text-yellow-800' : 'bg-green-100 text-green-800'
                }`}>
                  {result.humanReviewRequired ? 'HUMAN REVIEW REQUIRED' : 'SAFE FOR EXECUTION'}
                </span>
                <span className="px-3 py-1 bg-blue-100 text-blue-800 rounded-full text-xs font-medium">
                  {result.recommendation}
                </span>
                <span className="px-3 py-1 bg-gray-100 text-gray-800 rounded-full text-xs font-medium">
                  {result.capabilityStatus}
                </span>
              </div>

              {/* Core Info */}
              <div>
                <h3 className="font-semibold text-gray-900 mb-2">Objective</h3>
                <p className="text-gray-700">{result.validationObjective}</p>
              </div>

              {/* Assumptions */}
              <div>
                <h3 className="font-semibold text-gray-900 mb-2">Assumptions</h3>
                <ul className="list-disc list-inside space-y-1 text-gray-700">
                  {result.assumptions.map((assumption, i) => (
                    <li key={i}>{assumption}</li>
                  ))}
                </ul>
              </div>

              {/* Prioritized Risks */}
              <div>
                <h3 className="font-semibold text-gray-900 mb-2">Prioritized Risks</h3>
                <div className="space-y-2">
                  {result.prioritizedRisks.map(risk => (
                    <div key={risk.id} className="flex items-start gap-2 p-2 bg-gray-50 rounded-md">
                      <span className={`px-2 py-0.5 rounded text-xs font-medium ${
                        risk.severity === 'HIGH' ? 'bg-red-100 text-red-800' : 
                        risk.severity === 'MEDIUM' ? 'bg-yellow-100 text-yellow-800' : 
                        'bg-green-100 text-green-800'
                      }`}>
                        {risk.severity}
                      </span>
                      <span className="text-gray-700">{risk.risk}</span>
                    </div>
                  ))}
                </div>
              </div>

              {/* Experiment Recommendations */}
              <div>
                <h3 className="font-semibold text-gray-900 mb-2">Proposed Experiments</h3>
                <div className="space-y-3">
                  {result.experimentRecommendations.map(exp => (
                    <div key={exp.id} className="border border-gray-200 rounded-md p-3">
                      <div className="flex justify-between items-start mb-2">
                        <h4 className="font-medium text-gray-900">{exp.experimentName}</h4>
                        <span className="px-2 py-0.5 bg-blue-100 text-blue-800 rounded text-xs">
                          Priority {exp.priority}
                        </span>
                      </div>
                      <p className="text-sm text-gray-600 mb-1"><span className="font-medium">Hypothesis:</span> {exp.hypothesis}</p>
                      <p className="text-sm text-gray-600 mb-1"><span className="font-medium">Method:</span> {exp.method}</p>
                      <p className="text-sm text-gray-600"><span className="font-medium">Success Threshold:</span> {(exp.successThreshold * 100).toFixed(0)}%</p>
                    </div>
                  ))}
                </div>
              </div>

              {/* Current Evidence */}
              <div>
                <h3 className="font-semibold text-gray-900 mb-2">Current Evidence</h3>
                <div className="space-y-2">
                  {result.currentEvidence.map(evidence => (
                    <div key={evidence.id} className="flex items-start gap-2">
                      <span className={`px-2 py-0.5 rounded text-xs font-medium ${
                        evidence.type === 'AI_INFERENCE' ? 'bg-purple-100 text-purple-800' : 
                        evidence.type === 'USER_ENTERED' ? 'bg-blue-100 text-blue-800' : 
                        'bg-green-100 text-green-800'
                      }`}>
                        {evidence.type}
                      </span>
                      <span className="text-gray-700 text-sm">{evidence.content}</span>
                    </div>
                  ))}
                </div>
              </div>

              {/* Confidence */}
              <div>
                <h3 className="font-semibold text-gray-900 mb-2">Confidence Score</h3>
                <div className="w-full bg-gray-200 rounded-full h-2.5">
                  <div 
                    className="bg-blue-600 h-2.5 rounded-full" 
                    style={{ width: `${result.confidence * 100}%` }}
                  ></div>
                </div>
                <p className="text-sm text-gray-600 mt-1">{(result.confidence * 100).toFixed(0)}% confidence based on available evidence</p>
              </div>
            </div>
          )}

          {!result && !isExecuting && !error && (
            <div className="text-center py-12 text-gray-500">
              <svg className="mx-auto h-12 w-12 text-gray-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2m-6 9l2 2 4-4" />
              </svg>
              <p className="mt-2">Fill out the form and execute validation to see results</p>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
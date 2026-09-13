import { PageHeader } from '@/components/shared/page-header';
import { agentRegistry } from '@/lib/agents/agent-registry';
import { Search, CheckCircle2, Package, BarChart3, Crown, AlertCircle, CheckCircle, ArrowRight } from 'lucide-react';
import Link from 'next/link';

const iconMap: Record<string, React.ElementType> = {
  Search,
  CheckCircle2,
  Package,
  BarChart3,
  Crown,
};

const statusConfig = {
  LIVE: { bg: 'bg-green-100', text: 'text-green-700', border: 'border-green-200', icon: CheckCircle },
  MOCKED: { bg: 'bg-amber-100', text: 'text-amber-700', border: 'border-amber-200', icon: AlertCircle },
  PLANNED: { bg: 'bg-slate-100', text: 'text-slate-600', border: 'border-slate-200', icon: AlertCircle },
};

export default function AgentsPage() {
  const agents = agentRegistry.getAllAgents();

  return (
    <div className="p-6 lg:p-8 space-y-6">
      <PageHeader
        title="AI Agents"
        description="Intelligent agents that help discover, build, and scale income opportunities."
      />

      <div className="rounded-lg border border-indigo-200 bg-indigo-50 px-4 py-3 text-sm text-indigo-800">
        <strong>Phase 3.1 Complete:</strong> Agent architecture is now implemented! Agents clearly separate AI_INFERENCE from VERIFIED_DATA and USER_ENTERED evidence. All safety controls are active.
      </div>

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {agents.map((agent) => {
          const Icon = iconMap[agent.icon] || AlertCircle;
          const StatusIcon = statusConfig[agent.status].icon;
          
          const isResearchAgent = agent.id === 'research-agent';
          const isValidationAgent = agent.id === 'validation-agent';
          const isProductAgent = agent.id === 'product-agent';
          const isClickable = isResearchAgent || isValidationAgent || isProductAgent;
          
          const cardContent = (
            <div key={agent.id} className={`rounded-xl border bg-card p-5 shadow-sm ${isClickable ? 'hover:shadow-md transition-shadow cursor-pointer' : ''}`}>
              <div className="flex items-start justify-between mb-3">
                <div className="rounded-lg bg-muted p-2">
                  <Icon className="h-5 w-5 text-muted-foreground" />
                </div>
                <div className="flex items-center gap-2">
                  <span className={`rounded ${statusConfig[agent.status].bg} ${statusConfig[agent.status].text} px-1.5 py-0.5 text-[10px] font-medium flex items-center gap-1`}>
                    <StatusIcon className="h-3 w-3" />
                    {agent.status}
                  </span>
                  {!agent.safeExecutionState && (
                    <span className="rounded bg-red-100 px-1.5 py-0.5 text-[10px] font-medium text-red-600">
                      UNSAFE
                    </span>
                  )}
                  {isClickable && (
                    <ArrowRight className="h-4 w-4 text-muted-foreground" />
                  )}
                </div>
              </div>
              
              <h3 className="text-sm font-semibold mb-2">{agent.name}</h3>
              
              <div className="space-y-2 text-xs">
                <div>
                  <span className="font-medium text-muted-foreground">Purpose:</span>
                  <p className="text-muted-foreground mt-0.5">{agent.purpose}</p>
                </div>
                
                <div>
                  <span className="font-medium text-muted-foreground">Current Capability:</span>
                  <p className="text-muted-foreground mt-0.5">{agent.currentCapability}</p>
                </div>
                
                <div>
                  <span className="font-medium text-muted-foreground">Evidence Policy:</span>
                  <p className="text-muted-foreground mt-0.5">{agent.evidencePolicy}</p>
                </div>

                <div className="pt-2 border-t mt-2">
                  <span className="font-medium text-muted-foreground">Safe Execution:</span>
                  <span className={`ml-2 font-semibold ${agent.safeExecutionState ? 'text-green-600' : 'text-red-600'}`}>
                    {agent.safeExecutionState ? 'ACTIVE' : 'DISABLED'}
                  </span>
                </div>
              </div>
            </div>
          );

          if (isResearchAgent) {
            return (
              <Link href="/agents/research" key={agent.id}>
                {cardContent}
              </Link>
            );
          }

          if (isValidationAgent) {
            return (
              <Link href="/agents/validation" key={agent.id}>
                {cardContent}
              </Link>
            );
          }

          if (isProductAgent) {
            return (
              <Link href="/agents/product" key={agent.id}>
                {cardContent}
              </Link>
            );
          }
          
          return cardContent;
        })}
      </div>
    </div>
  );
}
import { PageHeader } from '@/components/shared/page-header';
import { Bot, Search, CheckCircle2, Package, Link2, Globe, Shield, BarChart3, TrendingUp, Crown } from 'lucide-react';

const agents = [
  {
    name: 'Research Agent',
    description: 'Finds opportunities and market signals. Identifies trends, demand patterns, and underserved niches.',
    icon: Search,
    status: 'PLANNED',
    phase: 'Phase 3',
  },
  {
    name: 'Validation Agent',
    description: 'Evaluates whether an idea deserves investment. Cross-references demand data, competition, and market fit.',
    icon: CheckCircle2,
    status: 'PLANNED',
    phase: 'Phase 3',
  },
  {
    name: 'Product Agent',
    description: 'Creates product plans and content. Generates outlines, descriptions, and production workflows.',
    icon: Package,
    status: 'PLANNED',
    phase: 'Phase 3',
  },
  {
    name: 'Affiliate Agent',
    description: 'Finds legitimate affiliate opportunities and manages affiliate content. Never creates fake relationships.',
    icon: Link2,
    status: 'PLANNED',
    phase: 'Phase 4',
  },
  {
    name: 'SEO Agent',
    description: 'Improves discoverability through keyword research, content optimization, and technical SEO recommendations.',
    icon: Globe,
    status: 'PLANNED',
    phase: 'Phase 4',
  },
  {
    name: 'QA Agent',
    description: 'Checks factual quality, duplicate content, broken links, and halal compliance across all products.',
    icon: Shield,
    status: 'PLANNED',
    phase: 'Phase 4',
  },
  {
    name: 'Analytics Agent',
    description: 'Analyzes traffic, clicks, sales, and revenue. Identifies trends and anomalies in business performance.',
    icon: BarChart3,
    status: 'PLANNED',
    phase: 'Phase 3',
  },
  {
    name: 'Growth Agent',
    description: 'Suggests what should be scaled based on performance data. Recommends budget allocation and priorities.',
    icon: TrendingUp,
    status: 'PLANNED',
    phase: 'Phase 5',
  },
  {
    name: 'Business Manager',
    description: 'Coordinates all other agents. Accepts natural-language commands and orchestrates the business workflow.',
    icon: Crown,
    status: 'PLANNED',
    phase: 'Phase 3',
  },
];

export default function AgentsPage() {
  return (
    <div className="p-6 lg:p-8 space-y-6">
      <PageHeader
        title="AI Agents"
        description="Intelligent agents that help discover, build, and scale income opportunities."
      />

      <div className="rounded-lg border border-purple-200 bg-purple-50 px-4 py-3 text-sm text-purple-800">
        <strong>Agent Architecture:</strong> These agents are designed to eventually operate independently,
        each specializing in a part of the business workflow. They will clearly separate AI inference
        from verified external data and user-entered information. No agent will pretend to have live
        capabilities until APIs are actually connected.
      </div>

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {agents.map((agent) => (
          <div key={agent.name} className="rounded-xl border bg-card p-5 shadow-sm">
            <div className="flex items-start justify-between mb-3">
              <div className="rounded-lg bg-muted p-2">
                <agent.icon className="h-5 w-5 text-muted-foreground" />
              </div>
              <div className="flex items-center gap-2">
                <span className="rounded bg-slate-100 px-1.5 py-0.5 text-[10px] font-medium text-slate-500">
                  {agent.status}
                </span>
                <span className="rounded bg-purple-100 px-1.5 py-0.5 text-[10px] font-medium text-purple-600">
                  {agent.phase}
                </span>
              </div>
            </div>
            <h3 className="text-sm font-semibold mb-1">{agent.name}</h3>
            <p className="text-xs text-muted-foreground">{agent.description}</p>
          </div>
        ))}
      </div>
    </div>
  );
}

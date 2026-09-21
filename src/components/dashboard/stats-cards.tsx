import { DashboardStats } from '@/actions/dashboard';
import { formatCurrency, formatNumber, formatPercentage } from '@/lib/utils';
import {
  Lightbulb,
  CheckCircle2,
  FlaskConical,
  Package,
  Globe,
  DollarSign,
  TrendingUp,
  Target,
} from 'lucide-react';

interface StatsCardsProps {
  stats: DashboardStats;
}

export function StatsCards({ stats }: StatsCardsProps) {
  const cards = [
    {
      title: 'Total Opportunities',
      value: formatNumber(stats.totalOpportunities),
      icon: Lightbulb,
      color: 'text-blue-600',
      bgColor: 'bg-blue-50',
    },
    {
      title: 'Validated',
      value: formatNumber(stats.validatedOpportunities),
      icon: CheckCircle2,
      color: 'text-green-600',
      bgColor: 'bg-green-50',
    },
    {
      title: 'Active Experiments',
      value: formatNumber(stats.activeExperiments),
      icon: FlaskConical,
      color: 'text-purple-600',
      bgColor: 'bg-purple-50',
    },
    {
      title: 'Building',
      value: formatNumber(stats.productsBuildingCount),
      icon: Package,
      color: 'text-amber-600',
      bgColor: 'bg-amber-50',
    },
    {
      title: 'Published',
      value: formatNumber(stats.publishedProducts),
      icon: Globe,
      color: 'text-teal-600',
      bgColor: 'bg-teal-50',
    },
    {
      title: 'Total Revenue',
      value: formatCurrency(stats.totalRevenue),
      icon: DollarSign,
      color: 'text-emerald-600',
      bgColor: 'bg-emerald-50',
    },
    {
      title: 'Revenue This Month',
      value: formatCurrency(stats.revenueThisMonth),
      icon: TrendingUp,
      color: 'text-indigo-600',
      bgColor: 'bg-indigo-50',
    },
    {
      title: 'Conversion Rate',
      value: stats.conversionRate > 0 ? formatPercentage(stats.conversionRate) : 'No data',
      icon: Target,
      color: 'text-rose-600',
      bgColor: 'bg-rose-50',
    },
  ];

  return (
    <div className="grid gap-4 grid-cols-1 sm:grid-cols-2 lg:grid-cols-4">
      {cards.map((card) => (
        <div
          key={card.title}
          className="rounded-xl border bg-card p-6 shadow-sm"
        >
          <div className="flex items-center justify-between">
            <p className="text-sm font-medium text-muted-foreground">{card.title}</p>
            <div className={`rounded-lg p-2 ${card.bgColor}`}>
              <card.icon className={`h-4 w-4 ${card.color}`} />
            </div>
          </div>
          <p className="mt-2 text-2xl font-bold">{card.value}</p>
        </div>
      ))}
    </div>
  );
}

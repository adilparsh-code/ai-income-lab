import { HALAL_COLORS } from '@/lib/constants';
import { cn } from '@/lib/utils';
import { ShieldCheck, ShieldAlert, ShieldX } from 'lucide-react';

interface HalalBadgeProps {
  status: string;
  showIcon?: boolean;
  className?: string;
}

const ICONS = {
  HALAL: ShieldCheck,
  REVIEW_REQUIRED: ShieldAlert,
  NOT_ALLOWED: ShieldX,
};

const LABELS: Record<string, string> = {
  HALAL: 'Halal',
  REVIEW_REQUIRED: 'Review Required',
  NOT_ALLOWED: 'Not Allowed',
};

export function HalalBadge({ status, showIcon = true, className }: HalalBadgeProps) {
  const colorClass = HALAL_COLORS[status] || 'bg-gray-100 text-gray-700 border-gray-200';
  const Icon = ICONS[status as keyof typeof ICONS];
  
  return (
    <span className={cn(
      'inline-flex items-center gap-1 rounded-full border px-2.5 py-0.5 text-xs font-medium',
      colorClass,
      className
    )}>
      {showIcon && Icon && <Icon className="h-3 w-3" />}
      {LABELS[status] || status}
    </span>
  );
}

import { cn, getScoreColor, getScoreBgColor } from '@/lib/utils';

interface ScoreDisplayProps {
  score: number;
  size?: 'sm' | 'md' | 'lg';
  showLabel?: boolean;
  label?: string;
  className?: string;
}

const sizeClasses = {
  sm: 'h-8 w-8 text-xs',
  md: 'h-12 w-12 text-sm',
  lg: 'h-16 w-16 text-lg',
};

export function ScoreDisplay({ score, size = 'md', showLabel = false, label = 'Score', className }: ScoreDisplayProps) {
  return (
    <div className={cn('flex flex-col items-center gap-1', className)}>
      <div className={cn(
        'flex items-center justify-center rounded-full border-2 font-bold',
        sizeClasses[size],
        getScoreBgColor(score),
        getScoreColor(score)
      )}>
        {score}
      </div>
      {showLabel && (
        <span className="text-xs text-muted-foreground">{label}</span>
      )}
    </div>
  );
}

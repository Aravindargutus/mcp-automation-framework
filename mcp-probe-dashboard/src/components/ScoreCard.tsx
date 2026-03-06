'use client';

const GRADE_COLORS: Record<string, string> = {
  A: 'text-emerald-400 border-emerald-400/30 bg-emerald-400/10',
  B: 'text-blue-400 border-blue-400/30 bg-blue-400/10',
  C: 'text-yellow-400 border-yellow-400/30 bg-yellow-400/10',
  D: 'text-orange-400 border-orange-400/30 bg-orange-400/10',
  F: 'text-red-400 border-red-400/30 bg-red-400/10',
};

interface ScoreCardProps {
  grade: string;
  percentage: number;
  passed: number;
  total: number;
  compact?: boolean;
}

export default function ScoreCard({ grade, percentage, passed, total, compact }: ScoreCardProps) {
  const colorClass = GRADE_COLORS[grade] ?? GRADE_COLORS.F;

  if (compact) {
    return (
      <span className={`inline-flex items-center gap-1.5 rounded-md border px-2 py-0.5 text-sm font-bold ${colorClass}`}>
        {grade}
        <span className="text-xs font-normal opacity-75">{percentage}%</span>
      </span>
    );
  }

  const circumference = 2 * Math.PI * 40;
  const strokeDashoffset = circumference - (percentage / 100) * circumference;

  return (
    <div className={`flex flex-col items-center gap-3 rounded-xl border p-6 ${colorClass}`}>
      <div className="relative h-24 w-24">
        <svg className="h-24 w-24 -rotate-90" viewBox="0 0 100 100">
          <circle cx="50" cy="50" r="40" stroke="currentColor" strokeWidth="6" fill="none" opacity={0.15} />
          <circle
            cx="50" cy="50" r="40"
            stroke="currentColor" strokeWidth="6" fill="none"
            strokeLinecap="round"
            strokeDasharray={circumference}
            strokeDashoffset={strokeDashoffset}
            className="transition-all duration-700"
          />
        </svg>
        <div className="absolute inset-0 flex items-center justify-center">
          <span className="text-3xl font-black">{grade}</span>
        </div>
      </div>
      <div className="text-center">
        <div className="text-2xl font-bold">{percentage}%</div>
        <div className="text-sm opacity-60">{passed}/{total} tests passed</div>
      </div>
    </div>
  );
}

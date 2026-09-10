import React from 'react';

export type BadgeVariant = 'indigo' | 'emerald' | 'rose' | 'amber' | 'slate' | 'sky' | 'purple';

interface BadgeProps {
  children: React.ReactNode;
  variant?: BadgeVariant;
  className?: string;
  dot?: boolean;
}

const variantClasses: Record<BadgeVariant, string> = {
  indigo: 'bg-indigo-50 text-indigo-700 border-indigo-200/80',
  emerald: 'bg-emerald-50 text-emerald-700 border-emerald-200/80',
  rose: 'bg-rose-50 text-rose-700 border-rose-200/80',
  amber: 'bg-amber-50 text-amber-700 border-amber-200/80',
  slate: 'bg-slate-100 text-slate-700 border-slate-200',
  sky: 'bg-sky-50 text-sky-700 border-sky-200/80',
  purple: 'bg-purple-50 text-purple-700 border-purple-200/80',
};

const dotColors: Record<BadgeVariant, string> = {
  indigo: 'bg-indigo-500',
  emerald: 'bg-emerald-500',
  rose: 'bg-rose-500',
  amber: 'bg-amber-500',
  slate: 'bg-slate-400',
  sky: 'bg-sky-500',
  purple: 'bg-purple-500',
};

export const Badge: React.FC<BadgeProps> = ({
  children,
  variant = 'slate',
  className = '',
  dot = false,
}) => {
  return (
    <span
      className={`inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full text-xs font-medium border ${variantClasses[variant]} ${className}`}
    >
      {dot && <span className={`w-1.5 h-1.5 rounded-full ${dotColors[variant]}`} />}
      <span>{children}</span>
    </span>
  );
};

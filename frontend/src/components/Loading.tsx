import React from 'react';
import { Loader2 } from 'lucide-react';

export const LoadingSpinner: React.FC<{ text?: string; className?: string }> = ({
  text = '加载中...',
  className = '',
}) => {
  return (
    <div className={`flex flex-col items-center justify-center p-12 text-slate-400 gap-3 ${className}`}>
      <Loader2 className="w-8 h-8 animate-spin text-indigo-600" />
      <span className="text-sm font-medium text-slate-500">{text}</span>
    </div>
  );
};

export const TableSkeleton: React.FC<{ rows?: number; cols?: number }> = ({ rows = 5, cols = 5 }) => {
  return (
    <div className="w-full animate-pulse divide-y divide-slate-100">
      <div className="bg-slate-50/50 py-3.5 px-6 flex gap-4">
        {Array.from({ length: cols }).map((_, i) => (
          <div key={i} className="h-4 bg-slate-200 rounded flex-1" />
        ))}
      </div>
      {Array.from({ length: rows }).map((_, rowIndex) => (
        <div key={rowIndex} className="py-4 px-6 flex gap-4 items-center">
          {Array.from({ length: cols }).map((_, colIndex) => (
            <div
              key={colIndex}
              className={`h-4 bg-slate-100 rounded ${colIndex === 0 ? 'w-1/4' : 'flex-1'}`}
            />
          ))}
        </div>
      ))}
    </div>
  );
};

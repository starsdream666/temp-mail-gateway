import React, { useState } from 'react';
import { Copy, Check } from 'lucide-react';

interface CopyButtonProps {
  text: string;
  className?: string;
  iconOnly?: boolean;
  label?: string;
  title?: string;
}

export const CopyButton: React.FC<CopyButtonProps> = ({
  text,
  className = '',
  iconOnly = false,
  label = '复制',
  title,
}) => {
  const [copied, setCopied] = useState(false);

  const handleCopy = async (e: React.MouseEvent) => {
    e.stopPropagation();
    try {
      if (navigator.clipboard && window.isSecureContext) {
        await navigator.clipboard.writeText(text);
      } else {
        // 纯 HTTP 兜底（!isSecureContext 时才走）：textarea 必须保证被移除并先清空，
        // 否则明文会残留在 DOM/无障碍树里
        const textarea = document.createElement('textarea');
        textarea.value = text;
        textarea.style.position = 'fixed';
        textarea.style.opacity = '0';
        document.body.appendChild(textarea);
        try {
          textarea.select();
          document.execCommand('copy');
        } finally {
          textarea.value = '';
          document.body.removeChild(textarea);
        }
      }
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // 复制失败兜底
    }
  };

  const buttonTitle = title || (copied ? '已复制' : `复制 ${text}`);

  return (
    <button
      type="button"
      onClick={handleCopy}
      title={buttonTitle}
      className={`inline-flex items-center gap-1.5 px-2 py-1 text-xs font-medium rounded transition-colors ${
        copied
          ? 'bg-emerald-50 text-emerald-700 border border-emerald-200'
          : 'bg-slate-100 text-slate-700 hover:bg-slate-200 border border-slate-300'
      } ${className}`}
    >
      {copied ? <Check className="w-3.5 h-3.5 text-emerald-600" /> : <Copy className="w-3.5 h-3.5 text-slate-500" />}
      {!iconOnly && <span>{copied ? '已复制' : label}</span>}
    </button>
  );
};

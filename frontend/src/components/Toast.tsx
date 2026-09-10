import React, { createContext, useContext, useState, useCallback } from 'react';
import { CheckCircle2, AlertCircle, AlertTriangle, Info, X } from 'lucide-react';

export type ToastType = 'success' | 'error' | 'warning' | 'info';

export interface ToastItem {
  id: string;
  type: ToastType;
  message: string;
  duration?: number;
}

interface ToastContextValue {
  showToast: (type: ToastType, message: string, duration?: number) => void;
  success: (message: string, duration?: number) => void;
  error: (message: string, duration?: number) => void;
  warning: (message: string, duration?: number) => void;
  info: (message: string, duration?: number) => void;
}

const ToastContext = createContext<ToastContextValue | null>(null);

/** toast 外观常量（避免每次渲染在 map 里重建对象/JSX） */
const TOAST_BG: Record<ToastType, string> = {
  success: 'bg-emerald-50 border-emerald-200 text-emerald-900',
  error: 'bg-rose-50 border-rose-200 text-rose-900',
  warning: 'bg-amber-50 border-amber-200 text-amber-900',
  info: 'bg-indigo-50 border-indigo-200 text-indigo-900',
};

const TOAST_ICONS: Record<ToastType, React.ReactNode> = {
  success: <CheckCircle2 className="w-5 h-5 text-emerald-600 flex-shrink-0" />,
  error: <AlertCircle className="w-5 h-5 text-rose-600 flex-shrink-0" />,
  warning: <AlertTriangle className="w-5 h-5 text-amber-600 flex-shrink-0" />,
  info: <Info className="w-5 h-5 text-indigo-600 flex-shrink-0" />,
};

export const ToastProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [toasts, setToasts] = useState<ToastItem[]>([]);
  const timersRef = React.useRef<number[]>([]);

  // 卸载时清理全部待触发的定时器，避免卸载后 setState
  React.useEffect(() => {
    const timers = timersRef.current;
    return () => {
      timers.forEach((t) => window.clearTimeout(t));
      timersRef.current = [];
    };
  }, []);

  const removeToast = useCallback((id: string) => {
    setToasts((prev) => prev.filter((item) => item.id !== id));
  }, []);

  const showToast = useCallback(
    (type: ToastType, message: string, duration = 4000) => {
      const id = `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
      setToasts((prev) => [...prev, { id, type, message, duration }]);

      if (duration > 0) {
        const timer = window.setTimeout(() => {
          removeToast(id);
        }, duration);
        timersRef.current.push(timer);
      }
    },
    [removeToast],
  );

  const success = useCallback((msg: string, dur?: number) => showToast('success', msg, dur), [showToast]);
  const error = useCallback((msg: string, dur?: number) => showToast('error', msg, dur ?? 5000), [showToast]);
  const warning = useCallback((msg: string, dur?: number) => showToast('warning', msg, dur ?? 4500), [showToast]);
  const info = useCallback((msg: string, dur?: number) => showToast('info', msg, dur), [showToast]);

  return (
    <ToastContext.Provider value={{ showToast, success, error, warning, info }}>
      {children}
      <div className="fixed top-4 right-4 z-50 flex flex-col gap-2 max-w-sm w-full pointer-events-none px-4 sm:px-0">
        {toasts.map((toast) => (
          <div
            key={toast.id}
            role="alert"
            className={`pointer-events-auto flex items-start gap-3 p-3.5 rounded-lg border shadow-lg transition-all duration-200 animate-in slide-in-from-top-2 ${TOAST_BG[toast.type]}`}
          >
            <div className="pt-0.5">{TOAST_ICONS[toast.type]}</div>
            <div className="flex-1 text-sm leading-snug break-words">{toast.message}</div>
            <button
              type="button"
              onClick={() => removeToast(toast.id)}
              className="opacity-70 hover:opacity-100 transition-opacity p-0.5 -mr-1 -mt-1 text-slate-500 hover:text-slate-800"
              aria-label="关闭提示"
            >
              <X className="w-4 h-4" />
            </button>
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
};

export const useToast = (): ToastContextValue => {
  const context = useContext(ToastContext);
  if (!context) {
    throw new Error('useToast must be used within a ToastProvider');
  }
  return context;
};

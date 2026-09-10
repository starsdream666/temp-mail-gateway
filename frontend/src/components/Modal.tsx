import React, { useEffect, useId, useRef } from 'react';
import { X } from 'lucide-react';

interface ModalProps {
  isOpen: boolean;
  onClose: () => void;
  title: React.ReactNode;
  children: React.ReactNode;
  footer?: React.ReactNode;
  maxWidth?: 'sm' | 'md' | 'lg' | 'xl' | '2xl';
  closeOnOverlayClick?: boolean;
}

const FOCUSABLE_SELECTOR =
  'a[href], button:not([disabled]), textarea, input, select, [tabindex]:not([tabindex="-1"])';

export const Modal: React.FC<ModalProps> = ({
  isOpen,
  onClose,
  title,
  children,
  footer,
  maxWidth = 'md',
  closeOnOverlayClick = true,
}) => {
  const titleId = useId();
  const panelRef = useRef<HTMLDivElement>(null);
  const closeButtonRef = useRef<HTMLButtonElement>(null);
  // onClose 的引用在父组件每次渲染都可能变化（内联箭头函数）；键盘监听需要最新值，
  // 但 effect 绝不能依赖它重跑——否则每次输入触发重渲染都会重新执行聚焦逻辑。
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  const prevOpenRef = useRef(false);

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (!isOpen) return;
      if (e.key === 'Escape') {
        e.stopPropagation();
        onCloseRef.current();
        return;
      }
      // 焦点陷阱：Tab/Shift+Tab 圈在对话框容器内，不走到遮罩后的页面
      if (e.key !== 'Tab' || !panelRef.current) return;
      const focusables = panelRef.current.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR);
      if (focusables.length === 0) return;
      const first = focusables[0]!;
      const last = focusables[focusables.length - 1]!;
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    };

    // 只监听键盘；effect 依赖 isOpen 而非 onClose（onClose 经 ref 取最新值）
    const previousFocus = document.activeElement as HTMLElement | null;
    const justOpened = isOpen && !prevOpenRef.current;
    prevOpenRef.current = isOpen;

    if (isOpen) {
      document.body.style.overflow = 'hidden';
      window.addEventListener('keydown', handleKeyDown);
      if (justOpened) {
        // 打开时把焦点移入对话框：已有 autoFocus 元素（如表单首字段）就尊重它，
        // 不抢焦点——否则父组件每渲染出新 onClose 引用、effect 重跑时会反复把
        // 焦点拉回第一个可聚焦元素（关闭按钮 DOM 序在内容之前），导致输入中断。
        requestAnimationFrame(() => {
          const panel = panelRef.current;
          if (!panel) return;
          if (panel.querySelector<HTMLElement>('[autofocus]')) return;
          const first = panel.querySelector<HTMLElement>(FOCUSABLE_SELECTOR);
          (first ?? closeButtonRef.current)?.focus();
        });
      }
    }
    return () => {
      document.body.style.overflow = 'unset';
      window.removeEventListener('keydown', handleKeyDown);
      // 关闭时把焦点还给触发元素
      if (isOpen && previousFocus && document.contains(previousFocus)) {
        previousFocus.focus();
      }
    };
  }, [isOpen]);

  if (!isOpen) return null;

  const widthClasses = {
    sm: 'max-w-sm',
    md: 'max-w-md',
    lg: 'max-w-lg',
    xl: 'max-w-xl',
    '2xl': 'max-w-2xl',
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 sm:p-6 overflow-y-auto">
      {/* 遮罩背景 */}
      <div
        className="fixed inset-0 bg-slate-900/50 backdrop-blur-sm transition-opacity"
        onClick={() => closeOnOverlayClick && onClose()}
      />

      {/* 对话框卡片 */}
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        className={`relative w-full ${widthClasses[maxWidth]} bg-white rounded-xl shadow-2xl border border-slate-100 flex flex-col max-h-[90vh] z-10 animate-in fade-in zoom-in-95 duration-150`}
      >
        {/* 标题栏 */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-slate-100">
          <h3 id={titleId} className="text-lg font-semibold text-slate-900">
            {title}
          </h3>
          <button
            ref={closeButtonRef}
            type="button"
            onClick={onClose}
            className="p-1 rounded-lg text-slate-400 hover:text-slate-600 hover:bg-slate-100 transition-colors"
            aria-label="关闭对话框"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* 内容区 */}
        <div className="px-6 py-5 overflow-y-auto flex-1 text-slate-700">{children}</div>

        {/* 底部操作区 */}
        {footer && (
          <div className="flex items-center justify-end gap-3 px-6 py-4 bg-slate-50/80 border-t border-slate-100 rounded-b-xl">
            {footer}
          </div>
        )}
      </div>
    </div>
  );
};

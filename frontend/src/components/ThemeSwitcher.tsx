import React, { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Check, ChevronDown, Gauge, Palette, Sparkles } from 'lucide-react';
import { ThemeDefinition, useTheme } from '../context/ThemeContext';

interface ThemeSwitcherProps {
  variant?: 'sidebar' | 'floating' | 'icon';
  collapsed?: boolean;
  onTooltipEnter?: (el: HTMLElement, label: string, description?: string) => void;
  onTooltipLeave?: () => void;
}

interface PopoverCoords {
  top: number;
  left: number;
}

/** 主题微缩效果卡片：固定展示每套主题各自的底色、纹理、导航条与装饰按钮形态 */
const ThemeMiniPreview: React.FC<{ item: ThemeDefinition }> = ({ item }) => {
  const { id, swatches } = item;

  return (
    <div
      aria-hidden="true"
      className="relative w-14 h-10 rounded-lg overflow-hidden border shrink-0 flex flex-col justify-between p-1.5"
      style={{
        backgroundColor: swatches.canvas,
        borderColor: item.isDark ? 'rgba(56, 189, 248, 0.35)' : 'rgba(148, 163, 184, 0.35)',
        backgroundImage:
          id === 'cyber-terminal'
            ? 'linear-gradient(to right, rgba(34,211,238,0.16) 1px, transparent 1px), linear-gradient(to bottom, rgba(34,211,238,0.16) 1px, transparent 1px)'
            : id === 'warm-paper'
              ? 'linear-gradient(to right, rgba(180,130,80,0.14) 1px, transparent 1px), linear-gradient(to bottom, rgba(180,130,80,0.14) 1px, transparent 1px)'
              : id === 'indigo-atelier'
                ? 'radial-gradient(rgba(79,70,229,0.2) 1px, transparent 1px)'
                : 'radial-gradient(circle at 80% 20%, rgba(124,58,237,0.28), transparent 60%), radial-gradient(circle at 20% 80%, rgba(6,182,212,0.25), transparent 60%)',
        backgroundSize: id === 'aurora-glass' ? '100% 100%' : '8px 8px',
      }}
    >
      {id === 'cyber-terminal' && (
        <span className="absolute top-0.5 right-0.5 w-1.5 h-1.5 border-t border-r border-cyan-400/80" />
      )}
      {id === 'warm-paper' && (
        <span className="absolute -top-0.5 left-1/2 -translate-x-1/2 w-5 h-1 bg-amber-300/70 rotate-[-3deg]" />
      )}
      {id === 'aurora-glass' && (
        <span className="absolute top-0.5 right-1 text-[7px] leading-none text-violet-500">✦</span>
      )}
      {id === 'indigo-atelier' && (
        <span className="absolute top-0.5 right-1 w-2 h-2 rounded-full border border-dashed border-indigo-400/60" />
      )}
      <div className="flex items-center gap-1">
        <span
          className="w-2.5 h-6 rounded-[3px] border"
          style={{
            backgroundColor: swatches.surface,
            borderColor: item.isDark ? 'rgba(56, 189, 248, 0.28)' : 'rgba(148, 163, 184, 0.25)',
          }}
        />
        <div className="flex-1 space-y-1">
          <div
            className="h-2.5 rounded-[3px] border"
            style={{
              backgroundColor: swatches.surface,
              borderColor: item.isDark ? 'rgba(56, 189, 248, 0.28)' : 'rgba(148, 163, 184, 0.25)',
            }}
          />
          <div className="flex justify-end gap-0.5">
            <span
              className="inline-block w-2 h-2 rounded-[2px] border"
              style={{
                backgroundColor: swatches.surface,
                borderColor: item.isDark ? 'rgba(34,211,238,0.45)' : 'rgba(148,163,184,0.35)',
              }}
            />
            <span
              className="inline-block w-5 h-2 rounded-[3px]"
              style={{
                background: `linear-gradient(135deg, ${swatches.accent}, ${swatches.secondary})`,
                boxShadow:
                  id === 'warm-paper'
                    ? '0 1.5px 0 #7c2d12'
                    : id === 'cyber-terminal'
                      ? '0 0 6px rgba(34,211,238,0.85)'
                      : 'none',
                border:
                  id === 'cyber-terminal'
                    ? '1px solid rgba(165,243,252,0.85)'
                    : id === 'warm-paper'
                      ? '1px dashed rgba(255,247,237,0.75)'
                      : id === 'aurora-glass'
                        ? '1px solid rgba(255,255,255,0.75)'
                        : 'none',
              }}
            />
          </div>
        </div>
      </div>
    </div>
  );
};

export const ThemeSwitcher: React.FC<ThemeSwitcherProps> = ({
  variant = 'sidebar',
  collapsed = false,
  onTooltipEnter,
  onTooltipLeave,
}) => {
  const {
    theme,
    currentTheme,
    themes,
    setTheme,
    motionSpeed,
    currentMotionSpeed,
    motionSpeeds,
    setMotionSpeed,
  } = useTheme();
  const [open, setOpen] = useState(false);
  const [coords, setCoords] = useState<PopoverCoords>({ top: 0, left: 0 });
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const panelRef = useRef<HTMLDivElement | null>(null);

  const updatePosition = () => {
    const trigger = triggerRef.current;
    if (!trigger || typeof window === 'undefined') return;
    const rect = trigger.getBoundingClientRect();
    const panelWidth = Math.min(368, window.innerWidth - 24);
    const panelHeight = 472;

    let left = rect.right - panelWidth;
    let top = rect.bottom + 8;

    if (variant === 'sidebar') {
      const isDesktop = window.matchMedia('(min-width: 768px)').matches;
      if (isDesktop) {
        const asideRight = trigger.closest('aside')?.getBoundingClientRect().right ?? rect.right;
        left = asideRight + 12;
        top = Math.max(12, Math.min(rect.bottom - panelHeight + 8, window.innerHeight - panelHeight - 12));
      } else {
        left = Math.max(12, Math.min(rect.left, window.innerWidth - panelWidth - 12));
        top = Math.max(12, rect.top - panelHeight - 8);
      }
    } else {
      left = Math.max(12, Math.min(rect.right - panelWidth, window.innerWidth - panelWidth - 12));
      if (top + panelHeight > window.innerHeight - 12) {
        top = Math.max(12, rect.top - panelHeight - 8);
      }
    }

    setCoords({ top, left });
  };

  useEffect(() => {
    if (!open) return;
    updatePosition();

    const handlePointerDown = (e: MouseEvent) => {
      const target = e.target as Node;
      if (triggerRef.current?.contains(target) || panelRef.current?.contains(target)) {
        return;
      }
      setOpen(false);
    };

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setOpen(false);
        triggerRef.current?.focus();
      }
    };

    const handleReposition = () => updatePosition();

    window.addEventListener('mousedown', handlePointerDown);
    window.addEventListener('keydown', handleKeyDown);
    window.addEventListener('resize', handleReposition);
    return () => {
      window.removeEventListener('mousedown', handlePointerDown);
      window.removeEventListener('keydown', handleKeyDown);
      window.removeEventListener('resize', handleReposition);
    };
  }, [open, variant, collapsed]);

  const handleToggle = () => {
    onTooltipLeave?.();
    setOpen((prev) => !prev);
  };

  const popover = open ? (
    <div
      ref={panelRef}
      role="dialog"
      aria-label="选择界面主题"
      style={{ top: `${coords.top}px`, left: `${coords.left}px`, width: 'min(368px, calc(100vw - 24px))' }}
      className="fixed z-50 rounded-2xl border border-slate-200 bg-white shadow-2xl p-3 max-h-[calc(100vh-24px)] overflow-y-auto animate-in fade-in zoom-in-95 duration-150"
    >
      <div className="flex items-center justify-between px-1.5 pb-2.5 mb-2 border-b border-slate-100">
        <div className="flex items-center gap-1.5">
          <Sparkles className="w-3.5 h-3.5 text-indigo-600" />
          <span className="text-xs font-bold text-slate-900">主题风格与氛围装饰</span>
        </div>
        <span className="text-[11px] font-medium text-slate-400">{themes.length} 套方案</span>
      </div>

      <div className="space-y-1.5">
        {themes.map((item) => {
          const active = item.id === theme;
          return (
            <button
              key={item.id}
              type="button"
              onClick={() => setTheme(item.id)}
              aria-pressed={active}
              className={[
                'theme-swatch-card w-full flex items-center gap-3 p-2 rounded-xl border text-left transition-all duration-150',
                active
                  ? 'border-indigo-200 bg-indigo-50/70 shadow-sm'
                  : 'border-transparent hover:border-slate-200 hover:bg-slate-50',
              ].join(' ')}
            >
              <ThemeMiniPreview item={item} />
              <div className="flex-1 min-w-0">
                <div className="flex items-center flex-wrap gap-1.5">
                  <span className="text-xs font-semibold text-slate-900">{item.name}</span>
                  <span className="text-[10px] px-1.5 py-0.5 rounded bg-slate-100 text-slate-500 font-medium">
                    {item.decorationTag}
                  </span>
                </div>
                <p className="text-[11px] text-slate-500 mt-0.5 leading-snug">{item.description}</p>
              </div>
              <div
                className={`w-5 h-5 rounded-full flex items-center justify-center shrink-0 transition-colors ${
                  active ? 'bg-indigo-600 text-white' : 'bg-slate-100 text-transparent'
                }`}
              >
                <Check className="w-3 h-3" />
              </div>
            </button>
          );
        })}
      </div>

      <div className="mt-2.5 pt-2.5 border-t border-slate-100">
        <div className="flex items-center justify-between px-1 mb-2">
          <div className="flex items-center gap-1.5">
            <Gauge className="w-3.5 h-3.5 text-indigo-600" />
            <span className="text-xs font-semibold text-slate-800">页面切换动画速度</span>
          </div>
          <span className="text-[11px] font-mono text-slate-400">{currentMotionSpeed.badge}</span>
        </div>
        <div
          role="group"
          aria-label="页面切换动画速度"
          className="grid grid-cols-3 gap-1.5 p-1 rounded-xl bg-slate-100/70 border border-slate-200/60"
        >
          {motionSpeeds.map((item) => {
            const active = item.id === motionSpeed;
            return (
              <button
                key={item.id}
                type="button"
                onClick={() => setMotionSpeed(item.id)}
                aria-pressed={active}
                title={item.description}
                className={[
                  'theme-swatch-card py-1.5 px-2 rounded-lg text-xs font-semibold transition-all duration-150',
                  active
                    ? 'bg-white text-indigo-600 shadow-sm border border-indigo-200'
                    : 'text-slate-600 hover:text-slate-900 border border-transparent',
                ].join(' ')}
              >
                {item.label}
              </button>
            );
          })}
        </div>
        <p className="mt-1.5 px-1 text-[11px] text-slate-400">{currentMotionSpeed.description}</p>
      </div>
    </div>
  ) : null;

  return (
    <>
      {variant === 'floating' && (
        <button
          ref={triggerRef}
          type="button"
          onClick={handleToggle}
          aria-expanded={open}
          aria-label={`切换主题，当前：${currentTheme.name}`}
          className="theme-swatch-card inline-flex items-center gap-2 px-3 py-2 rounded-xl bg-white border border-slate-200 shadow-sm text-xs font-medium text-slate-700 hover:border-indigo-300 transition-all"
        >
          <span
            className="w-3 h-3 rounded-full shrink-0 border border-white/60 shadow-sm"
            style={{
              background: `linear-gradient(135deg, ${currentTheme.swatches.accent}, ${currentTheme.swatches.secondary})`,
            }}
          />
          <span>{currentTheme.name}</span>
          <ChevronDown className={`w-3.5 h-3.5 text-slate-400 transition-transform ${open ? 'rotate-180' : ''}`} />
        </button>
      )}

      {variant === 'icon' && (
        <button
          ref={triggerRef}
          type="button"
          onClick={handleToggle}
          aria-expanded={open}
          aria-label={`切换主题，当前：${currentTheme.name}`}
          title={`切换主题（${currentTheme.name}）`}
          className="theme-swatch-card relative p-2 rounded-lg text-slate-600 hover:bg-slate-100 transition-colors"
        >
          <Palette className="w-5 h-5" />
          <span
            className="absolute top-1.5 right-1.5 w-2 h-2 rounded-full border border-white"
            style={{ backgroundColor: currentTheme.swatches.accent }}
          />
        </button>
      )}

      {variant === 'sidebar' && (
        <button
          ref={triggerRef}
          type="button"
          onClick={handleToggle}
          aria-expanded={open}
          aria-label={`切换主题，当前：${currentTheme.name}`}
          onMouseEnter={(e) => onTooltipEnter?.(e.currentTarget, '外观主题', `当前：${currentTheme.name} · 动画：${currentMotionSpeed.label}`)}
          onMouseLeave={() => onTooltipLeave?.()}
          onFocus={(e) => onTooltipEnter?.(e.currentTarget, '外观主题', `当前：${currentTheme.name} · 动画：${currentMotionSpeed.label}`)}
          onBlur={() => onTooltipLeave?.()}
          className={`theme-swatch-card w-full flex items-center py-2 px-3 rounded-lg border border-slate-200/80 bg-white/80 hover:border-indigo-300 text-xs font-medium text-slate-700 transition-all mb-2.5 ${
            collapsed ? 'md:justify-center' : 'justify-between'
          }`}
        >
          <div className="flex items-center min-w-0">
            <span className="relative shrink-0 inline-flex items-center justify-center">
              <Palette className="w-4 h-4 text-indigo-600" />
              <span
                className={`absolute -top-0.5 -right-0.5 w-1.5 h-1.5 rounded-full transition-opacity ${
                  collapsed ? 'md:opacity-100 opacity-0' : 'opacity-0'
                }`}
                style={{ backgroundColor: currentTheme.swatches.accent }}
              />
            </span>
            <span
              className={`whitespace-nowrap overflow-hidden transition-[opacity,max-width,margin] duration-200 ${
                collapsed ? 'md:opacity-0 md:max-w-0 md:ml-0' : 'opacity-100 max-w-[90px] ml-2'
              }`}
            >
              外观主题
            </span>
          </div>
          <span
            className={`inline-flex items-center gap-1.5 whitespace-nowrap overflow-hidden transition-[opacity,max-width] duration-200 ${
              collapsed ? 'md:opacity-0 md:max-w-0' : 'opacity-100 max-w-[110px]'
            }`}
          >
            <span
              className="w-2.5 h-2.5 rounded-full shrink-0"
              style={{
                background: `linear-gradient(135deg, ${currentTheme.swatches.accent}, ${currentTheme.swatches.secondary})`,
              }}
            />
            <span className="text-[11px] text-slate-500 truncate">{currentTheme.name}</span>
          </span>
        </button>
      )}

      {popover && (typeof document !== 'undefined' ? createPortal(popover, document.body) : popover)}
    </>
  );
};

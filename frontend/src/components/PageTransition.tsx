import React, { useEffect, useRef, useState } from 'react';
import { useTheme } from '../context/ThemeContext';
export type TransitionDirection = 'forward' | 'backward' | 'fade';

interface PageTransitionProps {
  direction?: TransitionDirection;
  className?: string;
  children: React.ReactNode;
}

const DIRECTION_CLASS: Record<TransitionDirection, string> = {
  forward: 'page-enter-forward',
  backward: 'page-enter-backward',
  fade: 'page-enter-fade',
};

function prefersReducedMotion(): boolean {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') {
    return false;
  }
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

/**
 * 页面切换入场容器：
 * - 推荐配合 `key={location.pathname}` 使用，保证路径变化时稳定触发入场动画；
 * - 动画结束后自动移除动画类名，确保不残留 `transform` 或 `will-change` 影响内部 `fixed` 元素层叠。
 */
export const PageTransition: React.FC<PageTransitionProps> = ({
  direction = 'fade',
  className = '',
  children,
}) => {
  const { currentMotionSpeed } = useTheme();
  const [animating, setAnimating] = useState<boolean>(() => !prefersReducedMotion());

  useEffect(() => {
    if (!animating) return;
    const timer = window.setTimeout(() => {
      setAnimating(false);
    }, currentMotionSpeed.pageEnterMs + 140);
    return () => window.clearTimeout(timer);
  }, [animating, currentMotionSpeed.pageEnterMs]);
  const animationClass = animating ? DIRECTION_CLASS[direction] : '';
  const mergedClassName = [animationClass, className].filter(Boolean).join(' ');

  return (
    <div
      className={mergedClassName || undefined}
      onAnimationEnd={(e) => {
        if (e.target === e.currentTarget) {
          setAnimating(false);
        }
      }}
    >
      {children}
    </div>
  );
};

interface RouteProgressBarProps {
  routeKey: string;
}

/**
 * 路由切换顶部流光条：
 * 仅在 `routeKey` 真正变化（发生页面跳转）时触发，首次挂载不打扰首屏视觉。
 */
export const RouteProgressBar: React.FC<RouteProgressBarProps> = ({ routeKey }) => {
  const { currentMotionSpeed } = useTheme();
  const prevKeyRef = useRef<string>(routeKey);
  const [sweepId, setSweepId] = useState<number>(0);
  const [visible, setVisible] = useState<boolean>(false);

  useEffect(() => {
    if (prevKeyRef.current === routeKey) return;
    prevKeyRef.current = routeKey;

    if (prefersReducedMotion()) return;

    setSweepId((id) => id + 1);
    setVisible(true);
  }, [routeKey]);

  useEffect(() => {
    if (!visible) return;
    const timer = window.setTimeout(() => {
      setVisible(false);
    }, currentMotionSpeed.routeProgressMs + 140);
    return () => window.clearTimeout(timer);
  }, [visible, sweepId, currentMotionSpeed.routeProgressMs]);
  if (!visible) return null;

  return (
    <div
      aria-hidden="true"
      className="fixed top-0 left-0 right-0 z-50 h-[2.5px] pointer-events-none overflow-hidden"
    >
      <div
        key={sweepId}
        onAnimationEnd={() => setVisible(false)}
        className="route-progress-sweep h-full w-full theme-progress-bar"
      />
    </div>
  );
};

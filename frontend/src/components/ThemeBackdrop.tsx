import React from 'react';
import { useTheme } from '../context/ThemeContext';

/**
 * 随主题切换的全局背景纹理与装饰层。
 * 固定在最底层（z-0, pointer-events-none），为不同主题营造独特的空间氛围。
 */
export const ThemeBackdrop: React.FC = () => {
  const { theme } = useTheme();

  return (
    <div
      aria-hidden="true"
      className="fixed inset-0 z-0 pointer-events-none overflow-hidden select-none"
    >
      {theme === 'indigo-atelier' && (
        <div className="absolute inset-0 bg-slate-50">
          <div className="absolute inset-0 theme-backdrop-dotgrid opacity-75" />
          <div className="absolute -top-44 -right-32 w-[520px] h-[520px] rounded-full bg-indigo-200/35 blur-3xl" />
          <div className="absolute -bottom-48 -left-36 w-[500px] h-[500px] rounded-full bg-sky-200/35 blur-3xl" />
          <svg
            className="absolute top-0 right-0 w-[440px] h-[440px] text-indigo-400/20"
            viewBox="0 0 400 400"
            fill="none"
          >
            <circle cx="340" cy="60" r="140" stroke="currentColor" strokeWidth="1" strokeDasharray="4 6" />
            <circle cx="340" cy="60" r="210" stroke="currentColor" strokeWidth="1" />
            <circle cx="340" cy="60" r="280" stroke="currentColor" strokeWidth="0.75" strokeDasharray="2 8" />
          </svg>
        </div>
      )}

      {theme === 'cyber-terminal' && (
        <div className="absolute inset-0 bg-[#070c18]">
          <div className="absolute inset-0 theme-backdrop-cybergrid" />
          <div className="absolute inset-0 theme-backdrop-cyberscan opacity-75" />
          <div className="absolute -top-40 left-1/4 w-[520px] h-[420px] rounded-full bg-cyan-500/15 blur-3xl" />
          <div className="absolute -bottom-44 -right-24 w-[540px] h-[540px] rounded-full bg-indigo-600/20 blur-3xl" />
          {/* 科技 HUD 边角刻度与电路曲线装饰 */}
          <svg
            className="absolute inset-0 w-full h-full text-cyan-400/25"
            preserveAspectRatio="none"
            viewBox="0 0 1200 800"
            fill="none"
          >
            <path d="M 32 64 L 32 28 L 88 28" stroke="currentColor" strokeWidth="1.5" />
            <path d="M 1168 64 L 1168 28 L 1112 28" stroke="currentColor" strokeWidth="1.5" />
            <path d="M 32 736 L 32 772 L 88 772" stroke="currentColor" strokeWidth="1.5" />
            <path d="M 1168 736 L 1168 772 L 1112 772" stroke="currentColor" strokeWidth="1.5" />
            <path
              d="M 960 0 L 960 95 L 1030 150 L 1200 150"
              stroke="currentColor"
              strokeWidth="1"
              strokeOpacity="0.6"
            />
            <circle cx="1030" cy="150" r="3" fill="currentColor" />
            <path
              d="M 0 650 L 130 650 L 185 710 L 185 800"
              stroke="currentColor"
              strokeWidth="1"
              strokeOpacity="0.5"
            />
            <circle cx="130" cy="650" r="3" fill="currentColor" />
          </svg>
        </div>
      )}

      {theme === 'warm-paper' && (
        <div className="absolute inset-0 bg-[#faf5ec]">
          <div className="absolute inset-0 theme-backdrop-papergrid" />
          <div className="absolute -top-36 -right-28 w-[480px] h-[480px] rounded-full bg-amber-200/40 blur-3xl" />
          <div className="absolute -bottom-44 -left-28 w-[460px] h-[460px] rounded-full bg-orange-200/35 blur-3xl" />
          {/* 手账植物曲线与装订虚线装饰 */}
          <div className="hidden md:block absolute top-0 bottom-0 left-[268px] border-l border-dashed border-amber-900/10" />
          <svg
            className="absolute bottom-0 right-0 w-[380px] h-[320px] text-amber-800/15"
            viewBox="0 0 380 320"
            fill="none"
          >
            <path
              d="M 360 320 C 330 240, 290 190, 220 150 C 260 140, 295 148, 325 170"
              stroke="currentColor"
              strokeWidth="1.5"
              strokeLinecap="round"
            />
            <path
              d="M 278 212 C 235 215, 200 205, 175 182 C 215 178, 250 188, 278 212 Z"
              stroke="currentColor"
              strokeWidth="1.2"
            />
            <path
              d="M 310 250 C 272 268, 232 266, 202 248 C 242 238, 278 238, 310 250 Z"
              stroke="currentColor"
              strokeWidth="1.2"
            />
            <circle cx="192" cy="128" r="38" stroke="currentColor" strokeWidth="1" strokeDasharray="4 5" />
          </svg>
        </div>
      )}

      {theme === 'aurora-glass' && (
        <div
          className="absolute inset-0"
          style={{
            background: 'linear-gradient(135deg, #f5f3ff 0%, #eff6ff 52%, #fdf2f8 100%)',
          }}
        >
          <div className="theme-aurora-blob absolute -top-36 -left-24 w-[560px] h-[560px] rounded-full bg-violet-300/40 blur-3xl" />
          <div
            className="theme-aurora-blob absolute top-1/4 -right-36 w-[520px] h-[520px] rounded-full bg-cyan-300/35 blur-3xl"
            style={{ animationDelay: '-5s' }}
          />
          <div
            className="theme-aurora-blob absolute -bottom-44 left-1/3 w-[540px] h-[480px] rounded-full bg-fuchsia-200/40 blur-3xl"
            style={{ animationDelay: '-10s' }}
          />
          <svg
            className="absolute inset-x-0 bottom-0 w-full h-56 text-white/60"
            preserveAspectRatio="none"
            viewBox="0 0 1440 240"
            fill="none"
          >
            <path
              d="M0 170 C 320 110, 620 220, 960 155 C 1200 110, 1340 135, 1440 155 L 1440 240 L 0 240 Z"
              fill="currentColor"
              fillOpacity="0.35"
            />
            <path
              d="M0 195 C 380 235, 760 120, 1140 185 C 1290 210, 1380 195, 1440 180"
              stroke="white"
              strokeOpacity="0.65"
              strokeWidth="1.5"
            />
          </svg>
        </div>
      )}
    </div>
  );
};

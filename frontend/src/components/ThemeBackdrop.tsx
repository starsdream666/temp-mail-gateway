import React from 'react';
import { useTheme } from '../context/ThemeContext';

/**
 * 随主题切换的全局背景纹理与空间配饰层。
 * 固定在最底层（z-0, pointer-events-none），为每套主题构建专属的几何、科技、手账或琉璃配饰。
 */
export const ThemeBackdrop: React.FC = () => {
  const { theme } = useTheme();

  return (
    <div
      aria-hidden="true"
      className="fixed inset-0 z-0 pointer-events-none overflow-hidden select-none"
    >
      {/* 1. 晴空工坊：蓝图点阵 + 星轨圆规弧线 + 十字准星锚点 + 纸飞机信使轨迹 */}
      {theme === 'indigo-atelier' && (
        <div className="absolute inset-0 bg-slate-50">
          <div className="absolute inset-0 theme-backdrop-dotgrid opacity-80" />
          <div className="absolute -top-44 -right-32 w-[540px] h-[540px] rounded-full bg-indigo-200/40 blur-3xl" />
          <div className="absolute -bottom-48 -left-36 w-[520px] h-[520px] rounded-full bg-sky-200/40 blur-3xl" />

          {/* 右上角精密圆规星轨与比例刻度 */}
          <svg
            className="absolute top-0 right-0 w-[480px] h-[480px] text-indigo-500/20"
            viewBox="0 0 480 480"
            fill="none"
          >
            <circle cx="390" cy="80" r="120" stroke="currentColor" strokeWidth="1" strokeDasharray="4 6" />
            <circle cx="390" cy="80" r="190" stroke="currentColor" strokeWidth="1" />
            <circle cx="390" cy="80" r="265" stroke="currentColor" strokeWidth="0.9" strokeDasharray="2 8" />
            <circle cx="390" cy="80" r="340" stroke="currentColor" strokeWidth="0.7" strokeOpacity="0.6" />
            <line x1="80" y1="80" x2="470" y2="80" stroke="currentColor" strokeWidth="0.8" strokeDasharray="3 5" />
            <line x1="390" y1="0" x2="390" y2="390" stroke="currentColor" strokeWidth="0.8" strokeDasharray="3 5" />
            {/* 轨道节点 */}
            <circle cx="200" cy="80" r="4" fill="#6366f1" fillOpacity="0.35" />
            <circle cx="200" cy="80" r="8" stroke="currentColor" strokeWidth="1" />
            <path d="M 252 212 L 260 220 M 260 212 L 252 220" stroke="currentColor" strokeWidth="1.4" />
            <polygon points="390,73 397,80 390,87 383,80" fill="#4f46e5" fillOpacity="0.28" />
          </svg>

          {/* 左下角信使折纸飞机与虚线航迹 */}
          <svg
            className="absolute bottom-4 left-6 w-[360px] h-[220px] text-indigo-500/20"
            viewBox="0 0 360 220"
            fill="none"
          >
            <path
              d="M 10 195 C 95 190, 155 120, 255 82"
              stroke="currentColor"
              strokeWidth="1.2"
              strokeDasharray="5 6"
            />
            <path
              d="M 258 80 L 292 68 L 272 98 L 268 86 Z"
              stroke="currentColor"
              strokeWidth="1.3"
              fill="#6366f1"
              fillOpacity="0.12"
            />
            {/* 蓝图十字配饰 */}
            <path d="M 48 64 H 60 M 54 58 V 70" stroke="currentColor" strokeWidth="1.2" />
            <path d="M 168 172 H 180 M 174 166 V 178" stroke="currentColor" strokeWidth="1.2" />
          </svg>
        </div>
      )}

      {/* 2. 赛博夜航：科技网格 + 顶部霓虹能量条 + HUD 四角遥测刻度 + 六边形蜂巢矩阵 + 电路脉冲 */}
      {theme === 'cyber-terminal' && (
        <div className="absolute inset-0 bg-[#070c18]">
          <div className="absolute inset-0 theme-backdrop-cybergrid" />
          <div className="absolute inset-0 theme-backdrop-cyberscan opacity-75" />
          <div className="absolute top-0 inset-x-0 h-[2px] bg-gradient-to-r from-transparent via-cyan-400/60 to-transparent shadow-[0_0_14px_rgba(34,211,238,0.65)]" />
          <div className="absolute -top-40 left-1/4 w-[520px] h-[420px] rounded-full bg-cyan-500/15 blur-3xl" />
          <div className="absolute -bottom-44 -right-24 w-[540px] h-[540px] rounded-full bg-indigo-600/20 blur-3xl" />

          {/* 全屏 HUD 准星、电路总线与蜂巢几何配饰 */}
          <svg
            className="absolute inset-0 w-full h-full text-cyan-400/30"
            preserveAspectRatio="none"
            viewBox="0 0 1440 900"
            fill="none"
          >
            {/* 四角双层战术框 */}
            <path d="M 26 78 L 26 24 L 96 24" stroke="currentColor" strokeWidth="1.6" />
            <path d="M 34 62 L 34 32 L 74 32" stroke="currentColor" strokeWidth="0.9" strokeOpacity="0.6" />
            <path d="M 1414 78 L 1414 24 L 1344 24" stroke="currentColor" strokeWidth="1.6" />
            <path d="M 1406 62 L 1406 32 L 1366 32" stroke="currentColor" strokeWidth="0.9" strokeOpacity="0.6" />
            <path d="M 26 822 L 26 876 L 96 876" stroke="currentColor" strokeWidth="1.6" />
            <path d="M 1414 822 L 1414 876 L 1344 876" stroke="currentColor" strokeWidth="1.6" />

            {/* 右侧垂直 HUD 标尺刻度 */}
            <g stroke="currentColor" strokeOpacity="0.45" strokeWidth="1">
              <line x1="1416" y1="220" x2="1402" y2="220" />
              <line x1="1416" y1="244" x2="1408" y2="244" />
              <line x1="1416" y1="268" x2="1408" y2="268" />
              <line x1="1416" y1="292" x2="1398" y2="292" />
              <line x1="1416" y1="316" x2="1408" y2="316" />
              <line x1="1416" y1="340" x2="1408" y2="340" />
              <line x1="1416" y1="364" x2="1402" y2="364" />
            </g>

            {/* 多路电路走线与发光焊盘 */}
            <path d="M 1080 0 L 1080 86 L 1146 142 L 1440 142" stroke="currentColor" strokeWidth="1.1" strokeOpacity="0.65" />
            <path d="M 1110 0 L 1110 72 L 1162 118 L 1320 118" stroke="#818cf8" strokeWidth="0.9" strokeOpacity="0.45" />
            <circle cx="1146" cy="142" r="3.5" fill="#22d3ee" />
            <circle cx="1320" cy="118" r="3" fill="#818cf8" />

            <path d="M 0 720 L 156 720 L 216 780 L 216 900" stroke="currentColor" strokeWidth="1.1" strokeOpacity="0.55" />
            <path d="M 0 744 L 142 744 L 190 792 L 340 792" stroke="#818cf8" strokeWidth="0.9" strokeOpacity="0.4" />
            <circle cx="156" cy="720" r="3.5" fill="#22d3ee" />
            <circle cx="340" cy="792" r="2.8" fill="#818cf8" />
          </svg>

          {/* 右下角战术六边形蜂巢群 */}
          <svg
            className="absolute bottom-8 right-10 w-[260px] h-[200px] text-cyan-400/20"
            viewBox="0 0 260 200"
            fill="none"
          >
            <polygon points="180,30 206,45 206,75 180,90 154,75 154,45" stroke="currentColor" strokeWidth="1.1" />
            <polygon points="222,55 248,70 248,100 222,115 196,100 196,70" stroke="currentColor" strokeWidth="1.1" />
            <polygon points="180,100 206,115 206,145 180,160 154,145 154,115" stroke="#818cf8" strokeOpacity="0.6" strokeWidth="1.1" />
            <polygon points="138,75 164,90 164,120 138,135 112,120 112,90" stroke="currentColor" strokeDasharray="3 3" strokeWidth="1" />
          </svg>
        </div>
      )}

      {/* 3. 暖杏手账：方格和纸 + 活页打孔装订环 + 邮戳印章 + 和纸胶带 + 植物枝叶 */}
      {theme === 'warm-paper' && (
        <div className="absolute inset-0 bg-[#faf5ec]">
          <div className="absolute inset-0 theme-backdrop-papergrid" />
          <div className="absolute -top-36 -right-28 w-[480px] h-[480px] rounded-full bg-amber-200/40 blur-3xl" />
          <div className="absolute -bottom-44 -left-28 w-[460px] h-[460px] rounded-full bg-orange-200/35 blur-3xl" />

          {/* 桌面右侧边缘：手账笔记本活页孔配饰 */}
          <div className="hidden lg:flex flex-col justify-center gap-7 absolute right-3 top-1/2 -translate-y-1/2 opacity-45">
            {Array.from({ length: 7 }).map((_, idx) => (
              <span
                key={idx}
                className="w-3 h-3 rounded-full bg-[#efe4d2] border border-amber-900/25 shadow-inner"
              />
            ))}
          </div>

          {/* 右上角复古邮政印章与航空邮戳波纹 */}
          <svg
            className="absolute top-6 right-10 w-[280px] h-[160px] text-amber-900/15"
            viewBox="0 0 280 160"
            fill="none"
          >
            <g transform="rotate(8 195 72)">
              <circle cx="195" cy="72" r="46" stroke="currentColor" strokeWidth="1.5" strokeDasharray="3 3" />
              <circle cx="195" cy="72" r="38" stroke="currentColor" strokeWidth="1.1" />
              <text
                x="195"
                y="68"
                textAnchor="middle"
                fill="currentColor"
                fontSize="9"
                fontFamily="monospace"
                letterSpacing="2"
              >
                MAIL GATEWAY
              </text>
              <line x1="166" y1="74" x2="224" y2="74" stroke="currentColor" strokeWidth="0.9" />
              <text
                x="195"
                y="86"
                textAnchor="middle"
                fill="currentColor"
                fontSize="8"
                fontFamily="monospace"
              >
                POST · STAMP
              </text>
            </g>
            {/* 邮戳波浪销票线 */}
            <path d="M 24 62 Q 42 54, 60 62 T 96 62 T 132 62" stroke="currentColor" strokeWidth="1.2" />
            <path d="M 24 74 Q 42 66, 60 74 T 96 74 T 132 74" stroke="currentColor" strokeWidth="1.2" />
            <path d="M 24 86 Q 42 78, 60 86 T 96 86 T 132 86" stroke="currentColor" strokeWidth="1.2" />
          </svg>

          {/* 右下角手绘感植物枝叶与火漆徽章外圈 */}
          <svg
            className="absolute bottom-0 right-0 w-[400px] h-[340px] text-amber-800/18"
            viewBox="0 0 400 340"
            fill="none"
          >
            <path
              d="M 380 340 C 345 250, 300 195, 225 152 C 270 142, 310 152, 345 178"
              stroke="currentColor"
              strokeWidth="1.6"
              strokeLinecap="round"
            />
            <path
              d="M 292 222 C 246 226, 208 214, 182 190 C 224 185, 262 196, 292 222 Z"
              stroke="currentColor"
              strokeWidth="1.25"
              fill="#ea580c"
              fillOpacity="0.05"
            />
            <path
              d="M 326 264 C 284 284, 242 282, 210 262 C 252 250, 290 250, 326 264 Z"
              stroke="currentColor"
              strokeWidth="1.25"
              fill="#d97706"
              fillOpacity="0.05"
            />
            <circle cx="198" cy="132" r="42" stroke="currentColor" strokeWidth="1.1" strokeDasharray="4 5" />
            <circle cx="198" cy="132" r="32" stroke="currentColor" strokeWidth="0.8" />
          </svg>
        </div>
      )}

      {/* 4. 极光琉璃：漫游极光球 + 水晶棱镜光环 + 四芒星钻闪烁 + 多层丝绸流波 */}
      {theme === 'aurora-glass' && (
        <div
          className="absolute inset-0"
          style={{
            background: 'linear-gradient(135deg, #f5f3ff 0%, #eff6ff 50%, #fdf2f8 100%)',
          }}
        >
          <div className="theme-aurora-blob absolute -top-36 -left-24 w-[560px] h-[560px] rounded-full bg-violet-300/42 blur-3xl" />
          <div
            className="theme-aurora-blob absolute top-1/4 -right-36 w-[520px] h-[520px] rounded-full bg-cyan-300/38 blur-3xl"
            style={{ animationDelay: '-5s' }}
          />
          <div
            className="theme-aurora-blob absolute -bottom-44 left-1/3 w-[540px] h-[480px] rounded-full bg-fuchsia-200/42 blur-3xl"
            style={{ animationDelay: '-10s' }}
          />

          {/* 右上角水晶棱镜折射环与四芒星钻 */}
          <svg
            className="absolute top-4 right-8 w-[420px] h-[360px]"
            viewBox="0 0 420 360"
            fill="none"
          >
            <defs>
              <linearGradient id="auroraRingGrad" x1="0%" y1="0%" x2="100%" y2="100%">
                <stop offset="0%" stopColor="#a855f7" stopOpacity="0.38" />
                <stop offset="50%" stopColor="#06b6d4" stopOpacity="0.32" />
                <stop offset="100%" stopColor="#ec4899" stopOpacity="0.28" />
              </linearGradient>
            </defs>
            <circle cx="300" cy="110" r="96" stroke="url(#auroraRingGrad)" strokeWidth="1.4" />
            <circle cx="300" cy="110" r="138" stroke="white" strokeOpacity="0.7" strokeWidth="1.2" />
            <ellipse
              cx="300"
              cy="110"
              rx="165"
              ry="66"
              transform="rotate(-24 300 110)"
              stroke="url(#auroraRingGrad)"
              strokeWidth="1.1"
            />
            {/* 四芒星钻光点 */}
            <path
              className="theme-sparkle-pulse"
              d="M 168 88 Q 168 102, 182 102 Q 168 102, 168 116 Q 168 102, 154 102 Q 168 102, 168 88 Z"
              fill="#8b5cf6"
              fillOpacity="0.45"
            />
            <path
              className="theme-sparkle-pulse"
              style={{ animationDelay: '-2.2s' }}
              d="M 358 214 Q 358 224, 368 224 Q 358 224, 358 234 Q 358 224, 348 224 Q 358 224, 358 214 Z"
              fill="#06b6d4"
              fillOpacity="0.5"
            />
            <path
              d="M 232 210 Q 232 216, 238 216 Q 232 216, 232 222 Q 232 216, 226 216 Q 232 216, 232 210 Z"
              fill="#ec4899"
              fillOpacity="0.4"
            />
          </svg>

          {/* 底部多层琉璃丝带流波 */}
          <svg
            className="absolute inset-x-0 bottom-0 w-full h-60 text-white/60"
            preserveAspectRatio="none"
            viewBox="0 0 1440 240"
            fill="none"
          >
            <path
              d="M0 170 C 320 105, 620 225, 960 150 C 1200 105, 1340 135, 1440 155 L 1440 240 L 0 240 Z"
              fill="currentColor"
              fillOpacity="0.4"
            />
            <path
              d="M0 195 C 380 235, 760 115, 1140 185 C 1290 210, 1380 195, 1440 180"
              stroke="white"
              strokeOpacity="0.8"
              strokeWidth="1.6"
            />
            <path
              d="M0 148 C 290 195, 680 92, 1080 156 C 1260 184, 1365 152, 1440 138"
              stroke="#a855f7"
              strokeOpacity="0.22"
              strokeWidth="1.2"
            />
          </svg>
        </div>
      )}
    </div>
  );
};

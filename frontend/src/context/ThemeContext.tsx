import React, { createContext, useCallback, useContext, useEffect, useState } from 'react';

export type ThemeId = 'indigo-atelier' | 'cyber-terminal' | 'warm-paper' | 'aurora-glass';
export type MotionSpeed = 'fast' | 'medium' | 'slow';

export interface ThemeDefinition {
  id: ThemeId;
  name: string;
  subtitle: string;
  description: string;
  decorationTag: string;
  isDark: boolean;
  swatches: {
    canvas: string;
    surface: string;
    accent: string;
    secondary: string;
  };
}

export interface MotionSpeedDefinition {
  id: MotionSpeed;
  label: string;
  badge: string;
  description: string;
  pageEnterMs: number;
  routeProgressMs: number;
  sidebarMs: number;
}

export const THEME_STORAGE_KEY = 'tmg_theme';
export const DEFAULT_THEME_ID: ThemeId = 'indigo-atelier';
export const MOTION_SPEED_STORAGE_KEY = 'tmg_motion_speed';
export const DEFAULT_MOTION_SPEED: MotionSpeed = 'fast';

export const THEME_DEFINITIONS: ThemeDefinition[] = [
  {
    id: 'indigo-atelier',
    name: '晴空工坊',
    subtitle: 'INDIGO ATELIER',
    description: '蓝图星轨与纸飞机航迹背景，搭配双侧微光铆点流光按钮。',
    decorationTag: '蓝图星轨 · 双铆流光键',
    isDark: false,
    swatches: {
      canvas: '#f8fafc',
      surface: '#ffffff',
      accent: '#4f46e5',
      secondary: '#38bdf8',
    },
  },
  {
    id: 'cyber-terminal',
    name: '赛博夜航',
    subtitle: 'CYBER TERMINAL',
    description: 'HUD 准星刻度与蜂巢电路背景，搭配霓虹准星框与激光槽按钮。',
    decorationTag: 'HUD 蜂巢 · 激光准星键',
    isDark: true,
    swatches: {
      canvas: '#070c18',
      surface: '#0f172a',
      accent: '#06b6d4',
      secondary: '#818cf8',
    },
  },
  {
    id: 'warm-paper',
    name: '暖杏手账',
    subtitle: 'WARM PAPER',
    description: '活页孔、复古邮戳与和纸胶带配饰，搭配四角铜铆车缝立体按键。',
    decorationTag: '邮戳胶带 · 铜铆车缝键',
    isDark: false,
    swatches: {
      canvas: '#faf5ec',
      surface: '#fffdf8',
      accent: '#c2410c',
      secondary: '#d97706',
    },
  },
  {
    id: 'aurora-glass',
    name: '极光琉璃',
    subtitle: 'AURORA GLASS',
    description: '棱镜星钻与极光丝带背景，搭配星芒微光与虹彩镜面琉璃按钮。',
    decorationTag: '棱镜星钻 · 星芒琉璃键',
    isDark: false,
    swatches: {
      canvas: '#f3f0ff',
      surface: 'rgba(255, 255, 255, 0.76)',
      accent: '#7c3aed',
      secondary: '#06b6d4',
    },
  },
];

export const MOTION_SPEED_DEFINITIONS: MotionSpeedDefinition[] = [
  {
    id: 'fast',
    label: '快',
    badge: '280ms',
    description: '默认速度，干脆利落',
    pageEnterMs: 280,
    routeProgressMs: 420,
    sidebarMs: 300,
  },
  {
    id: 'medium',
    label: '中',
    badge: '500ms',
    description: '柔和舒展，自然平稳',
    pageEnterMs: 500,
    routeProgressMs: 680,
    sidebarMs: 450,
  },
  {
    id: 'slow',
    label: '慢',
    badge: '820ms',
    description: '细腻慢放，层次鲜明',
    pageEnterMs: 820,
    routeProgressMs: 1050,
    sidebarMs: 650,
  },
];

const VALID_THEME_IDS = new Set<ThemeId>(THEME_DEFINITIONS.map((t) => t.id));
const VALID_SPEED_IDS = new Set<MotionSpeed>(MOTION_SPEED_DEFINITIONS.map((s) => s.id));

function isThemeId(value: string | null): value is ThemeId {
  return value !== null && VALID_THEME_IDS.has(value as ThemeId);
}

function isMotionSpeed(value: string | null): value is MotionSpeed {
  return value !== null && VALID_SPEED_IDS.has(value as MotionSpeed);
}

function readStoredTheme(): ThemeId {
  try {
    if (typeof window === 'undefined') return DEFAULT_THEME_ID;
    const saved = window.localStorage.getItem(THEME_STORAGE_KEY);
    return isThemeId(saved) ? saved : DEFAULT_THEME_ID;
  } catch {
    return DEFAULT_THEME_ID;
  }
}

function readStoredMotionSpeed(): MotionSpeed {
  try {
    if (typeof window === 'undefined') return DEFAULT_MOTION_SPEED;
    const saved = window.localStorage.getItem(MOTION_SPEED_STORAGE_KEY);
    return isMotionSpeed(saved) ? saved : DEFAULT_MOTION_SPEED;
  } catch {
    return DEFAULT_MOTION_SPEED;
  }
}

interface ThemeContextValue {
  theme: ThemeId;
  currentTheme: ThemeDefinition;
  themes: ThemeDefinition[];
  setTheme: (next: ThemeId) => void;
  motionSpeed: MotionSpeed;
  currentMotionSpeed: MotionSpeedDefinition;
  motionSpeeds: MotionSpeedDefinition[];
  setMotionSpeed: (next: MotionSpeed) => void;
}

const ThemeContext = createContext<ThemeContextValue | null>(null);

export const ThemeProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [theme, setThemeState] = useState<ThemeId>(readStoredTheme);
  const [motionSpeed, setMotionSpeedState] = useState<MotionSpeed>(readStoredMotionSpeed);

  useEffect(() => {
    if (typeof document !== 'undefined') {
      document.documentElement.dataset.theme = theme;
    }
    try {
      if (typeof window !== 'undefined') {
        window.localStorage.setItem(THEME_STORAGE_KEY, theme);
      }
    } catch {
      // 隐私模式或禁用本地存储时忽略持久化失败
    }
  }, [theme]);

  useEffect(() => {
    if (typeof document !== 'undefined') {
      document.documentElement.dataset.motionSpeed = motionSpeed;
    }
    try {
      if (typeof window !== 'undefined') {
        window.localStorage.setItem(MOTION_SPEED_STORAGE_KEY, motionSpeed);
      }
    } catch {
      // 隐私模式或禁用本地存储时忽略持久化失败
    }
  }, [motionSpeed]);

  const setTheme = useCallback((next: ThemeId) => {
    setThemeState(next);
  }, []);

  const setMotionSpeed = useCallback((next: MotionSpeed) => {
    setMotionSpeedState(next);
  }, []);

  const currentTheme = THEME_DEFINITIONS.find((t) => t.id === theme) ?? THEME_DEFINITIONS[0]!;
  const currentMotionSpeed =
    MOTION_SPEED_DEFINITIONS.find((s) => s.id === motionSpeed) ?? MOTION_SPEED_DEFINITIONS[0]!;

  return (
    <ThemeContext.Provider
      value={{
        theme,
        currentTheme,
        themes: THEME_DEFINITIONS,
        setTheme,
        motionSpeed,
        currentMotionSpeed,
        motionSpeeds: MOTION_SPEED_DEFINITIONS,
        setMotionSpeed,
      }}
    >
      {children}
    </ThemeContext.Provider>
  );
};

export const useTheme = (): ThemeContextValue => {
  const context = useContext(ThemeContext);
  if (!context) {
    throw new Error('useTheme must be used within a ThemeProvider');
  }
  return context;
};

import React, { useEffect, useMemo, useRef, useState } from 'react';
import { NavLink, Outlet, useLocation, useNavigate } from 'react-router-dom';
import {
  Server,
  KeyRound,
  Mail,
  Globe,
  Activity,
  BookOpen,
  Settings,
  LogOut,
  Menu,
  X,
  ChevronLeft,
} from 'lucide-react';
import { useToast } from './Toast';
import { useAuth } from '../context/AuthContext';
import { getServiceInfo } from '../api/client';
import { PageTransition, RouteProgressBar, TransitionDirection } from './PageTransition';
import { ThemeSwitcher } from './ThemeSwitcher';

const SIDEBAR_STORAGE_KEY = 'tmg_sidebar_collapsed';

const NAV_PATHS = ['/upstreams', '/domains', '/keys', '/mailboxes', '/health', '/api-docs', '/settings'];

interface SidebarTooltipState {
  label: string;
  description?: string;
  top: number;
  left: number;
}

function readSidebarCollapsed(): boolean {
  try {
    return typeof window !== 'undefined' && window.localStorage.getItem(SIDEBAR_STORAGE_KEY) === 'true';
  } catch {
    return false;
  }
}

function writeSidebarCollapsed(collapsed: boolean): void {
  try {
    if (typeof window !== 'undefined') {
      window.localStorage.setItem(SIDEBAR_STORAGE_KEY, String(collapsed));
    }
  } catch {
    // 隐私模式或禁用存储时忽略持久化失败
  }
}

export const Layout: React.FC = () => {
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  const [sidebarCollapsed, setSidebarCollapsed] = useState<boolean>(readSidebarCollapsed);
  const [tooltip, setTooltip] = useState<SidebarTooltipState | null>(null);
  const [loggingOut, setLoggingOut] = useState(false);
  const [version, setVersion] = useState<string | null>(null);
  const navigate = useNavigate();
  const location = useLocation();
  const toast = useToast();
  const { logoutUser } = useAuth();

  const prevPathRef = useRef<string>(location.pathname);
  const mainRef = useRef<HTMLElement | null>(null);

  const direction: TransitionDirection = useMemo(() => {
    const prevPath = prevPathRef.current;
    if (prevPath === location.pathname) return 'fade';
    const prevIndex = NAV_PATHS.indexOf(prevPath);
    const nextIndex = NAV_PATHS.indexOf(location.pathname);
    if (prevIndex !== -1 && nextIndex !== -1) {
      return nextIndex > prevIndex ? 'forward' : 'backward';
    }
    return 'fade';
  }, [location.pathname]);

  useEffect(() => {
    if (prevPathRef.current !== location.pathname) {
      prevPathRef.current = location.pathname;
      setTooltip(null);
      window.scrollTo({ top: 0, behavior: 'auto' });
      if (mainRef.current) {
        mainRef.current.scrollTop = 0;
      }
    }
  }, [location.pathname]);

  useEffect(() => {
    if (!mobileMenuOpen) return;
    const handleEsc = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setMobileMenuOpen(false);
      }
    };
    window.addEventListener('keydown', handleEsc);
    return () => window.removeEventListener('keydown', handleEsc);
  }, [mobileMenuOpen]);

  useEffect(() => {
    let active = true;
    getServiceInfo()
      .then((info) => {
        if (active) setVersion(info.version);
      })
      .catch(() => {
        // 版本信息不影响管理操作；请求失败时保持隐藏。
      });
    return () => {
      active = false;
    };
  }, []);

  const toggleSidebar = () => {
    setTooltip(null);
    setSidebarCollapsed((prev) => {
      const next = !prev;
      writeSidebarCollapsed(next);
      return next;
    });
  };

  const showTooltip = (el: HTMLElement, label: string, description?: string) => {
    if (!sidebarCollapsed) return;
    if (typeof window !== 'undefined' && !window.matchMedia('(min-width: 768px)').matches) {
      return;
    }
    const rect = el.getBoundingClientRect();
    const asideRight = el.closest('aside')?.getBoundingClientRect().right;
    setTooltip({
      label,
      description,
      top: rect.top + rect.height / 2,
      left: (asideRight ?? rect.right) + 10,
    });
  };

  const hideTooltip = () => {
    setTooltip(null);
  };

  const handleLogout = async () => {
    try {
      setLoggingOut(true);
      // logoutUser 内部先清后端 cookie，再把前端 isAuthenticated 置 false——
      // 直接用裸 logout() 会让前端状态保持已登录，退出后闪一下受保护页并多打一次 401
      await logoutUser();
      toast.success('已安全退出管理后台');
    } catch {
      // 即使后端返回非 204，前端也清理会话（logoutUser 的 finally 会置 false）
    } finally {
      setLoggingOut(false);
      navigate('/login', { replace: true });
    }
  };

  const navItems = [
    {
      to: '/upstreams',
      label: '上游管理',
      icon: <Server className="w-5 h-5" />,
      description: '配置多上游与域名同步',
    },
    {
      to: '/domains',
      label: '域名总览',
      icon: <Globe className="w-5 h-5" />,
      description: '全渠道域名预览与调用开关',
    },
    {
      to: '/keys',
      label: 'API Keys',
      icon: <KeyRound className="w-5 h-5" />,
      description: '网关调用密钥签发与吊销',
    },
    {
      to: '/mailboxes',
      label: '邮箱概览',
      icon: <Mail className="w-5 h-5" />,
      description: '统一查看全网关临时邮箱',
    },
    {
      to: '/health',
      label: '状态监控',
      icon: <Activity className="w-5 h-5" />,
      description: '渠道存活与域名变化监控',
    },
    {
      to: '/api-docs',
      label: 'API 调用',
      icon: <BookOpen className="w-5 h-5" />,
      description: '统一 API 说明与调用示例',
    },
    {
      to: '/settings',
      label: '全局设置',
      icon: <Settings className="w-5 h-5" />,
      description: '登录密码、监控与默认调用限制',
    },
  ];

  return (
    <div className="relative z-10 min-h-screen flex flex-col md:flex-row">
      {/* 移动端顶部导航栏 */}
      <div className="md:hidden bg-white border-b border-slate-200 px-4 py-3 flex items-center justify-between sticky top-0 z-30 shadow-sm">
        <div className="flex items-center gap-2.5">
          <div className="w-8 h-8 rounded-lg theme-brand-badge flex items-center justify-center text-white font-bold">
            M
          </div>
          <div>
            <h1 className="font-bold text-slate-900 leading-none text-base">Temp Mail Gateway</h1>
            <p className="text-[11px] text-slate-500 mt-0.5 font-medium">
              管理控制台
              {version && (
                <span className="ml-2 font-mono text-slate-600" title="当前版本">
                  v{version}
                </span>
              )}
            </p>
          </div>
        </div>
        <div className="flex items-center gap-1">
          <ThemeSwitcher variant="icon" />
          <button
            type="button"
            onClick={() => setMobileMenuOpen(!mobileMenuOpen)}
            className="p-2 rounded-lg text-slate-600 hover:bg-slate-100 transition-colors"
            aria-label="打开菜单"
          >
            {mobileMenuOpen ? <X className="w-6 h-6" /> : <Menu className="w-6 h-6" />}
          </button>
        </div>
      </div>

      {/* 移动端侧边抽屉遮罩 */}
      <div
        aria-hidden="true"
        className={`md:hidden fixed inset-0 z-40 bg-slate-900/40 backdrop-blur-sm transition-opacity duration-200 ${
          mobileMenuOpen ? 'opacity-100 pointer-events-auto' : 'opacity-0 pointer-events-none'
        }`}
        onClick={() => setMobileMenuOpen(false)}
      />

      {/* 侧边栏 */}
      <aside
        className={`fixed md:sticky top-0 bottom-0 left-0 z-40 w-64 ${
          sidebarCollapsed ? 'md:w-[76px]' : 'md:w-64'
        } bg-white border-r border-slate-200 flex flex-col justify-between sidebar-width-transition md:translate-x-0 ${
          mobileMenuOpen ? 'translate-x-0 shadow-2xl md:shadow-none' : '-translate-x-full md:translate-x-0'
        } h-screen`}
      >
        {/* 桌面端折叠/展开悬浮切换按钮 */}
        <button
          type="button"
          onClick={toggleSidebar}
          aria-expanded={!sidebarCollapsed}
          aria-label={sidebarCollapsed ? '展开侧边栏' : '折叠侧边栏'}
          title={sidebarCollapsed ? '展开侧边栏' : '折叠侧边栏'}
          className="hidden md:flex items-center justify-center absolute -right-3.5 top-6 z-20 w-7 h-7 rounded-full bg-white border border-slate-200 text-slate-500 shadow-sm hover:text-indigo-600 hover:border-indigo-300 hover:shadow-md focus:outline-none focus:ring-2 focus:ring-indigo-500/30 transition-all duration-200"
        >
          <ChevronLeft
            className={`w-4 h-4 transition-transform duration-300 ease-[cubic-bezier(0.22,1,0.36,1)] ${
              sidebarCollapsed ? 'rotate-180' : 'rotate-0'
            }`}
          />
        </button>

        <div
          onScroll={hideTooltip}
          className="flex flex-col flex-1 min-h-0 overflow-y-auto overflow-x-hidden"
        >
          {/* 桌面端品牌 Header */}
          <div
            onMouseEnter={(e) => showTooltip(e.currentTarget, 'Temp Mail Gateway', version ? `管理控制台 · v${version}` : '管理控制台')}
            onMouseLeave={hideTooltip}
            className="hidden md:flex items-center h-[76px] px-5 border-b border-slate-100 shrink-0"
          >
            <div className="w-9 h-9 shrink-0 rounded-xl theme-brand-badge flex items-center justify-center text-white font-bold transition-transform duration-200 hover:scale-105">
              <Mail className="w-5 h-5" />
            </div>
            <div
              className={`overflow-hidden whitespace-nowrap transition-[opacity,max-width,margin] duration-200 ${
                sidebarCollapsed
                  ? 'md:opacity-0 md:max-w-0 md:ml-0 md:pointer-events-none'
                  : 'opacity-100 max-w-[160px] ml-3'
              }`}
            >
              <h1 className="font-bold text-slate-900 tracking-tight text-base leading-tight">Temp Mail</h1>
              <p className="text-xs theme-brand-subtitle font-semibold tracking-wide">GATEWAY ADMIN</p>
            </div>
          </div>

          {/* 移动端关闭按钮 */}
          <div className="p-4 flex items-center justify-between border-b border-slate-100 md:hidden shrink-0">
            <span className="text-xs font-semibold text-slate-400 uppercase tracking-wider">控制台导航</span>
            <button
              type="button"
              onClick={() => setMobileMenuOpen(false)}
              className="p-1 rounded-md text-slate-400 hover:text-slate-600"
              aria-label="关闭菜单"
            >
              <X className="w-5 h-5" />
            </button>
          </div>

          {/* 导航链接 */}
          <nav className="px-3 py-4 space-y-1.5 flex-1">
            <div className="relative h-5 mb-2 flex items-center">
              <span
                aria-hidden="true"
                className={`hidden md:block absolute left-1/2 -translate-x-1/2 w-5 h-px bg-slate-200 transition-opacity duration-200 ${
                  sidebarCollapsed ? 'opacity-100' : 'opacity-0 pointer-events-none'
                }`}
              />
              <span
                className={`text-[11px] font-bold text-slate-400 uppercase tracking-wider px-4 whitespace-nowrap overflow-hidden transition-[opacity,max-width] duration-200 ${
                  sidebarCollapsed ? 'md:opacity-0 md:max-w-0 md:pointer-events-none' : 'opacity-100 max-w-[140px]'
                }`}
              >
                主要功能
              </span>
            </div>

            {navItems.map((item) => (
              <NavLink
                key={item.to}
                to={item.to}
                aria-label={item.label}
                onClick={() => setMobileMenuOpen(false)}
                onMouseEnter={(e) => showTooltip(e.currentTarget, item.label, item.description)}
                onMouseLeave={hideTooltip}
                onFocus={(e) => showTooltip(e.currentTarget, item.label, item.description)}
                onBlur={hideTooltip}
                className={({ isActive }) =>
                  `relative flex items-center px-4 py-2.5 rounded-xl font-medium text-sm transition-all duration-150 group ${
                    isActive
                      ? 'bg-indigo-50 text-indigo-600 font-semibold shadow-sm'
                      : 'text-slate-600 hover:text-slate-900 hover:bg-slate-50'
                  }`
                }
              >
                {({ isActive }) => (
                  <>
                    <div
                      className={`shrink-0 transition-all duration-150 ${
                        isActive
                          ? 'text-indigo-600'
                          : 'text-slate-400 group-hover:text-slate-600 group-hover:scale-105'
                      }`}
                    >
                      {item.icon}
                    </div>
                    <span
                      className={`overflow-hidden whitespace-nowrap transition-[opacity,max-width,margin] duration-200 ${
                        sidebarCollapsed
                          ? 'md:opacity-0 md:max-w-0 md:ml-0 md:pointer-events-none'
                          : 'opacity-100 max-w-[140px] ml-3'
                      }`}
                    >
                      {item.label}
                    </span>
                  </>
                )}
              </NavLink>
            ))}
          </nav>
        </div>

        {/* 侧边栏底部：当前版本、登录状态与退出 */}
        <div className="shrink-0 p-3 border-t border-slate-100 bg-slate-50/50">
          {version && (
            <div
              className={`px-2 flex items-center justify-between text-[11px] text-slate-500 overflow-hidden whitespace-nowrap transition-[opacity,max-height,margin] duration-200 ${
                sidebarCollapsed
                  ? 'md:max-h-0 md:opacity-0 md:mb-0 md:pointer-events-none'
                  : 'max-h-8 opacity-100 mb-3'
              }`}
            >
              <span>当前版本</span>
              <span className="px-2 py-0.5 rounded bg-white border border-slate-200 font-mono text-slate-700">
                v{version}
              </span>
            </div>
          )}

          <div
            onMouseEnter={(e) =>
              showTooltip(
                e.currentTarget,
                '管理员已连接',
                version ? `HttpOnly 会话 · v${version}` : 'HttpOnly 安全会话',
              )
            }
            onMouseLeave={hideTooltip}
            className={`flex items-center mb-3 transition-all duration-200 ${
              sidebarCollapsed ? 'md:justify-center md:px-0 justify-between px-2' : 'justify-between px-2'
            }`}
          >
            <div className="flex items-center">
              <span className="relative flex h-2.5 w-2.5 shrink-0">
                <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-75" />
                <span className="relative inline-flex rounded-full h-2.5 w-2.5 bg-emerald-500" />
              </span>
              <span
                className={`text-xs font-medium text-slate-700 whitespace-nowrap overflow-hidden transition-[opacity,max-width,margin] duration-200 ${
                  sidebarCollapsed ? 'md:opacity-0 md:max-w-0 md:ml-0' : 'opacity-100 max-w-[120px] ml-2'
                }`}
              >
                管理员已连接
              </span>
            </div>
            <div
              className={`text-[11px] py-0.5 bg-slate-200/70 text-slate-600 rounded font-mono whitespace-nowrap overflow-hidden transition-[opacity,max-width,padding] duration-200 ${
                sidebarCollapsed ? 'md:opacity-0 md:max-w-0 md:px-0' : 'opacity-100 max-w-[80px] px-2'
              }`}
            >
              HttpOnly
            </div>
          </div>
          <ThemeSwitcher
            variant="sidebar"
            collapsed={sidebarCollapsed}
            onTooltipEnter={showTooltip}
            onTooltipLeave={hideTooltip}
          />

          <button
            type="button"
            disabled={loggingOut}
            onClick={handleLogout}
            aria-label={loggingOut ? '正在退出' : '退出登录'}
            onMouseEnter={(e) => showTooltip(e.currentTarget, loggingOut ? '正在退出...' : '退出登录')}
            onMouseLeave={hideTooltip}
            onFocus={(e) => showTooltip(e.currentTarget, loggingOut ? '正在退出...' : '退出登录')}
            onBlur={hideTooltip}
            className="w-full flex items-center justify-center px-3 py-2 text-sm font-medium text-slate-600 hover:text-rose-600 hover:bg-rose-50 rounded-lg border border-slate-200/80 hover:border-rose-200 transition-colors disabled:opacity-50"
          >
            <LogOut className="w-4 h-4 shrink-0" />
            <span
              className={`whitespace-nowrap overflow-hidden transition-[opacity,max-width,margin] duration-200 ${
                sidebarCollapsed ? 'md:opacity-0 md:max-w-0 md:ml-0' : 'opacity-100 max-w-[100px] ml-2'
              }`}
            >
              {loggingOut ? '正在退出...' : '退出登录'}
            </span>
          </button>
        </div>
      </aside>

      {/* 桌面端侧边栏折叠态悬浮提示 */}
      {sidebarCollapsed && tooltip && (
        <div
          role="tooltip"
          style={{ top: `${tooltip.top}px`, left: `${tooltip.left}px` }}
          className="hidden md:block fixed z-50 pointer-events-none sidebar-tooltip-in"
        >
          <div className="relative bg-slate-900/95 text-white px-3 py-2 rounded-xl shadow-xl border border-slate-700/60 backdrop-blur-sm max-w-[220px]">
            <span
              aria-hidden="true"
              className="absolute -left-1 top-1/2 -translate-y-1/2 w-2 h-2 rotate-45 bg-slate-900/95 border-l border-b border-slate-700/60"
            />
            <div className="text-xs font-semibold leading-tight whitespace-nowrap">{tooltip.label}</div>
            {tooltip.description && (
              <div className="text-[11px] text-slate-300 mt-0.5 leading-snug">{tooltip.description}</div>
            )}
          </div>
        </div>
      )}

      {/* 右侧主内容区 */}
      <main ref={mainRef} className="flex-1 flex flex-col min-w-0 min-h-screen overflow-y-auto">
        <RouteProgressBar routeKey={location.pathname} />
        <div className="flex-1 p-4 sm:p-6 lg:p-8 max-w-7xl w-full mx-auto">
          <PageTransition key={location.pathname} direction={direction}>
            <Outlet />
          </PageTransition>
        </div>
      </main>
    </div>
  );
};

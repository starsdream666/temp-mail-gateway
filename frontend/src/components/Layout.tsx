import React, { useEffect, useState } from 'react';
import { NavLink, Outlet, useNavigate } from 'react-router-dom';
import { Server, KeyRound, Mail, Globe, Activity, BookOpen, Settings, LogOut, Menu, X } from 'lucide-react';
import { useToast } from './Toast';
import { useAuth } from '../context/AuthContext';
import { getServiceInfo } from '../api/client';

export const Layout: React.FC = () => {
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  const [loggingOut, setLoggingOut] = useState(false);
  const [version, setVersion] = useState<string | null>(null);
  const navigate = useNavigate();
  const toast = useToast();
  const { logoutUser } = useAuth();

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
    { to: '/settings', label: '全局设置', icon: <Settings className="w-5 h-5" />, description: '登录密码、监控与默认调用限制' },
  ];

  return (
    <div className="min-h-screen bg-slate-50 flex flex-col md:flex-row">
      {/* 移动端顶部导航栏 */}
      <div className="md:hidden bg-white border-b border-slate-200 px-4 py-3 flex items-center justify-between sticky top-0 z-30 shadow-sm">
        <div className="flex items-center gap-2.5">
          <div className="w-8 h-8 rounded-lg bg-indigo-600 flex items-center justify-center text-white font-bold shadow-md shadow-indigo-200">
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
        <button
          type="button"
          onClick={() => setMobileMenuOpen(!mobileMenuOpen)}
          className="p-2 rounded-lg text-slate-600 hover:bg-slate-100 transition-colors"
          aria-label="打开菜单"
        >
          {mobileMenuOpen ? <X className="w-6 h-6" /> : <Menu className="w-6 h-6" />}
        </button>
      </div>

      {/* 移动端侧边抽屉遮罩 */}
      {mobileMenuOpen && (
        <div
          className="md:hidden fixed inset-0 z-40 bg-slate-900/40 backdrop-blur-sm"
          onClick={() => setMobileMenuOpen(false)}
        />
      )}

      {/* 侧边栏 */}
      <aside
        className={`fixed md:sticky top-0 bottom-0 left-0 z-40 w-64 bg-white border-r border-slate-200 flex flex-col justify-between transition-transform duration-200 ease-in-out md:translate-x-0 ${
          mobileMenuOpen ? 'translate-x-0' : '-translate-x-full md:translate-x-0'
        } h-screen`}
      >
        <div className="flex flex-col flex-1 overflow-y-auto">
          {/* 桌面端品牌 Header */}
          <div className="p-6 border-b border-slate-100 hidden md:block">
            <div className="flex items-center gap-3">
              <div className="w-9 h-9 rounded-xl bg-indigo-600 flex items-center justify-center text-white font-bold shadow-lg shadow-indigo-100">
                <Mail className="w-5 h-5" />
              </div>
              <div>
                <h1 className="font-bold text-slate-900 tracking-tight text-base">Temp Mail</h1>
                <p className="text-xs text-indigo-600 font-semibold tracking-wide">GATEWAY ADMIN</p>
              </div>
            </div>
          </div>

          {/* 移动端关闭按钮 */}
          <div className="p-4 flex items-center justify-between border-b border-slate-100 md:hidden">
            <span className="text-xs font-semibold text-slate-400 uppercase tracking-wider">控制台导航</span>
            <button
              type="button"
              onClick={() => setMobileMenuOpen(false)}
              className="p-1 rounded-md text-slate-400 hover:text-slate-600"
            >
              <X className="w-5 h-5" />
            </button>
          </div>

          {/* 导航链接 */}
          <nav className="p-4 space-y-1.5 flex-1">
            <div className="text-[11px] font-bold text-slate-400 uppercase tracking-wider px-3 mb-2">主要功能</div>
            {navItems.map((item) => (
              <NavLink
                key={item.to}
                to={item.to}
                onClick={() => setMobileMenuOpen(false)}
                className={({ isActive }) =>
                  `flex items-center gap-3 px-3.5 py-2.5 rounded-xl font-medium text-sm transition-all duration-150 group ${
                    isActive
                      ? 'bg-indigo-50 text-indigo-600 font-semibold shadow-sm'
                      : 'text-slate-600 hover:text-slate-900 hover:bg-slate-50'
                  }`
                }
              >
                {({ isActive }) => (
                  <>
                    <div
                      className={`transition-colors ${
                        isActive ? 'text-indigo-600' : 'text-slate-400 group-hover:text-slate-600'
                      }`}
                    >
                      {item.icon}
                    </div>
                    <div className="flex-1">
                      <div>{item.label}</div>
                    </div>
                  </>
                )}
              </NavLink>
            ))}
          </nav>
        </div>

        {/* 侧边栏底部：当前版本、登录状态与退出 */}
        <div className="shrink-0 p-4 border-t border-slate-100 bg-slate-50/50">
          {version && (
            <div className="mb-3 px-2 flex items-center justify-between text-[11px] text-slate-500">
              <span>当前版本</span>
              <span className="px-2 py-0.5 rounded bg-white border border-slate-200 font-mono text-slate-700">
                v{version}
              </span>
            </div>
          )}
          <div className="flex items-center justify-between mb-3 px-2">
            <div className="flex items-center gap-2">
              <span className="relative flex h-2.5 w-2.5">
                <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-75" />
                <span className="relative inline-flex rounded-full h-2.5 w-2.5 bg-emerald-500" />
              </span>
              <span className="text-xs font-medium text-slate-700">管理员已连接</span>
            </div>
            <div className="text-[11px] px-2 py-0.5 bg-slate-200/70 text-slate-600 rounded font-mono">HttpOnly</div>
          </div>
          <button
            type="button"
            disabled={loggingOut}
            onClick={handleLogout}
            className="w-full flex items-center justify-center gap-2 px-3 py-2 text-sm font-medium text-slate-600 hover:text-rose-600 hover:bg-rose-50 rounded-lg border border-slate-200/80 hover:border-rose-200 transition-colors disabled:opacity-50"
          >
            <LogOut className="w-4 h-4" />
            <span>{loggingOut ? '正在退出...' : '退出登录'}</span>
          </button>
        </div>
      </aside>

      {/* 右侧主内容区 */}
      <main className="flex-1 flex flex-col min-w-0 min-h-screen overflow-y-auto">
        <div className="flex-1 p-4 sm:p-6 lg:p-8 max-w-7xl w-full mx-auto">
          <Outlet />
        </div>
      </main>
    </div>
  );
};

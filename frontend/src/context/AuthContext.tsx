import React, { createContext, useContext, useState, useEffect, useCallback } from 'react';
import { checkMe, login, logout, setUnauthorizedListener } from '../api/client';

interface AuthContextValue {
  isAuthenticated: boolean;
  isChecking: boolean;
  loginUser: (password: string) => Promise<void>;
  logoutUser: () => Promise<void>;
  checkSession: () => Promise<boolean>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export const AuthProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [isAuthenticated, setIsAuthenticated] = useState<boolean>(false);
  const [isChecking, setIsChecking] = useState<boolean>(true);

  const checkSession = useCallback(async (): Promise<boolean> => {
    try {
      const res = await checkMe();
      const authed = !!res?.authenticated;
      setIsAuthenticated(authed);
      return authed;
    } catch {
      setIsAuthenticated(false);
      return false;
    } finally {
      setIsChecking(false);
    }
  }, []);

  useEffect(() => {
    // 启动时检查当前会话
    checkSession();

    // 注册全局 401 拦截
    setUnauthorizedListener(() => {
      setIsAuthenticated(false);
    });

    return () => {
      setUnauthorizedListener(null);
    };
  }, [checkSession]);

  const loginUser = async (password: string) => {
    try {
      await login(password);
      setIsAuthenticated(true);
    } catch (err) {
      setIsAuthenticated(false);
      throw err;
    }
  };

  const logoutUser = async () => {
    try {
      await logout();
    } finally {
      setIsAuthenticated(false);
    }
  };

  return (
    <AuthContext.Provider
      value={{
        isAuthenticated,
        isChecking,
        loginUser,
        logoutUser,
        checkSession,
      }}
    >
      {children}
    </AuthContext.Provider>
  );
};

export const useAuth = (): AuthContextValue => {
  const context = useContext(AuthContext);
  if (!context) {
    throw new Error('useAuth must be used within an AuthProvider');
  }
  return context;
};

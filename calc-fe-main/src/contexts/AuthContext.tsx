import React, { createContext, useContext, useState, useEffect, ReactNode } from 'react';
import axios from 'axios';

const API_URL = (import.meta as unknown as { env?: { VITE_API_URL?: string } }).env?.VITE_API_URL || 'http://localhost:8900';

// Add axios interceptor to include JWT token in requests
axios.interceptors.request.use(
  (config) => {
    const token = localStorage.getItem('token');
    if (token) {
      config.headers.Authorization = `Bearer ${token}`;
    }
    return config;
  },
  (error) => {
    return Promise.reject(error);
  }
);

interface User {
  id: string;
  username: string;
  email: string;
}

interface AuthContextType {
  user: User | null;
  token: string | null;
  login: (email: string, password: string) => Promise<void>;
  register: (username: string, email: string, password: string) => Promise<void>;
  logout: () => void;
  isAuthenticated: boolean;
  loading: boolean;
}

const AuthContext = createContext<AuthContextType | undefined>(undefined);

export const useAuth = () => {
  const context = useContext(AuthContext);
  if (context === undefined) {
    throw new Error('useAuth must be used within an AuthProvider');
  }
  return context;
};

interface AuthProviderProps {
  children: ReactNode;
}

export const AuthProvider: React.FC<AuthProviderProps> = ({ children }) => {
  const [user, setUser] = useState<User | null>(null);
  const [token, setToken] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const storedToken = localStorage.getItem('token');
    if (storedToken) {
      setToken(storedToken);
      // You could validate the token here by making a request to /history or a dedicated /me endpoint
      // For now, we'll assume it's valid
      setUser({ id: 'temp', username: 'User', email: 'user@example.com' }); // This should be fetched from backend
    }
    setLoading(false);
  }, []);

  const login = async (email: string, password: string) => {
    const response = await axios.post(`${API_URL}/login`, { email, password });
    const { access_token, username } = response.data;
    localStorage.setItem('token', access_token);
    setToken(access_token);
    setUser({ id: 'temp', username, email });
  };

  const register = async (username: string, email: string, password: string) => {
    await axios.post(`${API_URL}/register`, { username, email, password });
  };

  const logout = () => {
    localStorage.removeItem('token');
    setToken(null);
    setUser(null);
  };

  const value: AuthContextType = {
    user,
    token,
    login,
    register,
    logout,
    isAuthenticated: !!token,
    loading,
  };

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
};

import React, { useState } from 'react';
import { motion } from 'framer-motion';
import { TextInput, PasswordInput, Button, Paper, Title, Text, Anchor, Alert } from '@mantine/core';
import { Link, useNavigate } from 'react-router-dom';
import { LogIn, AlertCircle } from 'lucide-react';
import { useAuth } from '@/contexts/AuthContext';

const Login: React.FC = () => {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const navigate = useNavigate();
  const { login } = useAuth();

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    setError('');

    try {
      await login(email, password);
      navigate('/');
    } catch (err: unknown) {
      const error = err as { response?: { data?: { message?: string } } };
      setError(error.response?.data?.message || 'Login failed');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen flex items-center justify-center bg-gradient-to-br from-blue-50 via-indigo-50 to-purple-50 dark:from-gray-900 dark:via-indigo-900 dark:to-purple-900 p-4 relative overflow-hidden">
      {/* Animated Background Elements */}
      <div className="absolute inset-0 overflow-hidden">
        <motion.div
          className="absolute top-20 left-10 w-32 h-32 bg-gradient-to-br from-indigo-200 to-purple-200 dark:from-indigo-800 dark:to-purple-800 rounded-full opacity-20"
          animate={{
            scale: [1, 1.2, 1],
            rotate: [0, 180, 360],
          }}
          transition={{
            duration: 8,
            repeat: Infinity,
            ease: "easeInOut"
          }}
        />
        <motion.div
          className="absolute bottom-20 right-10 w-24 h-24 bg-gradient-to-br from-purple-200 to-pink-200 dark:from-purple-800 dark:to-pink-800 rounded-full opacity-15"
          animate={{
            scale: [1.2, 1, 1.2],
            rotate: [360, 180, 0],
          }}
          transition={{
            duration: 10,
            repeat: Infinity,
            ease: "easeInOut"
          }}
        />
        <motion.div
          className="absolute top-1/2 left-1/4 w-16 h-16 bg-gradient-to-br from-blue-200 to-indigo-200 dark:from-blue-800 dark:to-indigo-800 rounded-full opacity-25"
          animate={{
            y: [0, -20, 0],
            x: [0, 10, 0],
          }}
          transition={{
            duration: 6,
            repeat: Infinity,
            ease: "easeInOut"
          }}
        />
        <motion.div
          className="absolute bottom-1/3 right-1/4 w-20 h-20 bg-gradient-to-br from-cyan-200 to-blue-200 dark:from-cyan-800 dark:to-blue-800 rounded-full opacity-20"
          animate={{
            scale: [1, 1.1, 1],
            rotate: [0, -90, -180, -270, -360],
          }}
          transition={{
            duration: 12,
            repeat: Infinity,
            ease: "linear"
          }}
        />
        <motion.div
          className="absolute top-1/3 right-1/2 w-12 h-12 bg-gradient-to-br from-violet-200 to-purple-200 dark:from-violet-800 dark:to-purple-800 rounded-full opacity-18"
          animate={{
            scale: [1, 1.3, 1],
            y: [0, 15, 0],
          }}
          transition={{
            duration: 7,
            repeat: Infinity,
            ease: "easeInOut"
          }}
        />
        <motion.div
          className="absolute bottom-1/4 left-1/2 w-14 h-14 bg-gradient-to-br from-pink-200 to-rose-200 dark:from-pink-800 dark:to-rose-800 rounded-full opacity-22"
          animate={{
            scale: [1, 0.8, 1],
            rotate: [0, 120, 240, 360],
          }}
          transition={{
            duration: 9,
            repeat: Infinity,
            ease: "easeInOut"
          }}
        />
      </div>

      {/* Classic Background Image */}
      <div
        className="absolute inset-0 bg-cover bg-center opacity-10"
        style={{
          backgroundImage: `url("data:image/svg+xml,%3Csvg width='60' height='60' viewBox='0 0 60 60' xmlns='http://www.w3.org/2000/svg'%3E%3Cg fill='none' fill-rule='evenodd'%3E%3Cg fill='%239C92AC' fill-opacity='0.1'%3E%3Ccircle cx='30' cy='30' r='2'/%3E%3C/g%3E%3C/g%3E%3C/svg%3E")`,
        }}
      />

      <motion.div
        initial={{ opacity: 0, y: 20 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.5 }}
        className="w-full max-w-md relative z-10"
      >
        <Paper
          shadow="xl"
          radius="lg"
          p="xl"
          className="bg-white/80 dark:bg-gray-800/80 backdrop-blur-sm"
        >
          <motion.div
            initial={{ scale: 0.9 }}
            animate={{ scale: 1 }}
            transition={{ delay: 0.2, duration: 0.3 }}
            className="text-center mb-8"
          >
            <div className="inline-flex items-center justify-center w-16 h-16 bg-indigo-100 dark:bg-indigo-900 rounded-full mb-4">
              <LogIn className="w-8 h-8 text-indigo-600 dark:text-indigo-400" />
            </div>
            <Title order={2} className="text-gray-900 dark:text-white mb-2">
              Welcome Back
            </Title>
            <Text className="text-gray-600 dark:text-gray-300">
              Sign in to your Neuron account
            </Text>
          </motion.div>

          {error && (
            <motion.div
              initial={{ opacity: 0, scale: 0.95 }}
              animate={{ opacity: 1, scale: 1 }}
              className="mb-6"
            >
              <Alert icon={<AlertCircle size={16} />} color="red" variant="light">
                {error}
              </Alert>
            </motion.div>
          )}

          <motion.form
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            transition={{ delay: 0.3, duration: 0.4 }}
            onSubmit={handleSubmit}
            className="space-y-6"
          >
            <TextInput
              label="Email"
              placeholder="Enter your email"
              value={email}
              onChange={(e) => setEmail(e.currentTarget.value)}
              required
              size="md"
              classNames={{
                input: 'bg-white dark:bg-gray-700 border-gray-300 dark:border-gray-600 text-gray-900 dark:text-white placeholder-gray-500 dark:placeholder-gray-400',
                label: 'text-gray-700 dark:text-gray-300 font-medium',
              }}
            />

            <PasswordInput
              label="Password"
              placeholder="Enter your password"
              value={password}
              onChange={(e) => setPassword(e.currentTarget.value)}
              required
              size="md"
              classNames={{
                input: 'bg-white dark:bg-gray-700 border-gray-300 dark:border-gray-600 text-gray-900 dark:text-white placeholder-gray-500 dark:placeholder-gray-400',
                label: 'text-gray-700 dark:text-gray-300 font-medium',
              }}
            />

            <motion.div
              whileHover={{ scale: 1.02 }}
              whileTap={{ scale: 0.98 }}
            >
              <Button
                type="submit"
                fullWidth
                size="md"
                loading={loading}
                className="bg-indigo-600 hover:bg-indigo-700 text-white font-medium py-3"
              >
                {loading ? 'Signing In...' : 'Sign In'}
              </Button>
            </motion.div>
          </motion.form>

          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            transition={{ delay: 0.5, duration: 0.4 }}
            className="text-center mt-8"
          >
            <Text className="text-gray-600 dark:text-gray-300">
              Don't have an account?{' '}
              <Anchor component={Link} to="/register" className="text-indigo-600 hover:text-indigo-500">
                Sign up
              </Anchor>
            </Text>
          </motion.div>
        </Paper>
      </motion.div>
    </div>
  );
};

export default Login;

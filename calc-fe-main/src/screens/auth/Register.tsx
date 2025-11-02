import React, { useState } from 'react';
import { motion } from 'framer-motion';
import { TextInput, PasswordInput, Button, Paper, Title, Text, Anchor, Alert } from '@mantine/core';
import { Link, useNavigate } from 'react-router-dom';
import { UserPlus, AlertCircle, CheckCircle } from 'lucide-react';
import { useAuth } from '@/contexts/AuthContext';

const Register: React.FC = () => {
  const [formData, setFormData] = useState({
    username: '',
    email: '',
    password: '',
    confirmPassword: '',
  });
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState(false);
  const navigate = useNavigate();
  const { register } = useAuth();

  const handleChange = (field: string) => (e: React.ChangeEvent<HTMLInputElement>) => {
    setFormData(prev => ({ ...prev, [field]: e.target.value }));
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    setError('');
    setSuccess(false);

    if (formData.password !== formData.confirmPassword) {
      setError('Passwords do not match');
      setLoading(false);
      return;
    }

    if (formData.password.length < 6) {
      setError('Password must be at least 6 characters long');
      setLoading(false);
      return;
    }

    try {
      await register(formData.username, formData.email, formData.password);
      setSuccess(true);
      setTimeout(() => {
        navigate('/login');
      }, 2000);
    } catch (err: unknown) {
      const error = err as { response?: { data?: { message?: string } } };
      setError(error.response?.data?.message || 'Registration failed');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen flex items-center justify-center bg-gradient-to-br from-emerald-50 via-green-50 to-teal-50 dark:from-gray-900 dark:via-emerald-900 dark:to-teal-900 p-4 relative overflow-hidden">
      {/* Animated Background Elements */}
      <div className="absolute inset-0 overflow-hidden">
        <motion.div
          className="absolute top-16 left-12 w-28 h-28 bg-gradient-to-br from-emerald-200 to-teal-200 dark:from-emerald-800 dark:to-teal-800 rounded-full opacity-25"
          animate={{
            scale: [1, 1.3, 1],
            rotate: [0, 120, 240, 360],
          }}
          transition={{
            duration: 9,
            repeat: Infinity,
            ease: "easeInOut"
          }}
        />
        <motion.div
          className="absolute bottom-16 right-12 w-20 h-20 bg-gradient-to-br from-teal-200 to-cyan-200 dark:from-teal-800 dark:to-cyan-800 rounded-full opacity-20"
          animate={{
            scale: [1.1, 1, 1.1],
            rotate: [360, 240, 120, 0],
          }}
          transition={{
            duration: 11,
            repeat: Infinity,
            ease: "easeInOut"
          }}
        />
        <motion.div
          className="absolute top-1/3 right-1/3 w-14 h-14 bg-gradient-to-br from-green-200 to-emerald-200 dark:from-green-800 dark:to-emerald-800 rounded-full opacity-30"
          animate={{
            y: [0, 15, 0],
            x: [0, -10, 0],
          }}
          transition={{
            duration: 7,
            repeat: Infinity,
            ease: "easeInOut"
          }}
        />
        <motion.div
          className="absolute bottom-1/4 left-1/3 w-16 h-16 bg-gradient-to-br from-lime-200 to-green-200 dark:from-lime-800 dark:to-green-800 rounded-full opacity-25"
          animate={{
            scale: [1, 1.2, 1],
            rotate: [0, 90, 180, 270, 360],
          }}
          transition={{
            duration: 13,
            repeat: Infinity,
            ease: "linear"
          }}
        />
        <motion.div
          className="absolute top-2/3 left-1/5 w-12 h-12 bg-gradient-to-br from-cyan-200 to-blue-200 dark:from-cyan-800 dark:to-blue-800 rounded-full opacity-20"
          animate={{
            scale: [1, 0.8, 1],
            y: [0, -10, 0],
          }}
          transition={{
            duration: 5,
            repeat: Infinity,
            ease: "easeInOut"
          }}
        />
        <motion.div
          className="absolute top-1/4 right-1/5 w-10 h-10 bg-gradient-to-br from-emerald-300 to-teal-300 dark:from-emerald-700 dark:to-teal-700 rounded-full opacity-15"
          animate={{
            scale: [1, 1.4, 1],
            rotate: [0, -180, -360],
          }}
          transition={{
            duration: 8,
            repeat: Infinity,
            ease: "easeInOut"
          }}
        />
        <motion.div
          className="absolute bottom-1/3 right-1/3 w-16 h-16 bg-gradient-to-br from-green-300 to-lime-300 dark:from-green-700 dark:to-lime-700 rounded-full opacity-18"
          animate={{
            scale: [1, 0.7, 1],
            y: [0, -12, 0],
          }}
          transition={{
            duration: 6,
            repeat: Infinity,
            ease: "easeInOut"
          }}
        />
      </div>

      {/* Classic Background Image */}
      <div
        className="absolute inset-0 bg-cover bg-center opacity-10"
        style={{
          backgroundImage: `url("data:image/svg+xml,%3Csvg width='60' height='60' viewBox='0 0 60 60' xmlns='http://www.w3.org/2000/svg'%3E%3Cg fill='none' fill-rule='evenodd'%3E%3Cg fill='%239C92AC' fill-opacity='0.1'%3E%3Cpath d='M36 34v-4h-2v4h-4v2h4v4h2v-4h4v-2h-4zm0-30V0h-2v4h-4v2h4v4h2V6h4V4h-4zM6 34v-4H4v4H0v2h4v4h2v-4h4v-2H6zM6 4V0H4v4H0v2h4v4h2V6h4V4H6z'/%3E%3C/g%3E%3C/g%3E%3C/svg%3E")`,
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
            <div className="inline-flex items-center justify-center w-16 h-16 bg-emerald-100 dark:bg-emerald-900 rounded-full mb-4">
              <UserPlus className="w-8 h-8 text-emerald-600 dark:text-emerald-400" />
            </div>
            <Title order={2} className="text-gray-900 dark:text-white mb-2">
              Create Account
            </Title>
            <Text className="text-gray-600 dark:text-gray-300">
              Join Neuron and start calculating
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

          {success && (
            <motion.div
              initial={{ opacity: 0, scale: 0.95 }}
              animate={{ opacity: 1, scale: 1 }}
              className="mb-6"
            >
              <Alert icon={<CheckCircle size={16} />} color="green" variant="light">
                Registration successful! Redirecting to login...
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
              label="Username"
              placeholder="Choose a username"
              value={formData.username}
              onChange={handleChange('username')}
              required
              size="md"
              classNames={{
                input: 'bg-white dark:bg-gray-700 border-gray-300 dark:border-gray-600 text-gray-900 dark:text-white placeholder-gray-500 dark:placeholder-gray-400',
                label: 'text-gray-700 dark:text-gray-300 font-medium',
              }}
            />

            <TextInput
              label="Email"
              placeholder="Enter your email"
              type="email"
              value={formData.email}
              onChange={handleChange('email')}
              required
              size="md"
              classNames={{
                input: 'bg-white dark:bg-gray-700 border-gray-300 dark:border-gray-600 text-gray-900 dark:text-white placeholder-gray-500 dark:placeholder-gray-400',
                label: 'text-gray-700 dark:text-gray-300 font-medium',
              }}
            />

            <PasswordInput
              label="Password"
              placeholder="Create a password"
              value={formData.password}
              onChange={handleChange('password')}
              required
              size="md"
              classNames={{
                input: 'bg-white dark:bg-gray-700 border-gray-300 dark:border-gray-600 text-gray-900 dark:text-white placeholder-gray-500 dark:placeholder-gray-400',
                label: 'text-gray-700 dark:text-gray-300 font-medium',
              }}
            />

            <PasswordInput
              label="Confirm Password"
              placeholder="Confirm your password"
              value={formData.confirmPassword}
              onChange={handleChange('confirmPassword')}
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
                disabled={success}
                className="bg-emerald-600 hover:bg-emerald-700 text-white font-medium py-3"
              >
                {loading ? 'Creating Account...' : success ? 'Account Created!' : 'Create Account'}
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
              Already have an account?{' '}
              <Anchor component={Link} to="/login" className="text-emerald-600 hover:text-emerald-500">
                Sign in
              </Anchor>
            </Text>
          </motion.div>
        </Paper>
      </motion.div>
    </div>
  );
};

export default Register;

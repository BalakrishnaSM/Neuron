import {createBrowserRouter, RouterProvider} from 'react-router-dom';
import '@mantine/core/styles.css';
import { MantineProvider } from '@mantine/core';

import Home from '@/screens/home';
import Login from '@/screens/auth/Login';
import Register from '@/screens/auth/Register';
import ProtectedRoute from '@/components/ProtectedRoute';
import { AuthProvider } from '@/contexts/AuthContext';

import '@/index.css';

const paths = [
    {
        path: '/login',
        element: <Login />,
    },
    {
        path: '/register',
        element: <Register />,
    },
    {
        path: '/',
        element: (
            <ProtectedRoute>
                <Home />
            </ProtectedRoute>
        ),
    },
];

const BrowserRouter = createBrowserRouter(paths);

const App = () => {
    return (
        <MantineProvider defaultColorScheme="dark">
            <AuthProvider>
                <RouterProvider router={BrowserRouter}/>
            </AuthProvider>
        </MantineProvider>
    )
};

export default App;

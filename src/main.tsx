import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { applyFavicon } from './brand';
import { Login } from './pages/Login';
import './styles.css';

applyFavicon();
createRoot(document.getElementById('root')!).render(
  <StrictMode>{location.pathname === '/login' ? <Login /> : <App />}</StrictMode>,
);

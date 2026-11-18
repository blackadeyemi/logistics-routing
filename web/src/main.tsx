import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { applyFont, applyTheme, watchSystemTheme } from './lib/theme';
import './styles/gds.css';
import './styles/app.css';

applyTheme();
applyFont();
watchSystemTheme();

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);

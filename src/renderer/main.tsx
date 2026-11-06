import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

import { AppShell } from './AppShell';
import './assets/noto-sans-sc/noto-sans-sc.css';
import './styles.css';
import './shadcn.css';

const container = document.getElementById('root');
if (!container) {
  throw new Error('renderer: #root container not found');
}

createRoot(container).render(
  <StrictMode>
    <AppShell />
  </StrictMode>,
);

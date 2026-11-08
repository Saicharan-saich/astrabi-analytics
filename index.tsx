import React from 'react';
import ReactDOM from 'react-dom/client';
import { MotionConfig } from 'framer-motion';
import App from './App';
import './visual-presentation.css';

const rootElement = document.getElementById('root');
if (!rootElement) {
  throw new Error("Could not find root element to mount to");
}

const root = ReactDOM.createRoot(rootElement);
root.render(
  <React.StrictMode>
    {/* Every Framer Motion animation in the app follows the OS
        "reduce motion" setting: transforms are skipped, fades kept. */}
    <MotionConfig reducedMotion="user">
      <App />
    </MotionConfig>
  </React.StrictMode>
);

// AI SQL accuracy console (admin research tool): only loaded with ?qi-accuracy in the address.
if (new URLSearchParams(window.location.search).has('qi-accuracy')) {
  import('./services/benchmark/aiSqlAccuracy').then(module => module.installAccuracyConsole());
}

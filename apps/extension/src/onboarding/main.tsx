import { createRoot } from 'react-dom/client';
import { App } from './App.js';
import '../styles/tailwind.css';

const container = document.getElementById('root');
if (!container) throw new Error('onboarding root element missing');
createRoot(container).render(<App />);

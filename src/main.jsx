import { createRoot } from 'react-dom/client';
import { App } from './app/App.jsx';
import { AuthGate } from './components/AuthGate.jsx';
import './styles/app.css';

createRoot(document.getElementById('root')).render(
  <AuthGate><App /></AuthGate>
);

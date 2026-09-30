import { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './app/App.jsx';
import { pageFromLocation } from './app/routes.js';
import { AuthGate } from './components/AuthGate.jsx';
import './styles/app.css';

function ApplicationRoot() {
  const [page, setPage] = useState(pageFromLocation);

  useEffect(() => {
    const handleHashChange = () => setPage(pageFromLocation());
    window.addEventListener('hashchange', handleHashChange);
    return () => window.removeEventListener('hashchange', handleHashChange);
  }, []);

  return page === 'viewer' ? <App /> : <AuthGate><App /></AuthGate>;
}

createRoot(document.getElementById('root')).render(
  <ApplicationRoot />
);

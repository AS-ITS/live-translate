import { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './app/App.jsx';
import { pageFromLocation } from './app/routes.js';
import { AuthGate } from './components/AuthGate.jsx';
import { exposeLiveTranslateDebug } from './lib/liveSession.js';
import { configureLivePipelineTrace, recordLivePipelineTrace } from './lib/livePipelineTrace.js';
import { loadRuntimeConfig } from './lib/runtimeConfig.js';
import './styles/app.css';

function ApplicationRoot() {
  const [page, setPage] = useState(pageFromLocation);

  useEffect(() => {
    const handleHashChange = () => {
      const nextPage = pageFromLocation();
      recordLivePipelineTrace({
        stage: 'ROUTE_CHANGED',
        event: 'browser.route.changed',
        route: nextPage
      });
      setPage(nextPage);
    };
    window.addEventListener('hashchange', handleHashChange);
    return () => window.removeEventListener('hashchange', handleHashChange);
  }, []);

  return page === 'viewer' ? <App /> : <AuthGate><App /></AuthGate>;
}

async function bootstrap() {
  const runtimeConfig = await loadRuntimeConfig();
  configureLivePipelineTrace(runtimeConfig.livePipelineTraceEnabled);
  exposeLiveTranslateDebug();
  createRoot(document.getElementById('root')).render(<ApplicationRoot />);
}

void bootstrap();

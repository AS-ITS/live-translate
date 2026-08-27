import React from 'react';

/**
 * The live recording route owns the live-reading surface. Session orchestration
 * is supplied by the application shell until it is extracted behind a page
 * controller; this boundary keeps Workspace pages from rendering live UI.
 */
export function LiveRecordingPage({ children, drawers = null }) {
  return (
    <>
      <section className="feature-page live-page live-recording-page" aria-label="即時錄製">
        <div className="live-recording-page-content">
          {children}
        </div>
      </section>
      {drawers}
    </>
  );
}

import { AlertCircle } from 'lucide-react';
import { GeminiCredentialNotice } from '../../components/GeminiCredentialNotice.jsx';

export function LiveMeetingPicker({ meetings = [], selectedMeetingId = '', disabled = false, onChange }) {
  const availableMeetings = meetings.filter((meeting) => ['created', 'active', 'interrupted'].includes(meeting.status));

  return (
    <label className="live-meeting-picker">
      <span>目前會議</span>
      <select aria-label="選擇會議" value={selectedMeetingId} onChange={(event) => onChange(event.target.value)} disabled={disabled}>
        <option value="">尚未選擇會議</option>
        {availableMeetings.map((meeting) => <option key={meeting.id} value={meeting.id}>{meeting.name || meeting.id}</option>)}
      </select>
    </label>
  );
}

/**
 * The live recording route owns the live-reading surface. Session orchestration
 * is supplied by the application shell until it is extracted behind a page
 * controller; this boundary keeps Workspace pages from rendering live UI.
 */
export function LiveRecordingPage({ children, drawers = null, error = '', errorCode = '', status = 'idle', onRetry = null }) {
  return (
    <>
      <section className="feature-page live-page live-recording-page" aria-label="即時錄製">
        <div className={`live-recording-page-content${error ? ' has-live-error' : ''}`}>
          <GeminiCredentialNotice />
          {error ? (
            <div className="error-message live-error-message">
              <AlertCircle className="live-error-icon" size={18} aria-hidden="true" />
              <p role="alert">{error}</p>
              {['error', 'provider-recovery-failed'].includes(status) && onRetry ? (
                <button className="inline-retry live-error-retry" type="button" onClick={onRetry}>
                  重試
                </button>
              ) : null}
            </div>
          ) : null}
          {children}
        </div>
      </section>
      {drawers}
    </>
  );
}

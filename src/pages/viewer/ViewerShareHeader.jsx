import { useEffect, useState } from 'react';
import { createViewerShareQrDataUrl } from '../../lib/viewerShare.js';

export function ViewerShareHeader({ meetingTitle, shareUrl }) {
  const [qrDataUrl, setQrDataUrl] = useState('');

  useEffect(() => {
    let active = true;
    setQrDataUrl('');
    if (shareUrl) {
      void createViewerShareQrDataUrl(shareUrl, { width: 192 }).then((value) => {
        if (active) setQrDataUrl(value);
      });
    }
    return () => { active = false; };
  }, [shareUrl]);

  return (
    <header className="viewer-share-header" data-testid="viewer-share-header">
      <div className="viewer-share-header-content">
        <p className="viewer-share-kicker">即時字幕</p>
        <h1>{meetingTitle}</h1>
        <div className="viewer-share-link-row">
          <a className="viewer-share-url" href={shareUrl} aria-label="Viewer 分享連結" title={shareUrl}>{shareUrl}</a>
        </div>
      </div>
      <div className="viewer-share-qr" aria-label="Viewer 分享連結 QR Code">
        {qrDataUrl ? <img src={qrDataUrl} alt="Viewer 分享連結 QR Code" width="88" height="88" /> : <span aria-hidden="true" />}
      </div>
    </header>
  );
}

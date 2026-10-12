import QRCode from 'qrcode';

export function canonicalViewerShareUrl({ code, token }, baseUrl = window.location.href) {
  const credential = code ? ['code', code] : token ? ['token', token] : null;
  if (!credential) return '';

  const url = new URL(baseUrl);
  url.search = '';
  url.hash = `viewer?${credential[0]}=${encodeURIComponent(credential[1])}`;
  return url.href;
}

export function canonicalizeViewerShareUrl(value, baseUrl = window.location.href) {
  return new URL(value, baseUrl).href;
}

export function createViewerShareQrDataUrl(shareUrl, { width = 180 } = {}) {
  return QRCode.toDataURL(shareUrl, { width, margin: 1 });
}

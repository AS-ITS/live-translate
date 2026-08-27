import React, { useEffect, useMemo, useRef, useState } from 'react';
import QRCode from 'qrcode';
import { ArrowRight, BookOpen, ChevronDown, Copy, Mic, Pencil, Plus, Trash2, Volume2 } from 'lucide-react';
import { SUPPORTED_LANGUAGES } from '../../lib/languages.js';
import { createGlossaryApiClient } from '../../lib/glossaryApiClient.js';
import { createMeetingManagementApiClient } from '../../lib/meetingManagementApiClient.js';
import { createMeetingReadApiClient } from '../../lib/meetingReadApiClient.js';

const DEFAULT_SOURCE_LANGUAGE_CODE = 'zh-Hant';
const MEETING_SETTINGS_STEPS = [
  '基本資訊',
  '語言設定',
  '音訊設定',
  '字典設定'
];

export function MeetingSettingsPage({ mode = 'create', meetingId = '', onBack, onOpenWorkspace }) {
  const managementClient = useMemo(() => createMeetingManagementApiClient(), []);
  const readClient = useMemo(() => createMeetingReadApiClient(), []);
  const glossaryClient = useMemo(() => createGlossaryApiClient(), []);
  const [meeting, setMeeting] = useState(null);
  const [entries, setEntries] = useState([]);
  const [name, setName] = useState('');
  const [sourceLanguageCode, setSourceLanguageCode] = useState(DEFAULT_SOURCE_LANGUAGE_CODE);
  const [targetLanguageCode, setTargetLanguageCode] = useState('en');
  const [selectedGlossaryIds, setSelectedGlossaryIds] = useState([]);
  const [privateGlossaryEntries, setPrivateGlossaryEntries] = useState([]);
  const [privateSource, setPrivateSource] = useState('');
  const [privateTranslation, setPrivateTranslation] = useState('');
  const [editingPrivateSource, setEditingPrivateSource] = useState('');
  const [isGlobalGlossaryExpanded, setIsGlobalGlossaryExpanded] = useState(true);
  const [echoTargetLanguage, setEchoTargetLanguage] = useState(true);
  const [shouldRecordInputAudio, setShouldRecordInputAudio] = useState(false);
  const [shares, setShares] = useState([]);
  const [createdShares, setCreatedShares] = useState([]);
  const [shareState, setShareState] = useState('idle');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [isLoading, setIsLoading] = useState(mode === 'edit');
  const [isSaving, setIsSaving] = useState(false);
  const [activeStep, setActiveStep] = useState(0);
  const settingsSectionRefs = useRef([]);
  const shareSectionRef = useRef(null);
  const shareEnsurePromiseRef = useRef(null);

  useEffect(() => {
    let cancelled = false;
    Promise.all([
      glossaryClient.listEntries(),
      mode === 'edit' && meetingId ? readClient.getMeetingDetail(meetingId) : Promise.resolve(null)
    ]).then(([glossaryEntries, detail]) => {
      if (cancelled) return;
      setEntries(glossaryEntries);
      const current = detail?.meeting || null;
      if (mode === 'edit' && !current) throw new Error('meeting_not_found');
      if (current) applyMeeting(current, glossaryEntries);
      setIsLoading(false);
    }).catch(() => {
      if (!cancelled) {
        setError('無法載入會議設定。');
        setIsLoading(false);
      }
    });
    return () => { cancelled = true; };
  }, [glossaryClient, meetingId, mode, readClient]);

  useEffect(() => {
    if (isLoading || typeof window === 'undefined' || !('IntersectionObserver' in window)) return undefined;
    const sections = [...settingsSectionRefs.current.filter(Boolean), shareSectionRef.current].filter(Boolean);
    if (!sections.length) return undefined;
    const headerOffset = 112;
    const initialStepLockDistance = 80;
    const focusLineRatio = 0.4;
    const observer = new IntersectionObserver(() => {
      if (window.scrollY <= initialStepLockDistance) {
        setActiveStep(0);
        return;
      }
      const focusY = Math.max(headerOffset, window.innerHeight * focusLineRatio);
      const sectionRects = sections.map((section, index) => ({ section, index, rect: section.getBoundingClientRect() }));
      const focusedSection = sectionRects.find(({ rect }) => rect.top <= focusY && rect.bottom > focusY);
      if (focusedSection) {
        setActiveStep(focusedSection.index);
        return;
      }
      const nearestSection = sectionRects
        .map((item) => ({ ...item, distance: item.rect.top > focusY ? item.rect.top - focusY : item.rect.bottom < focusY ? focusY - item.rect.bottom : 0 }))
        .sort((left, right) => left.distance - right.distance)[0];
      if (nearestSection) setActiveStep(nearestSection.index);
    }, { rootMargin: `-${headerOffset}px 0px -60% 0px`, threshold: [0, 0.25, 0.5] });
    sections.forEach((section) => observer.observe(section));
    return () => observer.disconnect();
  }, [isLoading, meeting]);

  function applyMeeting(current, glossaryEntries) {
    const target = current.targetLanguageCode || 'en';
    setMeeting(current);
    setName(current.name || '');
    setSourceLanguageCode(current.sourceLanguageCode || DEFAULT_SOURCE_LANGUAGE_CODE);
    setTargetLanguageCode(target);
    setEchoTargetLanguage(current.echoTargetLanguage !== false);
    setShouldRecordInputAudio(current.shouldRecordInputAudio === true);
    setSelectedGlossaryIds(glossaryEntries
      .filter((entry) => (current.glossaryEntries || []).some((item) => item.source === entry.source && item.target === entry.translations?.[target]))
      .map((entry) => entry.id));
    setPrivateGlossaryEntries(Array.isArray(current.privateGlossaryEntries) ? current.privateGlossaryEntries : []);
    void managementClient.listShares(current.id).then(async (loadedShares) => {
      setShares(loadedShares);
      const displayableShares = await Promise.all(loadedShares.filter((share) => share.codeUrl).map(prepareShareForDisplay));
      setCreatedShares(displayableShares);
      if (displayableShares.length === 0 && current.status !== 'completed') void createSharesWithRetry(current.id);
      else setShareState('ready');
    }).catch(() => setShares([]));
  }

  function selectedEntries() {
    return entries.filter((entry) => selectedGlossaryIds.includes(entry.id))
      .map((entry) => ({
        source: entry.source,
        target: entry.translations?.[targetLanguageCode],
        replacementAliases: entry.replacementAliases?.[targetLanguageCode] || []
      }))
      .filter((entry) => entry.target);
  }

  function savePrivateEntry() {
    const source = privateSource.trim();
    const translation = privateTranslation.trim();
    if (!source || !translation) return;
    const original = editingPrivateSource || source;
    const previous = privateGlossaryEntries.find((entry) => entry.source === original);
    const next = {
      ...(previous || {}),
      source,
      translations: { ...(previous?.translations || {}), [targetLanguageCode]: translation },
      replacementAliases: { ...(previous?.replacementAliases || {}) }
    };
    setPrivateGlossaryEntries((current) => [next, ...current.filter((entry) => entry.source !== original)]);
    setPrivateSource('');
    setPrivateTranslation('');
    setEditingPrivateSource('');
  }

  async function createShare(meetingId, role) {
    const result = await managementClient.ensureShareWithRole(meetingId, role, null);
    const shareUrl = new URL(result.codeUrl || result.url, window.location.href).href;
    const qrDataUrl = await QRCode.toDataURL(shareUrl, { width: 180, margin: 1 });
    return { ...result, role, absoluteUrl: shareUrl, qrDataUrl };
  }

  async function prepareShareForDisplay(share) {
    const shareUrl = new URL(share.codeUrl, window.location.href).href;
    const qrDataUrl = await QRCode.toDataURL(shareUrl, { width: 180, margin: 1 });
    return { share, role: share.role, absoluteUrl: shareUrl, qrDataUrl };
  }

  async function createSharesWithRetry(meetingId = meeting?.id) {
    if (shareEnsurePromiseRef.current) return shareEnsurePromiseRef.current;
    const promise = (async () => {
      setShareState('loading');
      const results = [];
      const roles = ['viewer', 'recorder'];
      for (const role of roles) {
        let lastError = null;
        for (let attempt = 0; attempt < 3; attempt += 1) {
          try {
            results.push(await createShare(meetingId, role));
            lastError = null;
            break;
          } catch (requestError) {
            lastError = requestError;
            if (attempt < 2) await new Promise((resolve) => window.setTimeout(resolve, 250 * (attempt + 1)));
          }
        }
        if (lastError) {
          setShareState('error');
          setError('會議已建立，但分享連結產生失敗；請稍後重試。');
          setCreatedShares(results);
          return;
        }
      }
      setCreatedShares(results);
      setShares((current) => [...current.filter((share) => !results.some((item) => item.share?.id === share.id)), ...results.map((item) => item.share)]);
      setShareState('ready');
    })();
    shareEnsurePromiseRef.current = promise;
    try {
      return await promise;
    } finally {
      if (shareEnsurePromiseRef.current === promise) shareEnsurePromiseRef.current = null;
    }
  }

  async function saveMeeting() {
    if (meeting?.status === 'completed') return;
    setIsSaving(true);
    setError('');
    setNotice('');
    try {
      const input = {
        name: name.trim() || null,
        sourceLanguageCode,
        targetLanguageCode,
        echoTargetLanguage,
        shouldRecordInputAudio,
        glossaryEntries: selectedEntries(),
        privateGlossaryEntries
      };
      const saved = meeting
        ? await managementClient.update(meeting.id, input)
        : await managementClient.create(input);
      setMeeting(saved);
      setNotice(meeting ? '會議設定已更新。' : '會議已建立，正在產生分享連結…');
      if (!meeting) await createSharesWithRetry(saved.id);
      else setShareState('ready');
    } catch (requestError) {
      setError(requestError?.status === 409 ? '已完成會議不可修改設定。' : '無法儲存會議設定。');
    } finally {
      setIsSaving(false);
    }
  }

  async function retryShares() {
    setError('');
    await createSharesWithRetry();
  }

  async function revokeShare(shareId) {
    try {
      await managementClient.revokeShare(meeting.id, shareId);
      setShares((current) => current.filter((share) => share.id !== shareId));
      setCreatedShares((current) => current.filter((item) => item.share?.id !== shareId));
    } catch {
      setError('無法撤銷分享連結。');
    }
  }

  function copy(value) {
    if (value) void navigator.clipboard?.writeText(value);
  }

  const availableGlossaryEntries = entries.filter((entry) => entry.enabled !== false && entry.translations?.[targetLanguageCode]);
  const selectedGlossaryCount = availableGlossaryEntries.filter((entry) => selectedGlossaryIds.includes(entry.id)).length;
  const sourceLanguageLabel = SUPPORTED_LANGUAGES.find((item) => item.code === sourceLanguageCode)?.label || sourceLanguageCode;
  const targetLanguageLabel = SUPPORTED_LANGUAGES.find((item) => item.code === targetLanguageCode)?.label || targetLanguageCode;
  const settingsSummary = `${sourceLanguageLabel} → ${targetLanguageLabel} · ${echoTargetLanguage ? '播放翻譯聲音' : '不播放翻譯聲音'} · 私有詞彙 ${privateGlossaryEntries.length} 筆`;

  function scrollToSettingsStep(index) {
    const section = index === MEETING_SETTINGS_STEPS.length
      ? shareSectionRef.current
      : settingsSectionRefs.current[index];
    if (!section) return;
    setActiveStep(index);
    section.scrollIntoView({
      behavior: window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth',
      block: 'start'
    });
  }

  if (isLoading) return <section className="feature-page meeting-settings-page"><p>正在載入會議設定…</p></section>;

  return (
    <section className="feature-page meeting-settings-page" aria-labelledby="meeting-settings-title">
      {error ? <p className="error-message" role="alert">{error}</p> : null}
      {notice ? <p className="success-message" role="status">{notice}</p> : null}
      <div className="meeting-settings-layout meeting-management-grid">
        <nav className="meeting-settings-steps" aria-label="會議設定步驟">
          {MEETING_SETTINGS_STEPS.map((label, index) => <button className={`meeting-settings-step${index === activeStep ? ' is-active' : ''}`} type="button" aria-current={index === activeStep ? 'step' : undefined} onClick={() => scrollToSettingsStep(index)} key={label}><span>{index + 1}</span><strong>{label}</strong></button>)}
          {meeting ? <button className={`meeting-settings-step${activeStep === MEETING_SETTINGS_STEPS.length ? ' is-active' : ''}`} type="button" aria-current={activeStep === MEETING_SETTINGS_STEPS.length ? 'step' : undefined} onClick={() => scrollToSettingsStep(MEETING_SETTINGS_STEPS.length)}><span>{MEETING_SETTINGS_STEPS.length + 1}</span><strong>分享會議</strong></button> : null}
        </nav>
        <section className="meeting-settings-form control-panel" aria-label="會議設定表單">
          <section className="meeting-settings-card" ref={(node) => { settingsSectionRefs.current[0] = node; }} aria-labelledby="meeting-basic-settings-title">
            <div className="meeting-settings-card-header"><div><p className="eyebrow">STEP 1</p><h3 id="meeting-basic-settings-title">基本資訊</h3></div><span className="meeting-settings-card-number">1</span></div>
            <label className="field meeting-name-field"><span>會議名稱</span><input value={name} onChange={(event) => setName(event.target.value)} placeholder="例如：產品會議" maxLength={120} disabled={meeting?.status === 'completed'} /><small>建立後可分享會議連結給參與者。</small></label>
          </section>

          <section className="meeting-settings-card" ref={(node) => { settingsSectionRefs.current[1] = node; }} aria-labelledby="meeting-language-settings-title">
            <div className="meeting-settings-card-header"><div><p className="eyebrow">STEP 2</p><h3 id="meeting-language-settings-title">語言設定</h3></div><span className="meeting-settings-card-number">2</span></div>
            <div className="meeting-language-fields"><label className="field"><span>主要輸入語言</span><select value={sourceLanguageCode} onChange={(event) => setSourceLanguageCode(event.target.value)} disabled={meeting?.status === 'completed'}>{SUPPORTED_LANGUAGES.map((item) => <option key={item.code} value={item.code}>{item.label}</option>)}</select></label><span className="meeting-language-direction" aria-label="翻譯方向"><ArrowRight size={20} aria-hidden="true" /></span><label className="field"><span>目標語言</span><select value={targetLanguageCode} onChange={(event) => setTargetLanguageCode(event.target.value)} disabled={meeting?.status === 'completed'}>{SUPPORTED_LANGUAGES.map((item) => <option key={item.code} value={item.code}>{item.label}</option>)}</select></label></div>
          </section>

          <section className="meeting-settings-card" ref={(node) => { settingsSectionRefs.current[2] = node; }} aria-labelledby="meeting-audio-settings-title">
            <div className="meeting-settings-card-header"><div><p className="eyebrow">STEP 3</p><h3 id="meeting-audio-settings-title">音訊設定</h3></div><span className="meeting-settings-card-number">3</span></div>
            <div className="meeting-audio-options"><label className="meeting-audio-option"><span className="meeting-settings-icon"><Volume2 size={19} aria-hidden="true" /></span><span><strong>播放翻譯聲音</strong><small>讓參與者聽見即時翻譯結果。</small></span><span className="meeting-toggle"><input type="checkbox" checked={echoTargetLanguage} onChange={(event) => setEchoTargetLanguage(event.target.checked)} disabled={meeting?.status === 'completed'} /><span aria-hidden="true" /></span></label><label className="meeting-audio-option"><span className="meeting-settings-icon"><Mic size={19} aria-hidden="true" /></span><span><strong>保存原始聲音</strong><small>保存會議中的原始麥克風音訊。</small></span><span className="meeting-toggle"><input type="checkbox" checked={shouldRecordInputAudio} onChange={(event) => setShouldRecordInputAudio(event.target.checked)} disabled={meeting?.status === 'completed'} /><span aria-hidden="true" /></span></label></div>
            <p className="export-note">麥克風裝置由每位參與者在自己的瀏覽器中選擇。</p>
          </section>

          <section className="meeting-settings-card" ref={(node) => { settingsSectionRefs.current[3] = node; }} aria-labelledby="meeting-dictionary-settings-title">
            <div className="meeting-settings-card-header"><div><p className="eyebrow">STEP 4</p><h3 id="meeting-dictionary-settings-title">字典設定</h3><p className="meeting-settings-card-description">管理可套用到本場會議的全域與私有詞彙。</p></div><span className="meeting-settings-card-number">4</span></div>
            <div className="meeting-dictionary-groups">
              <section className="meeting-dictionary-group meeting-global-glossary" aria-labelledby="meeting-global-glossary-title">
                <button className="meeting-global-glossary-summary" type="button" aria-expanded={isGlobalGlossaryExpanded} onClick={() => setIsGlobalGlossaryExpanded((current) => !current)}><span className="meeting-settings-icon"><BookOpen size={18} aria-hidden="true" /></span><span><strong id="meeting-global-glossary-title">全域字典</strong><small>{availableGlossaryEntries.length === 0 ? '尚無可選用的全域詞條。' : `已選 ${selectedGlossaryCount} / ${availableGlossaryEntries.length} 筆詞彙`}</small></span><ChevronDown size={18} aria-hidden="true" /></button>
                {isGlobalGlossaryExpanded ? <div className="meeting-global-glossary-content">{availableGlossaryEntries.map((entry) => <label className="glossary-choice" key={entry.id}><input type="checkbox" checked={selectedGlossaryIds.includes(entry.id)} onChange={() => setSelectedGlossaryIds((current) => current.includes(entry.id) ? current.filter((id) => id !== entry.id) : [...current, entry.id])} disabled={meeting?.status === 'completed'} /><span><strong>{entry.source}</strong><small>{entry.translations[targetLanguageCode]}</small></span></label>)}{availableGlossaryEntries.length === 0 ? <p className="export-note">尚無可選用的全域詞條。</p> : null}</div> : null}
              </section>
              <section className="meeting-dictionary-group meeting-private-glossary" aria-labelledby="meeting-private-glossary-title">
                <div className="meeting-dictionary-section-heading"><div><h4 id="meeting-private-glossary-title">私有字典</h4><p className="meeting-settings-card-description">此會議專用的詞彙設定。</p></div></div>
                <div className="meeting-private-glossary-list">{privateGlossaryEntries.map((entry) => <div className="meeting-private-entry" key={entry.source}><div className="meeting-private-entry-fields"><div><span>原文</span><strong>{entry.source}</strong></div><div><span>翻譯</span><strong>{entry.translations?.[targetLanguageCode] || '尚未設定目前語言翻譯'}</strong></div></div>{meeting?.status !== 'completed' ? <span className="meeting-actions"><button className="button detail-button" type="button" aria-label={`編輯 ${entry.source}`} onClick={() => { setEditingPrivateSource(entry.source); setPrivateSource(entry.source); setPrivateTranslation(entry.translations?.[targetLanguageCode] || ''); }}><Pencil size={15} aria-hidden="true" /><span className="sr-only">編輯</span></button><button className="button detail-button danger-button" type="button" aria-label={`刪除 ${entry.source}`} onClick={() => setPrivateGlossaryEntries((current) => current.filter((item) => item.source !== entry.source))}><Trash2 size={15} aria-hidden="true" /><span className="sr-only">刪除</span></button></span> : null}</div>)}{meeting?.status !== 'completed' ? <div className="glossary-quick-add"><div className="meeting-private-entry-fields"><label className="field"><span>原文</span><input value={privateSource} onChange={(event) => setPrivateSource(event.target.value)} /></label><label className="field"><span>翻譯</span><input value={privateTranslation} onChange={(event) => setPrivateTranslation(event.target.value)} /></label></div><button className="button secondary meeting-add-private-button" type="button" onClick={savePrivateEntry} disabled={!privateSource.trim() || !privateTranslation.trim()}><Plus size={16} aria-hidden="true" />{editingPrivateSource ? '更新私有詞條' : '新增私有詞彙'}</button></div> : null}</div>
              </section>
            </div>
          </section>

          {meeting ? <ShareResults sectionRef={shareSectionRef} shares={createdShares} existingShares={shares} state={shareState} onRetry={retryShares} onRevokeShare={revokeShare} onCopy={copy} locked={meeting.status === 'completed'} /> : null}
          <div className="meeting-settings-actions meeting-settings-submit-row"><p className="meeting-settings-summary">{settingsSummary}</p><div className="meeting-settings-action-buttons"><button className="button primary" type="button" onClick={saveMeeting} disabled={isSaving || meeting?.status === 'completed'}>{isSaving ? '儲存中…' : meeting ? '儲存變更' : '建立會議'}</button>{meeting ? <button className="button secondary" type="button" onClick={() => onOpenWorkspace(meeting.id)}>前往會議工作區</button> : null}</div></div>
        </section>
      </div>
    </section>
  );
}

function ShareResults({ sectionRef, shares, existingShares, state, onRetry, onRevokeShare, onCopy, locked }) {
  return (
    <section ref={sectionRef} className="control-panel meeting-settings-card meeting-share-results" aria-labelledby="meeting-share-results-title">
      <div className="meeting-settings-card-header">
        <div>
          <p className="eyebrow">STEP 5</p>
          <h3 id="meeting-share-results-title">分享會議</h3>
          <p className="meeting-settings-card-description">觀看連結為唯讀；錄音連結會在參與者明確開始後才使用麥克風。</p>
        </div>
        <span className="meeting-settings-card-number">5</span>
      </div>
      {state === 'loading' ? <p>正在產生分享連結…</p> : null}
      {state === 'error' ? <><p className="error-message">部分分享連結尚未產生。</p><button className="button secondary" type="button" onClick={onRetry}>重新產生分享</button></> : null}
      {shares.length > 0 ? <div className="meeting-share-links">{shares.map((item) => <article className="share-result" key={item.role}><h4>{item.role === 'viewer' ? '觀看連結' : '錄音連結'}</h4><img src={item.qrDataUrl} alt={`${item.role === 'viewer' ? '觀看' : '錄音'}入口 QR Code`} width="180" height="180" /><p className="share-url"><a href={item.absoluteUrl}>{item.absoluteUrl}</a></p><button className="button detail-button" type="button" onClick={() => onCopy(item.absoluteUrl)}><Copy size={15} aria-hidden="true" />複製連結</button></article>)}</div> : null}
      {shares.length === 0 && state === 'ready' ? <p className="export-note">尚未產生新的分享連結。</p> : null}
      {existingShares.length > 0 ? <ul className="share-list">{existingShares.map((share) => <li key={share.id}><span>{share.role === 'viewer' ? '觀看連結' : '錄音連結'} · {share.expiresAt ? `到期：${new Date(share.expiresAt).toLocaleString('zh-TW')}` : '永久有效'}</span>{!locked ? <button className="button detail-button danger-button" type="button" onClick={() => onRevokeShare(share.id)}>撤銷</button> : null}</li>)}</ul> : null}
    </section>
  );
}

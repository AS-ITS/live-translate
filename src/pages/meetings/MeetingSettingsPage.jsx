import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import QRCode from 'qrcode';
import { AlertCircle, ArrowRight, BookOpen, CheckCircle2, ChevronDown, CircleDashed, Copy, Download, LoaderCircle, Mic, Pencil, Plus, Trash2, Volume2, X } from 'lucide-react';
import { SUPPORTED_LANGUAGES } from '../../lib/languages.js';
import { createGlossaryApiClient } from '../../lib/glossaryApiClient.js';
import { createMeetingManagementApiClient, meetingManagementErrorMessage } from '../../lib/meetingManagementApiClient.js';
import { createMeetingReadApiClient } from '../../lib/meetingReadApiClient.js';
import { meetingApiErrorMessage } from '../../lib/meetingApiError.js';
import { audioInputDevices, audioOutputDevices, requestAudioInputStream, supportsAudioContextOutputSelection } from '../../lib/mediaDevices.js';
import { clearMeetingAudioPreference, getMeetingAudioPreference, hasConfirmedMeetingAudioPreference, setMeetingAudioPreference } from '../../lib/meetingAudioPreferences.js';

const DEFAULT_SOURCE_LANGUAGE_CODE = 'zh-Hant';
const SHARE_SETTINGS_STEP_INDEX = 4;
const MEMBER_SETTINGS_STEP_INDEX = 5;
const MEETING_SETTINGS_STEPS = [
  '基本資訊',
  '語言設定',
  '音訊設定',
  '詞彙設定',
  '分享會議',
  '成員與錄製權限'
];

export function MeetingSettingsPage({ mode = 'create', meetingId = '', onBack, onOpenLive }) {
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
  const [isPrivateImportOpen, setIsPrivateImportOpen] = useState(false);
  const [privateImportFile, setPrivateImportFile] = useState(null);
  const [privateImportPreview, setPrivateImportPreview] = useState(null);
  const [privateImportSelectedRows, setPrivateImportSelectedRows] = useState([]);
  const [privateImportResolutions, setPrivateImportResolutions] = useState({});
  const [isPrivateImporting, setIsPrivateImporting] = useState(false);
  const [isGlobalGlossaryExpanded, setIsGlobalGlossaryExpanded] = useState(true);
  const [echoTargetLanguage, setEchoTargetLanguage] = useState(true);
  const [shouldRecordInputAudio, setShouldRecordInputAudio] = useState(false);
  const [shares, setShares] = useState([]);
  const [members, setMembers] = useState([]);
  const [memberEmail, setMemberEmail] = useState('');
  const [memberBusy, setMemberBusy] = useState('');
  const [memberNotice, setMemberNotice] = useState('');
  const [memberError, setMemberError] = useState('');
  const [createdShares, setCreatedShares] = useState([]);
  const [shareState, setShareState] = useState('idle');
  const [shareLayoutReady, setShareLayoutReady] = useState(false);
  const [error, setError] = useState('');
  const [glossaryLoadWarning, setGlossaryLoadWarning] = useState('');
  const [nameError, setNameError] = useState('');
  const [audioSettingsError, setAudioSettingsError] = useState('');
  const [notice, setNotice] = useState('');
  const [isLoading, setIsLoading] = useState(mode === 'edit');
  const [isSaving, setIsSaving] = useState(false);
  const [activeStep, setActiveStep] = useState(0);
  const [audioInputs, setAudioInputs] = useState([]);
  const [audioOutputs, setAudioOutputs] = useState([]);
  const [selectedInputDeviceId, setSelectedInputDeviceId] = useState('');
  const [selectedOutputDeviceId, setSelectedOutputDeviceId] = useState('');
  const [audioPermissionStatus, setAudioPermissionStatus] = useState('unknown');
  const [audioTestStatus, setAudioTestStatus] = useState('idle');
  const settingsSectionRefs = useRef([]);
  const shareSectionRef = useRef(null);
  const submitRowRef = useRef(null);
  const nameInputRef = useRef(null);
  const audioConfirmButtonRef = useRef(null);
  const shareEnsurePromiseRef = useRef(null);
  const autoScrolledMeetingIdRef = useRef(null);

  const refreshAudioDevices = useCallback(async () => {
    if (!navigator.mediaDevices?.enumerateDevices) { setAudioPermissionStatus('unsupported'); return; }
    const devices = await navigator.mediaDevices.enumerateDevices();
    const inputs = audioInputDevices(devices);
    const outputs = audioOutputDevices(devices);
    setAudioInputs(inputs);
    setAudioOutputs(outputs);
    setSelectedInputDeviceId((current) => current && inputs.some((device) => device.deviceId === current) ? current : '');
    setSelectedOutputDeviceId((current) => current && outputs.some((device) => device.deviceId === current) ? current : '');
    return { inputs, outputs };
  }, []);

  useEffect(() => { void refreshAudioDevices().catch(() => setAudioPermissionStatus('unsupported')); }, [refreshAudioDevices]);

  useEffect(() => {
    if (!meetingId) return;
    const preference = getMeetingAudioPreference(meetingId);
    if (!preference) return;
    setSelectedInputDeviceId(preference.inputDeviceId || '');
    setSelectedOutputDeviceId(preference.outputDeviceId || '');
    setAudioPermissionStatus(preference.permissionStatus || 'unknown');
    setAudioTestStatus(hasConfirmedMeetingAudioPreference(preference) ? 'confirmed' : 'idle');
  }, [meetingId]);

  useEffect(() => {
    let cancelled = false;
    Promise.allSettled([
      glossaryClient.listEntries(),
      mode === 'edit' && meetingId ? readClient.getMeetingDetail(meetingId) : Promise.resolve(null)
    ]).then(([glossaryResult, meetingResult]) => {
      if (cancelled) return;

      const glossaryEntries = glossaryResult.status === 'fulfilled' ? glossaryResult.value : [];
      setEntries(glossaryEntries);
      if (glossaryResult.status === 'rejected') {
        setGlossaryLoadWarning('共用詞彙目前無法載入，仍可使用私人詞彙。');
      } else {
        setGlossaryLoadWarning('');
      }

      if (meetingResult.status === 'rejected') {
        setError(meetingApiErrorMessage(meetingResult.reason, '無法載入會議設定。'));
        setIsLoading(false);
        return;
      }

      const detail = meetingResult.value;
      const current = detail?.meeting || null;
      if (mode === 'edit' && !current) {
        setError(meetingApiErrorMessage({ code: 'meeting_not_found' }, '無法載入會議設定。'));
        setIsLoading(false);
        return;
      }
      if (current) applyMeeting(current, glossaryEntries);
      if (current?.id) managementClient.listMembers(current.id).then(setMembers).catch(() => setMembers([]));
      setIsLoading(false);
    }).catch((loadError) => {
      if (!cancelled) {
        setError(meetingApiErrorMessage(loadError, '無法載入會議設定。'));
        setIsLoading(false);
      }
    });
    return () => { cancelled = true; };
  }, [glossaryClient, managementClient, meetingId, mode, readClient]);

  useEffect(() => {
    if (isLoading || typeof window === 'undefined' || !('IntersectionObserver' in window)) return undefined;
    const sections = [
      ...settingsSectionRefs.current.slice(0, SHARE_SETTINGS_STEP_INDEX).map((section, index) => ({ section, stepIndex: index })),
      { section: shareSectionRef.current, stepIndex: SHARE_SETTINGS_STEP_INDEX },
      { section: settingsSectionRefs.current[MEMBER_SETTINGS_STEP_INDEX], stepIndex: MEMBER_SETTINGS_STEP_INDEX },
    ].filter(({ section }) => section);
    if (!sections.length) return undefined;
    const headerOffset = 112;
    const initialStepLockDistance = 80;
    const focusLineRatio = 0.4;
    const observer = new IntersectionObserver(() => {
      if (window.scrollY <= initialStepLockDistance) {
        setActiveStep(0);
        return;
      }
      const scrollElement = document.scrollingElement || document.documentElement;
      const isAtBottom = window.innerHeight + window.scrollY >= scrollElement.scrollHeight - 2;
      if (isAtBottom) {
        setActiveStep(sections[sections.length - 1].stepIndex);
        return;
      }
      const focusY = Math.max(headerOffset, window.innerHeight * focusLineRatio);
      const sectionRects = sections.map((item) => ({ ...item, rect: item.section.getBoundingClientRect() }));
      const focusedSection = sectionRects.find(({ rect }) => rect.top <= focusY && rect.bottom > focusY);
      if (focusedSection) {
        setActiveStep(focusedSection.stepIndex);
        return;
      }
      const nearestSection = sectionRects
        .map((item) => ({ ...item, distance: item.rect.top > focusY ? item.rect.top - focusY : item.rect.bottom < focusY ? focusY - item.rect.bottom : 0 }))
        .sort((left, right) => left.distance - right.distance)[0];
      if (nearestSection) setActiveStep(nearestSection.stepIndex);
    }, { rootMargin: `-${headerOffset}px 0px -60% 0px`, threshold: [0, 0.25, 0.5] });
    sections.forEach(({ section }) => observer.observe(section));
    return () => observer.disconnect();
  }, [isLoading, meeting]);

  useEffect(() => {
    const readyToScroll = shareState === 'error' || (shareState === 'ready' && shareLayoutReady);
    if (mode !== 'create' || !meeting?.id || !readyToScroll || autoScrolledMeetingIdRef.current === meeting.id) {
      return undefined;
    }

    autoScrolledMeetingIdRef.current = meeting.id;
    let firstFrameId = window.requestAnimationFrame(() => {
      window.requestAnimationFrame(() => {
        scrollToSubmitRow();
        window.requestAnimationFrame(() => setActiveStep(SHARE_SETTINGS_STEP_INDEX));
      });
    });

    return () => {
      window.cancelAnimationFrame(firstFrameId);
      firstFrameId = null;
    };
  }, [meeting?.id, mode, shareLayoutReady, shareState]);

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
      const viewerShares = loadedShares.filter((share) => share.role === 'viewer');
      setShares(viewerShares);
      const displayableShares = await Promise.all(viewerShares.filter((share) => share.codeUrl).map(prepareShareForDisplay));
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

  async function previewPrivateGlossaryImport(event) {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;
    const format = file.name.toLowerCase().endsWith('.json') ? 'json' : file.name.toLowerCase().endsWith('.xlsx') ? 'xlsx' : file.name.toLowerCase().endsWith('.csv') ? 'csv' : null;
    if (!format) { setError('請選擇 CSV、JSON 或 XLSX 檔案。'); return; }
    setIsPrivateImporting(true);
    setError('');
    try {
      const content = format === 'xlsx' ? arrayBufferToBase64(await file.arrayBuffer()) : await file.text();
      const preview = await managementClient.previewPrivateGlossaryImport({ format, content, sourceLanguageCode, targetLanguageCode, existingEntries: privateGlossaryEntries });
      setPrivateImportFile({ name: file.name, format, content });
      setPrivateImportPreview(preview);
      setPrivateImportResolutions({});
      setPrivateImportSelectedRows(defaultSelectedPrivateImportRows(preview));
    } catch (requestError) {
      setError(requestError?.message || '無法預覽匯入檔案。');
    } finally {
      setIsPrivateImporting(false);
    }
  }

  function openPrivateImportDialog() {
    setError('');
    setPrivateImportFile(null);
    setPrivateImportPreview(null);
    setPrivateImportSelectedRows([]);
    setPrivateImportResolutions({});
    setIsPrivateImportOpen(true);
  }

  function closePrivateImportDialog() {
    if (isPrivateImporting) return;
    setIsPrivateImportOpen(false);
    setPrivateImportFile(null);
    setPrivateImportPreview(null);
    setPrivateImportSelectedRows([]);
    setPrivateImportResolutions({});
  }

  function commitPrivateGlossaryImport() {
    if (!privateImportPreview) return;
    const nextEntries = [...privateGlossaryEntries];
    for (const row of privateImportPreview.rows || []) {
      if (!privateImportSelectedRows.includes(row.rowNumber) || row.status === 'duplicate' || row.errors?.length > 0) continue;
      const source = row.entry.source.trim();
      const existingIndex = nextEntries.findIndex((entry) => entry.source === source);
      if (row.status === 'conflict' && privateImportResolutions[String(row.rowNumber)] !== 'update') continue;
      const existing = existingIndex >= 0 ? nextEntries[existingIndex] : null;
      const nextEntry = {
        ...(existing || {}),
        source,
        translations: { ...(existing?.translations || {}), [targetLanguageCode]: row.entry.translations[targetLanguageCode] },
        replacementAliases: { ...(existing?.replacementAliases || {}) }
      };
      if (existingIndex >= 0) nextEntries[existingIndex] = nextEntry;
      else nextEntries.push(nextEntry);
    }
    setPrivateGlossaryEntries(nextEntries);
    setNotice('匯入詞彙已加入表單，請儲存會議設定以套用。');
    closePrivateImportDialog();
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
      setShareLayoutReady(false);
      setShareState('loading');
      const results = [];
      const roles = ['viewer'];
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
          setError(meetingManagementErrorMessage(lastError, '會議已建立，但分享連結產生失敗；請稍後重試。'));
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
    if (!name.trim()) {
      const message = '請輸入會議名稱。';
      setNameError(message);
      setError('');
      nameInputRef.current?.scrollIntoView({ behavior: 'smooth', block: 'center' });
      nameInputRef.current?.focus();
      return;
    }
    setNameError('');
    setAudioSettingsError('');
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
      if (!meeting && audioTestStatus === 'confirmed') {
        setMeetingAudioPreference(saved.id, {
          inputDeviceId: selectedInputDeviceId,
          outputDeviceId: selectedOutputDeviceId,
          permissionStatus: 'confirmed'
        });
      }
      setMeeting(saved);
      setNotice(meeting ? '會議設定已更新。' : '會議已建立，正在產生分享連結…');
      if (!meeting) await createSharesWithRetry(saved.id);
      else setShareState('ready');
    } catch (requestError) {
      setError(meetingManagementErrorMessage(requestError, '無法儲存會議設定，請稍後再試。'));
    } finally {
      setIsSaving(false);
    }
  }

  async function confirmAudioSettings() {
    if (!navigator.mediaDevices?.getUserMedia) {
      setAudioPermissionStatus('unsupported');
      setAudioTestStatus('error');
      setError('此瀏覽器不支援麥克風測試。');
      return;
    }
    setAudioTestStatus('testing');
    setAudioSettingsError('');
    setError('');
    try {
      const stream = await requestAudioInputStream(selectedInputDeviceId);
      stream.getTracks?.().forEach((track) => track.stop?.());
      const refreshed = await refreshAudioDevices() || { inputs: [], outputs: [] };
      const selectedInput = refreshed.inputs.find((device) => device.deviceId === selectedInputDeviceId);
      const selectedOutput = refreshed.outputs.find((device) => device.deviceId === selectedOutputDeviceId);
      const audioPreferenceMeetingId = meeting?.id || meetingId;
      const saved = !audioPreferenceMeetingId || setMeetingAudioPreference(audioPreferenceMeetingId, {
        inputDeviceId: selectedInput?.deviceId || '',
        outputDeviceId: supportsAudioContextOutputSelection() ? selectedOutput?.deviceId || '' : '',
        inputDeviceLabel: selectedInput?.label || '瀏覽器預設麥克風',
        outputDeviceLabel: supportsAudioContextOutputSelection() ? selectedOutput?.label : '瀏覽器預設揚聲器',
        permissionStatus: 'confirmed'
      });
      if (!saved) throw new Error('storage_unavailable');
      setAudioPermissionStatus('granted');
      setAudioTestStatus('confirmed');
      setNotice('音訊裝置已確認，開始錄製時會使用這組設定。');
    } catch (requestError) {
      const denied = requestError?.name === 'NotAllowedError' || requestError?.name === 'SecurityError';
      setAudioPermissionStatus(denied ? 'denied' : 'error');
      setAudioTestStatus('error');
      setError(denied ? '麥克風權限被拒絕，請在瀏覽器設定中允許後再試。' : requestError?.name === 'NotFoundError' || requestError?.name === 'OverconstrainedError' ? '找不到所選麥克風，請重新選擇後再確認。' : '無法確認音訊裝置，請稍後再試。');
    }
  }

  async function openLive() {
    const preference = getMeetingAudioPreference(meeting?.id || meetingId);
    if (!hasConfirmedMeetingAudioPreference(preference)) {
      setError('請先在音訊設定完成麥克風確認，再開始錄製。');
      setAudioSettingsError('請先測試並確認麥克風權限。');
      focusAudioSettings();
      return;
    }
    const devices = await navigator.mediaDevices?.enumerateDevices?.() || [];
    if (preference.inputDeviceId && !audioInputDevices(devices).some((device) => device.deviceId === preference.inputDeviceId)) {
      setError('所選麥克風已不存在，請重新確認音訊設定。');
      setAudioTestStatus('error');
      setAudioSettingsError('所選麥克風已不存在，請重新確認音訊設定。');
      focusAudioSettings();
      return;
    }
    onOpenLive(meeting?.id || meetingId);
  }

  async function retryShares() {
    setError('');
    await createSharesWithRetry();
  }

  async function revokeShare(shareId) {
    if (!canRevokeShares) return;
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
  const settingsSummary = `${sourceLanguageLabel} → ${targetLanguageLabel} · ${echoTargetLanguage ? '播放翻譯聲音' : '不播放翻譯聲音'} · 會議詞彙 ${privateGlossaryEntries.length} 筆`;

  function scrollToSettingsStep(index) {
    const section = index === SHARE_SETTINGS_STEP_INDEX
      ? shareSectionRef.current
      : settingsSectionRefs.current[index];
    if (!section) return;
    setActiveStep(index);
    section.scrollIntoView({
      behavior: window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth',
      block: 'center'
    });
  }

  function focusAudioSettings() {
    setActiveStep(2);
    window.requestAnimationFrame(() => {
      const section = settingsSectionRefs.current[2];
      section?.scrollIntoView({ behavior: 'auto', block: 'start' });
      window.requestAnimationFrame(() => audioConfirmButtonRef.current?.focus());
    });
  }

  function scrollToSubmitRow() {
    const row = submitRowRef.current;
    if (!row) return;
    const reducedMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
    const bottomPadding = 24;
    const rowBottom = row.getBoundingClientRect().bottom + window.scrollY;
    const targetScrollTop = Math.max(0, rowBottom - window.innerHeight + bottomPadding);
    window.scrollTo({ top: targetScrollTop, behavior: reducedMotion ? 'auto' : 'smooth' });
  }

  const handleShareLayoutReady = useCallback(() => setShareLayoutReady(true), []);
  const canManageMembers = meeting?.permissions?.canManageMembers !== false;
  const canRevokeShares = meeting?.permissions?.canManageShares !== false;
  async function inviteMember() {
    if (!canManageMembers) return;
    const email = memberEmail.trim();
    if (!email || !meeting?.id) return;
    setMemberBusy(`invite:${email}`); setMemberNotice(''); setMemberError('');
    try { const member = await managementClient.addMember(meeting.id, email); setMembers((current) => current.some((item) => item.userId === member.userId) ? current : [...current, member]); setMemberEmail(''); setMemberNotice('成員已加入。'); }
    catch { setMemberError('無法邀請成員，請確認 email 對應到 active 帳號。'); }
    finally { setMemberBusy(''); }
  }
  async function removeMember(userId) {
    if (!canManageMembers || !meeting?.id) return;
    setMemberBusy(`remove:${userId}`); setMemberNotice(''); setMemberError('');
    try { await managementClient.removeMember(meeting.id, userId); setMembers((current) => current.filter((item) => item.userId !== userId)); setMemberNotice('成員已移除。'); }
    catch { setMemberError('無法移除成員。'); }
    finally { setMemberBusy(''); }
  }
  async function updateMemberRecording(member) {
    if (!canManageMembers || !meeting?.id) return;
    setMemberBusy(`record:${member.userId}`); setMemberNotice(''); setMemberError('');
    try {
      const updated = await managementClient.updateMemberRecording(meeting.id, member.userId, member.canRecord === false);
      setMembers((current) => current.map((item) => item.userId === member.userId ? { ...item, ...updated } : item));
      setMemberNotice(updated?.canRecord === false ? '已停用該成員的錄製權限。' : '已開啟該成員的錄製權限。');
    } catch { setMemberError('無法更新成員錄製權限。'); }
    finally { setMemberBusy(''); }
  }
  const hasAudioOutputSelection = supportsAudioContextOutputSelection();

  if (isLoading) return <section className="feature-page meeting-settings-page"><p>正在載入會議設定…</p></section>;

  return (
    <section className="feature-page meeting-settings-page" aria-labelledby="meeting-settings-title">
      {error ? <p className="error-message" role="alert">{error}</p> : null}
      {notice ? <p className="success-message" role="status">{notice}</p> : null}
      <div className="meeting-settings-layout meeting-management-grid">
        <nav className="meeting-settings-steps" aria-label="會議設定步驟">
          {MEETING_SETTINGS_STEPS.map((label, index) => (!meeting && index >= SHARE_SETTINGS_STEP_INDEX ? null : <button className={`meeting-settings-step${index === activeStep ? ' is-active' : ''}`} type="button" aria-current={index === activeStep ? 'step' : undefined} onClick={() => scrollToSettingsStep(index)} key={label}><span>{index + 1}</span><strong>{label}</strong></button>))}
        </nav>
        <section className="meeting-settings-form control-panel" aria-label="會議設定表單">
          <section className="meeting-settings-card" ref={(node) => { settingsSectionRefs.current[0] = node; }} aria-labelledby="meeting-basic-settings-title">
            <div className="meeting-settings-card-header"><div><p className="eyebrow">步驟 1</p><h3 id="meeting-basic-settings-title">基本資訊</h3></div><span className="meeting-settings-card-number">1</span></div>
            <label className={`field meeting-name-field${nameError ? ' has-error' : ''}`}><span>會議名稱 <em aria-hidden="true">*</em><span className="sr-only">（必填）</span></span><input ref={nameInputRef} value={name} onChange={(event) => { setName(event.target.value); if (nameError && event.target.value.trim()) setNameError(''); }} placeholder="例如：產品會議" maxLength={120} disabled={meeting?.status === 'completed'} required aria-invalid={nameError ? 'true' : 'false'} aria-describedby={nameError ? 'meeting-name-error' : undefined} />{nameError ? <small id="meeting-name-error" className="field-error" role="alert">{nameError}</small> : <small>建立後可分享會議連結給參與者。</small>}</label>
          </section>

          <section className="meeting-settings-card" ref={(node) => { settingsSectionRefs.current[1] = node; }} aria-labelledby="meeting-language-settings-title">
            <div className="meeting-settings-card-header"><div><p className="eyebrow">步驟 2</p><h3 id="meeting-language-settings-title">語言設定</h3></div><span className="meeting-settings-card-number">2</span></div>
            <div className="meeting-language-fields"><label className="field"><span>主要輸入語言</span><select value={sourceLanguageCode} onChange={(event) => setSourceLanguageCode(event.target.value)} disabled={meeting?.status === 'completed'}>{SUPPORTED_LANGUAGES.map((item) => <option key={item.code} value={item.code}>{item.label}</option>)}</select></label><span className="meeting-language-direction" aria-label="翻譯方向"><ArrowRight size={20} aria-hidden="true" /></span><label className="field"><span>目標語言</span><select value={targetLanguageCode} onChange={(event) => setTargetLanguageCode(event.target.value)} disabled={meeting?.status === 'completed'}>{SUPPORTED_LANGUAGES.map((item) => <option key={item.code} value={item.code}>{item.label}</option>)}</select></label></div>
          </section>

          <section className="meeting-settings-card" ref={(node) => { settingsSectionRefs.current[2] = node; }} aria-labelledby="meeting-audio-settings-title">
            <div className="meeting-settings-card-header"><div><p className="eyebrow">步驟 3</p><h3 id="meeting-audio-settings-title">音訊設定</h3></div><span className="meeting-settings-card-number">3</span></div>
            <div className="meeting-audio-options"><label className="meeting-audio-option"><span className="meeting-settings-icon"><Volume2 size={19} aria-hidden="true" /></span><span><strong>播放翻譯聲音</strong><small>讓參與者聽見即時翻譯結果。</small></span><span className="meeting-toggle"><input type="checkbox" checked={echoTargetLanguage} onChange={(event) => setEchoTargetLanguage(event.target.checked)} disabled={meeting?.status === 'completed'} /><span aria-hidden="true" /></span></label><label className="meeting-audio-option"><span className="meeting-settings-icon"><Mic size={19} aria-hidden="true" /></span><span><strong>保存原始聲音</strong><small>保存會議中的原始麥克風音訊。</small></span><span className="meeting-toggle"><input type="checkbox" checked={shouldRecordInputAudio} onChange={(event) => setShouldRecordInputAudio(event.target.checked)} disabled={meeting?.status === 'completed'} /><span aria-hidden="true" /></span></label></div>
            <div className={`meeting-audio-controls${audioSettingsError ? ' has-error' : ''}`}>
              <div className={`meeting-audio-device-grid${hasAudioOutputSelection ? ' has-speaker' : ' microphone-only'}`}>
              <label className="field"><span>麥克風</span><select aria-label="選擇會議麥克風" value={selectedInputDeviceId} onChange={(event) => { setSelectedInputDeviceId(event.target.value); setAudioTestStatus('idle'); setAudioPermissionStatus('unknown'); setAudioSettingsError(''); clearMeetingAudioPreference(meeting?.id || meetingId); }} disabled={meeting?.status === 'completed'}><option value="">瀏覽器預設麥克風</option>{audioInputs.map((device) => <option key={device.deviceId} value={device.deviceId}>{device.label}</option>)}</select></label>
              {hasAudioOutputSelection ? <label className="field"><span>揚聲器</span><select aria-label="選擇會議揚聲器" value={selectedOutputDeviceId} onChange={(event) => setSelectedOutputDeviceId(event.target.value)} disabled={meeting?.status === 'completed'}><option value="">瀏覽器預設揚聲器</option>{audioOutputs.map((device) => <option key={device.deviceId} value={device.deviceId}>{device.label}</option>)}</select></label> : null}
              </div>
              <button ref={audioConfirmButtonRef} className={`button secondary${audioSettingsError ? ' has-error' : ''}`} type="button" onClick={() => void confirmAudioSettings()} disabled={audioTestStatus === 'testing' || meeting?.status === 'completed'} aria-invalid={audioSettingsError ? 'true' : 'false'} aria-describedby={audioSettingsError ? 'meeting-audio-settings-error' : undefined}>{audioTestStatus === 'testing' ? '測試中…' : '測試並確認音訊'}</button>
              {audioSettingsError ? <small id="meeting-audio-settings-error" className="field-error" role="alert">{audioSettingsError}</small> : null}
              <MeetingAudioStatus audioTestStatus={audioTestStatus} audioPermissionStatus={audioPermissionStatus} />
            </div>
          </section>

          <section className="meeting-settings-card" ref={(node) => { settingsSectionRefs.current[3] = node; }} aria-labelledby="meeting-dictionary-settings-title">
            <div className="meeting-settings-card-header"><div><p className="eyebrow">步驟 4</p><h3 id="meeting-dictionary-settings-title">詞彙設定</h3><p className="meeting-settings-card-description">設定本場會議中需要固定翻譯的專有名詞。</p></div><span className="meeting-settings-card-number">4</span></div>
            <div className="meeting-dictionary-groups">
              <section className="meeting-dictionary-group meeting-global-glossary" aria-labelledby="meeting-global-glossary-title">
                <button className="meeting-global-glossary-summary" type="button" aria-expanded={isGlobalGlossaryExpanded} onClick={() => setIsGlobalGlossaryExpanded((current) => !current)}><span className="meeting-settings-icon"><BookOpen size={18} aria-hidden="true" /></span><span><strong id="meeting-global-glossary-title">共用詞彙</strong><small>{availableGlossaryEntries.length === 0 ? '目前沒有可套用的共用詞彙。' : `已選 ${selectedGlossaryCount} 項，共 ${availableGlossaryEntries.length} 項可用`}</small></span><ChevronDown size={18} aria-hidden="true" /></button>
                {isGlobalGlossaryExpanded ? <div className="meeting-global-glossary-content"><p className="meeting-dictionary-section-description">從共用詞彙中選擇要套用到本場會議的項目。</p>{glossaryLoadWarning ? <p className="warning-message" role="status">{glossaryLoadWarning}</p> : null}{availableGlossaryEntries.map((entry) => <label className={`glossary-choice${selectedGlossaryIds.includes(entry.id) ? ' is-selected' : ''}`} key={entry.id}><input type="checkbox" aria-label={`套用詞彙：${entry.source}`} checked={selectedGlossaryIds.includes(entry.id)} onChange={() => setSelectedGlossaryIds((current) => current.includes(entry.id) ? current.filter((id) => id !== entry.id) : [...current, entry.id])} disabled={meeting?.status === 'completed'} /><span className="glossary-choice-content"><span className="glossary-choice-field"><small>聽到的詞彙</small><strong>{entry.source}</strong></span><span className="glossary-choice-field"><small>要顯示／播放的翻譯</small><strong>{entry.translations[targetLanguageCode]}</strong></span></span></label>)}{availableGlossaryEntries.length === 0 ? <p className="export-note">目前沒有可套用的共用詞彙。</p> : null}</div> : null}
              </section>
              <section className="meeting-dictionary-group meeting-private-glossary" aria-labelledby="meeting-private-glossary-title">
                <div className="meeting-dictionary-section-heading"><div><h4 id="meeting-private-glossary-title">會議詞彙</h4><p className="meeting-settings-card-description">只套用於本場會議，不會影響其他會議。</p></div>{meeting?.status !== 'completed' ? <button className="button secondary" type="button" onClick={openPrivateImportDialog}><Download size={16} aria-hidden="true" />匯入詞彙</button> : null}</div>
                <div className="meeting-private-glossary-list">{privateGlossaryEntries.map((entry) => <div className="meeting-private-entry" key={entry.source}><div className="meeting-private-entry-fields"><div><span>聽到的詞彙</span><strong>{entry.source}</strong></div><div><span>要顯示／播放的翻譯</span><strong>{entry.translations?.[targetLanguageCode] || '尚未設定目前語言翻譯'}</strong></div></div>{meeting?.status !== 'completed' ? <span className="meeting-actions"><button className="button detail-button" type="button" aria-label={`編輯 ${entry.source}`} onClick={() => { setEditingPrivateSource(entry.source); setPrivateSource(entry.source); setPrivateTranslation(entry.translations?.[targetLanguageCode] || ''); }}><Pencil size={15} aria-hidden="true" /><span className="sr-only">編輯</span></button><button className="button detail-button danger-button" type="button" aria-label={`刪除 ${entry.source}`} onClick={() => setPrivateGlossaryEntries((current) => current.filter((item) => item.source !== entry.source))}><Trash2 size={15} aria-hidden="true" /><span className="sr-only">刪除</span></button></span> : null}</div>)}{meeting?.status !== 'completed' ? <div className="glossary-quick-add"><div className="meeting-private-entry-fields"><label className="field"><span>聽到的詞彙</span><input value={privateSource} onChange={(event) => setPrivateSource(event.target.value)} placeholder="例如：產品名稱" /></label><label className="field"><span>要顯示／播放的翻譯</span><input value={privateTranslation} onChange={(event) => setPrivateTranslation(event.target.value)} placeholder="例如：Product Name" /></label></div><button className="button secondary meeting-add-private-button" type="button" onClick={savePrivateEntry} disabled={!privateSource.trim() || !privateTranslation.trim()}><Plus size={16} aria-hidden="true" />{editingPrivateSource ? '更新會議詞彙' : '新增會議詞彙'}</button></div> : null}</div>
              </section>
            </div>
          </section>

          {meeting ? <ShareResults sectionRef={shareSectionRef} shares={createdShares} existingShares={shares} state={shareState} onRetry={retryShares} onRevokeShare={revokeShare} onCopy={copy} locked={meeting.status === 'completed' || !canRevokeShares} onLayoutReady={handleShareLayoutReady} /> : null}
        {meeting ? <section className="meeting-settings-card" ref={(node) => { settingsSectionRefs.current[MEMBER_SETTINGS_STEP_INDEX] = node; }} aria-labelledby="meeting-members-title">
          <div className="meeting-settings-card-header"><div><p className="eyebrow">步驟 6</p><h3 id="meeting-members-title">成員與錄製權限</h3><p className="meeting-settings-card-description">邀請成員並設定錄製權限；會議擁有者仍可管理會議設定、分享與匯出。</p></div><span className="meeting-settings-card-number">6</span></div>
          {memberError ? <p className="error-message" role="alert">{memberError}</p> : null}
          {memberNotice ? <p className="success-message" role="status">{memberNotice}</p> : null}
          <div className="meeting-member-invite"><input type="email" value={memberEmail} onChange={(event) => setMemberEmail(event.target.value)} placeholder="請輸入成員電子郵件" aria-label="成員電子郵件" /><button className="button secondary" type="button" onClick={() => void inviteMember()} disabled={!memberEmail.trim() || Boolean(memberBusy)}>邀請成員</button></div>
          {members.length === 0 ? <p className="export-note">目前尚未加入其他成員。你仍可錄製自己建立的會議；若要讓其他成員錄製，請先輸入電子郵件地址並送出邀請。</p> : <div className="meeting-member-list" aria-label="會議成員">
            <p className="meeting-member-helper">關閉錄製權限後仍會保留成員關係。</p>
            {members.map((member) => <div className="meeting-member-row" key={member.userId}>
              <span className="meeting-member-identity">{member.email || member.userId}</span>
              <div className="meeting-member-actions">
                <label className="meeting-recording-permission"><input type="checkbox" aria-label={`允許 ${member.email || member.userId} 錄製`} checked={member.canRecord !== false} onChange={() => void updateMemberRecording(member)} disabled={Boolean(memberBusy) || meeting.status === 'completed'} /><span>允許錄製</span></label>
                <button className="button detail-button danger-button" type="button" onClick={() => void removeMember(member.userId)} disabled={Boolean(memberBusy)}>移除</button>
              </div>
            </div>)}
          </div>}
        </section> : null}


          <div ref={submitRowRef} className="meeting-settings-actions meeting-settings-submit-row"><p className="meeting-settings-summary">{settingsSummary}</p><div className="meeting-settings-action-buttons"><button className="button primary" type="button" onClick={saveMeeting} disabled={isSaving || meeting?.status === 'completed'}>{isSaving ? '儲存中…' : meeting ? '儲存變更' : '建立會議'}</button>{meeting ? <button className="button secondary" type="button" onClick={() => void openLive()}>前往即時字幕</button> : null}</div></div>
        </section>
      </div>
      {isPrivateImportOpen ? <PrivateGlossaryImportDialog file={privateImportFile} preview={privateImportPreview} selectedRows={privateImportSelectedRows} resolutions={privateImportResolutions} isImporting={isPrivateImporting} onFileChange={previewPrivateGlossaryImport} onClose={closePrivateImportDialog} onSelectedRowsChange={setPrivateImportSelectedRows} onResolutionsChange={setPrivateImportResolutions} onCommit={commitPrivateGlossaryImport} targetLanguageCode={targetLanguageCode} /> : null}
    </section>
  );
}

function MeetingAudioStatus({ audioTestStatus, audioPermissionStatus }) {
  const isConfirmed = audioTestStatus === 'confirmed';
  const isTesting = audioTestStatus === 'testing';
  const isDenied = audioPermissionStatus === 'denied';
  const Icon = isConfirmed ? CheckCircle2 : isTesting ? LoaderCircle : isDenied ? AlertCircle : CircleDashed;
  const statusClass = isConfirmed ? 'is-confirmed' : isTesting ? 'is-testing' : isDenied ? 'is-denied' : 'is-pending';
  const label = isConfirmed ? '已確認' : isTesting ? '測試中…' : isDenied ? '權限被拒絕' : '尚未確認';

  return <span className={`meeting-audio-status ${statusClass}`} role="status"><Icon className="meeting-audio-status-icon" size={15} aria-hidden="true" /><span>{label}</span></span>;
}

function PrivateGlossaryImportDialog({ file, preview, selectedRows, resolutions, isImporting, onFileChange, onClose, onSelectedRowsChange, onResolutionsChange, onCommit, targetLanguageCode }) {
  const selectableRows = (preview?.rows || []).filter((row) => row.errors?.length === 0 && row.status !== 'duplicate');
  const allSelected = selectableRows.length > 0 && selectableRows.every((row) => selectedRows.includes(row.rowNumber));
  return <><div className="global-glossary-dialog-backdrop" onClick={onClose} aria-hidden="true" /><section className={`global-glossary-dialog ${preview ? 'glossary-import-dialog' : 'glossary-import-help-dialog'}`} role="dialog" aria-modal="true" aria-labelledby="meeting-glossary-import-title"><div className="global-glossary-dialog-header"><div><p className="eyebrow">{preview ? 'IMPORT PREVIEW' : 'IMPORT FORMAT'}</p><h2 id="meeting-glossary-import-title">{preview ? `預覽匯入：${file?.name}` : '匯入會議詞彙'}</h2>{preview ? <p className="category-management-summary">共 {preview.summary.total} 筆，新增 {preview.summary.creates} 筆，重複 {preview.summary.duplicates} 筆，錯誤 {preview.summary.invalid} 筆；已選 {selectedRows.length} 筆</p> : null}</div><button className="icon-button" type="button" aria-label="關閉匯入會議詞彙" onClick={onClose} disabled={isImporting}><X size={20} aria-hidden="true" /></button></div>{preview ? <><div className="glossary-import-settings"><p className="meeting-dictionary-section-description">目前設定：{targetLanguageCode}；錯誤與重複列會自動略過。</p></div><div className="glossary-import-preview-list"><div className="glossary-import-selection-bar"><label><input type="checkbox" aria-label="全選可匯入項目" checked={allSelected} onChange={() => onSelectedRowsChange(allSelected ? [] : selectableRows.map((row) => row.rowNumber))} disabled={isImporting} />全選／取消全選</label><span>匯入結果會先加入表單，儲存後才套用</span></div>{preview.rows.map((row) => <div className={`glossary-import-row is-${row.status}${selectedRows.includes(row.rowNumber) ? ' is-selected' : ''}`} key={row.rowNumber}><label className="glossary-import-row-selection"><input type="checkbox" aria-label={`選取第 ${row.rowNumber} 列`} checked={selectedRows.includes(row.rowNumber)} onChange={() => onSelectedRowsChange(selectedRows.includes(row.rowNumber) ? selectedRows.filter((number) => number !== row.rowNumber) : [...selectedRows, row.rowNumber])} disabled={isImporting || row.errors?.length > 0 || row.status === 'duplicate'} /><span /></label><div><strong>第 {row.rowNumber} 列{row.errors?.map((item) => <small className="error-message" key={item}>{privateGlossaryImportRowErrorMessage(item)}</small>)}</strong>{row.warnings?.map((item) => <small className="warning-message" key={item}>{privateGlossaryImportRowErrorMessage(item)}</small>)}<span className="import-entry-preview"><strong>{row.entry?.source || '未提供原文'}</strong><span className="import-entry-arrow" aria-hidden="true">→</span><span className="import-entry-translation">{row.entry?.translations?.[targetLanguageCode] || '未提供翻譯'}</span></span></div>{row.status === 'conflict' ? <label className="field"><span>重複處理</span><select aria-label={`第 ${row.rowNumber} 列重複處理`} value={resolutions[String(row.rowNumber)] || ''} onChange={(event) => onResolutionsChange((current) => ({ ...current, [row.rowNumber]: event.target.value }))}><option value="">請選擇</option><option value="update">更新會議詞彙</option><option value="skip">跳過</option></select></label> : <span>{row.status === 'create' ? '新增' : row.status === 'duplicate' ? '重複，略過' : '錯誤，略過'}</span>}</div>)}</div><div className="global-glossary-dialog-actions"><button className="button secondary" type="button" onClick={onClose} disabled={isImporting}>取消</button><button className="button primary" type="button" onClick={onCommit} disabled={isImporting || selectedRows.length === 0 || preview.rows.some((row) => selectedRows.includes(row.rowNumber) && row.status === 'conflict' && !resolutions[String(row.rowNumber)])}>{isImporting ? '處理中…' : '加入會議詞彙'}</button></div></> : <div className="glossary-import-help-content"><p>支援 CSV、JSON 與 XLSX。每筆資料只需要原文與翻譯；來源語言、目標語言與分類會在選檔後設定。</p><h3>XLSX 格式</h3><p>第一個工作表的第一列請使用 <code>source</code> 與 <code>translation</code> 欄位，資料從第二列開始。</p><h3>CSV 範例</h3><pre><code>{'source,translation\n產品名稱,Product name\n會議室,Meeting room\n翻譯結果,Translation result'}</code></pre><h3>JSON 範例</h3><pre><code>{'{\n  "entries": [\n    { "source": "產品名稱", "translation": "Product name" },\n    { "source": "會議室", "translation": "Meeting room" },\n    { "source": "翻譯結果", "translation": "Translation result" }\n  ]\n}'}</code></pre><p className="export-note">每次匯入使用目前會議的來源語言與目標語言；資料會先加入表單，按下儲存會議設定後才會寫入本場會議。</p><div className="global-glossary-dialog-actions"><input className="sr-only" type="file" accept=".csv,.json,.xlsx,text/csv,application/json,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" id="meeting-glossary-import-file" onChange={onFileChange} /><label className="button primary" htmlFor="meeting-glossary-import-file">選擇 CSV／JSON／XLSX 檔案</label><button className="button secondary" type="button" onClick={onClose}>取消</button></div></div>}</section></>;
}

function defaultSelectedPrivateImportRows(preview = {}) {
  return (preview.rows || []).filter((row) => row.errors?.length === 0 && row.status !== 'duplicate').map((row) => row.rowNumber);
}

function privateGlossaryImportRowErrorMessage(message) {
  const text = String(message || '');
  if (text === 'Import contains a duplicate source term.') return '來源詞重複。';
  if (text.includes('source must be')) return '來源詞不可為空白。';
  if (text.includes('translation must be')) return '翻譯內容不可為空白。';
  return '資料格式不正確。';
}

function arrayBufferToBase64(buffer) {
  let binary = '';
  const bytes = new Uint8Array(buffer);
  for (let index = 0; index < bytes.length; index += 1) binary += String.fromCharCode(bytes[index]);
  return window.btoa(binary);
}

function ShareResults({ sectionRef, shares, existingShares, state, onRetry, onRevokeShare, onCopy, locked, onLayoutReady }) {
  useEffect(() => {
    if (state !== 'ready' || shares.length === 0) return undefined;
    let cancelled = false;
    const images = [...(sectionRef.current?.querySelectorAll('img') || [])];
    const waitForImage = (image) => {
      if (image.complete) return image.decode?.().catch(() => undefined) || Promise.resolve();
      return new Promise((resolve) => {
        const finish = () => resolve();
        image.addEventListener('load', finish, { once: true });
        image.addEventListener('error', finish, { once: true });
      });
    };
    Promise.all(images.map(waitForImage)).then(() => {
      if (!cancelled) onLayoutReady();
    });
    return () => { cancelled = true; };
  }, [onLayoutReady, sectionRef, shares, state]);

  return (
    <section ref={sectionRef} className="control-panel meeting-settings-card meeting-share-results" aria-labelledby="meeting-share-results-title">
      <div className="meeting-settings-card-header">
        <div>
        <p className="eyebrow">步驟 5</p>
          <h3 id="meeting-share-results-title">分享會議</h3>
          <p className="meeting-settings-card-description">觀看連結提供會議字幕的唯讀檢視。</p>
        </div>
        <span className="meeting-settings-card-number">5</span>
      </div>
      {state === 'loading' ? <p>正在產生分享連結…</p> : null}
      {state === 'error' ? <><p className="error-message">部分分享連結尚未產生。</p><button className="button secondary" type="button" onClick={onRetry}>重新產生分享</button></> : null}
      {shares.length > 0 ? <div className="meeting-share-links">{shares.map((item) => <article className="share-result" key={item.role}><div className="share-result-preview"><img src={item.qrDataUrl} alt="觀看入口 QR Code" width="180" height="180" /></div><div className="share-result-details"><h4>觀看連結</h4><p className="share-url"><a href={item.absoluteUrl} target="_blank" rel="noopener noreferrer">{item.absoluteUrl}</a></p><button className="button detail-button" type="button" onClick={() => onCopy(item.absoluteUrl)}><Copy size={15} aria-hidden="true" />複製連結</button></div></article>)}</div> : null}
      {shares.length === 0 && state === 'ready' ? <p className="export-note">尚未產生新的觀看連結。</p> : null}
      {existingShares.length > 0 ? <ul className="share-list">{existingShares.map((share) => <li key={share.id}><span>觀看連結 · {share.expiresAt ? `到期：${new Date(share.expiresAt).toLocaleString('zh-TW')}` : '永久有效'}</span>{!locked ? <button className="button detail-button danger-button" type="button" onClick={() => onRevokeShare(share.id)}>撤銷</button> : null}</li>)}</ul> : null}
    </section>
  );
}

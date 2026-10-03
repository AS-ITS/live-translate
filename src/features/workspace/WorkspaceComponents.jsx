import React, { useEffect, useMemo, useRef, useState } from 'react';
import { AgGridReact } from 'ag-grid-react';
import { dataGridProps } from '../../lib/dataGrid.js';
import { Activity, ArrowRight, BookOpen, CalendarDays, Check, CheckCircle2, Clock3, Copy, Download, FileText, Filter, Globe2, MoreHorizontal, Mic, MicOff, Pause, Play, Plus, RefreshCw, Search, Settings, SlidersHorizontal, Square, Tag, Trash2, X } from 'lucide-react';
import { SUPPORTED_LANGUAGES, targetLanguageLabelFor } from '../../lib/languages.js';
import { audioInputDevices, requestAudioInputStream } from '../../lib/mediaDevices.js';
import { createReconnectController } from '../../lib/reconnectController.js';
import { createMemorySessionRepository } from '../../lib/sessionRepository.js';
import { createSessionReadApiClient } from '../../lib/sessionReadApiClient.js';
import { createSessionControlLease } from '../../lib/sessionControlLease.js';
import { createMeetingReadApiClient } from '../../lib/meetingReadApiClient.js';
import { useBodyScrollLock } from '../../lib/useBodyScrollLock.js';
import { meetingManagementErrorMessage } from '../../lib/meetingManagementApiClient.js';
import { meetingApiErrorMessage } from '../../lib/meetingApiError.js';
import { createSessionSnapshotApiClient } from '../../lib/sessionSnapshotApiClient.js';
import { createSessionCommandApiClient } from '../../lib/sessionCommandApiClient.js';
import { createSessionSnapshotSyncCoordinator } from '../../lib/sessionSnapshotSyncCoordinator.js';
import { createMeetingCheckpointApiClient } from '../../lib/meetingCheckpointApiClient.js';
import { createMeetingCueApiClient } from '../../lib/meetingCueApiClient.js';
import {
  checkpointChunksForTranscriptItems,
  createMeetingCheckpointSyncCoordinator
} from '../../lib/meetingCheckpointSyncCoordinator.js';
import { createSegmentSwitchOrchestrator } from '../../lib/segmentSwitchOrchestrator.js';
import { createTranslationCommandApiClient } from '../../lib/translationCommandApiClient.js';
import { createGlossaryApiClient } from '../../lib/glossaryApiClient.js';
import { liveGlossaryEntriesForTarget, selectedMeetingGlossaryEntries } from '../../lib/meetingGlossary.js';
import { createMeetingManagementApiClient } from '../../lib/meetingManagementApiClient.js';
import {
  filterMeetingManagementItems,
  meetingManagementLastUpdated,
  meetingManagementStatusLabel,
  MEETING_STATUS_FILTERS
} from '../../lib/meetingManagement.js';
import { accessTokenHeaders, authenticatedFetch } from '../../lib/accessToken.js';
import { applyGlossaryReplacements } from '../../lib/glossaryReplacement.js';
import { missingNumericIntegrity } from '../../lib/numericIntegrity.js';
import { createTranslationCommandLifecycle } from '../../lib/translationCommandLifecycle.js';
import { formatTranslationCommandPersistenceError } from '../../lib/translationCommandError.js';
import { createTranscriptPolishingLifecycle } from '../../lib/transcriptPolishingLifecycle.js';
import { createCueRefinementCoordinator, mergePolishedItemsFromOutputs } from '../../lib/transcriptPolishing.js';
import { applyCueRefinementExecutionStates, completedCueRefinementOutputs, markCuesCompletedByRefinedSubtitleCues, mergeCuesByIdPreferRefinement, refinedSubtitleCuesForDisplay } from '../../lib/cueRefinement.js';
import { effectiveSourceForCue, effectiveTranslationForCue, rawSourceForCue, rawTranslationForCue } from '../../lib/cueContent.js';
import { mergeRetranslationHistoryIntoDetail } from '../../lib/sessionTranslationHistory.js';
import {
  appendNewFinalTranscriptItems,
  buildFinalizePatch,
  buildSessionRecordInput,
  createActiveSessionRecord,
  finalizeActiveSessionRecord
} from '../../lib/sessionRecordLifecycle.js';
import { toTraditionalChineseSourceContent, toTraditionalChineseText } from '../../lib/chineseText.js';
import {
  applyTranscriptEvent,
  buildTranscriptArticleParagraphs,
  createTranscriptState,
  describeTranscriptSegmentDecision,
  formatTranscriptArticleText,
  finalizePendingTranscriptItems,
  resetTranscriptState,
  transcriptItemsForStream
} from '../../lib/transcript.js';
import { createMicrophoneRecordingController } from '../../lib/microphoneRecording.js';
import { createAudioUploadController } from '../../lib/audioUploadController.js';
import {
  applySubtitleCueEvent,
  createSubtitleCueState,
  dismissSubtitleCue,
  finalizePendingSubtitleCue,
  prepareSubtitleCueStateForNewSegment,
  resetSubtitleCueState,
  resolveIdleSubtitleCue,
  markNumericCorrectionRequested,
  DEFAULT_TURN_COMPLETE_DEBOUNCE_MS
} from '../../lib/subtitleCues.js';
import {
  cueListForDisplay,
  sourceTextForCopy,
  translationTextForCopy
} from '../../lib/cueUi.js';
import {
  INPUT_SAMPLE_RATE,
  buildInputAudioFileName,
  buildTranslatedAudioFileName,
  pcm16ChunksToWavBlob
} from '../../lib/audio.js';
import { canonicalHashForLocation, FEATURE_PAGES, pageFromLocation, pageInfoFromLocation } from '../../app/routes.js';
import { AudioArtifactDownloads } from '../history/AudioArtifactDownloads.jsx';
import { CloudMeetingExportPanel } from '../meetings/CloudMeetingExportPanel.jsx';
import { LocalMeetingExportPanel } from '../meetings/LocalMeetingExportPanel.jsx';
import { isSupabaseConfigured } from '../../lib/supabaseAuth.js';
import { GeminiCredentialNotice } from '../../components/GeminiCredentialNotice.jsx';

const RECONNECT_FAILED_MESSAGE = '無法重新連線即時字幕。準備就緒後可以開始新的工作階段。';
const RECONNECT_EXHAUSTED_MESSAGE = '即時字幕多次重新連線後仍未成功。準備就緒後可以開始新的工作階段。';
const TERMINAL_HISTORY_STATUSES = new Set(['stopped', 'failed', 'expired', 'completed']);
const DEFAULT_GLOSSARY_CATEGORIES = [
  { id: 'product', label: '產品名稱' },
  { id: 'department', label: '部門／職能' },
  { id: 'abbreviation', label: '縮寫' },
  { id: 'meeting', label: '會議常用語' },
  { id: 'technical', label: '技術名詞' },
  { id: 'other', label: '其他' }
];
const TRANSCRIPT_SEGMENT_LOG_ENABLED = Boolean(import.meta.env?.DEV);
const LIVE_CUE_IDLE_FINALIZE_MS = DEFAULT_TURN_COMPLETE_DEBOUNCE_MS;
const SESSION_SNAPSHOT_SYNC_DELAY_MS = 1000;
const SESSION_SNAPSHOT_SYNC_FINAL_ITEM_BATCH_SIZE = 20;
const MEETING_CHECKPOINT_SYNC_DELAY_MS = 5000;
const DEFAULT_SOURCE_LANGUAGE_CODE = 'zh-Hant';
const TRANSCRIPT_POLISHING_ENABLED = import.meta.env?.VITE_TRANSCRIPT_POLISHING_ENABLED !== 'false';
const TRANSCRIPT_POLISHING_INTERVAL_MS = Number.parseInt(import.meta.env?.VITE_TRANSCRIPT_POLISHING_INTERVAL_MS || '30000', 10);
const TRANSCRIPT_POLISHING_MIN_CHARS = Number.parseInt(import.meta.env?.VITE_TRANSCRIPT_POLISHING_MIN_CHARS || '200', 10);
const TRANSCRIPT_POLISHING_MAX_RPM = Number.parseInt(import.meta.env?.VITE_TRANSCRIPT_POLISHING_MAX_RPM || '15', 10);
const SEGMENT_SWITCH_INTERVAL_MS = 10 * 60 * 1000;
const TRANSLATED_AUDIO_IDLE_STATE = {
  status: 'idle',
  blob: null,
  fileName: '',
  errorMessage: ''
};
const INPUT_AUDIO_RECORDING_SKIPPED_STATE = {
  status: 'skipped',
  blob: null,
  mimeType: '',
  extension: '',
  fileName: '',
  errorMessage: ''
};

function GlossarySourceCell({ data }) {
  return <strong>{data.source}</strong>;
}

function GlossaryActionsCell({ context, data }) {
  return (
    <div className="glossary-actions">
      <button className="button detail-button" type="button" onClick={() => context.onEdit(data)}>編輯</button>
      <button className="button detail-button danger-button" type="button" onClick={() => context.onDelete(data)}>刪除</button>
    </div>
  );
}

export function ArticlePanel({
  title,
  stream,
  paragraphs,
  currentPartial,
  currentLabel,
  emptyText,
  copied,
  onCopy,
  onExport
}) {
  const hasArticle = paragraphs.length > 0;

  return (
    <article className="transcript-panel">
      <div className="article-panel-header">
        <h2>{title}</h2>
        <div className="article-actions">
          <button className="button detail-button" type="button" onClick={onCopy} disabled={!hasArticle}>
            <Copy size={16} aria-hidden="true" />
            {copied ? '已複製' : '複製'}
          </button>
          <button className="button detail-button" type="button" onClick={onExport} disabled={!hasArticle}>
            <Download size={16} aria-hidden="true" />
            匯出 TXT
          </button>
        </div>
      </div>
      {hasArticle ? (
        <div className="article-content" aria-label={`${title}內容`}>
          {paragraphs.map((paragraph, index) => (
            <p key={`${stream}-article-${index}`}>{paragraph}</p>
          ))}
        </div>
      ) : null}
      {currentPartial ? (
        <p className="transcript-current"><span>{currentLabel}</span>{currentPartial.text}</p>
      ) : null}
      {!hasArticle && !currentPartial ? (
        <p className="transcript-text empty">{`${emptyText} 等待完成片段。`}</p>
      ) : null}
    </article>
  );
}

export function MeetingManagementPage({ onOpenLive, onOpenHistory, onOpenSettings, onEndMeeting, initialStatusFilter = 'all', initialPanel = '', initialCreate = false }) {
  const managementClientRef = useRef(createMeetingManagementApiClient());
  const readClientRef = useRef(createMeetingReadApiClient());
  const glossaryClientRef = useRef(createGlossaryApiClient());
  const [meetings, setMeetings] = useState([]);
  const [glossaryEntries, setGlossaryEntries] = useState([]);
  const [viewMode, setViewMode] = useState('list');
  const [selectedMeeting, setSelectedMeeting] = useState(null);
  const [selectedGlossaryIds, setSelectedGlossaryIds] = useState([]);
  const [privateGlossaryEntries, setPrivateGlossaryEntries] = useState([]);
  const [privateGlossarySource, setPrivateGlossarySource] = useState('');
  const [privateGlossaryTranslation, setPrivateGlossaryTranslation] = useState('');
  const [editingPrivateGlossarySource, setEditingPrivateGlossarySource] = useState('');
  const [name, setName] = useState('');
  const [sourceLanguageCode, setSourceLanguageCode] = useState(DEFAULT_SOURCE_LANGUAGE_CODE);
  const [targetLanguageCode, setTargetLanguageCode] = useState('en');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [isSaving, setIsSaving] = useState(false);
  const [isGlossaryDrawerOpen, setIsGlossaryDrawerOpen] = useState(false);
  const [isGlobalGlossaryPanelOpen, setIsGlobalGlossaryPanelOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [statusFilter, setStatusFilter] = useState(initialStatusFilter);
  const [isLoadingMeetings, setIsLoadingMeetings] = useState(true);
  const [meetingLoadError, setMeetingLoadError] = useState('');

  useEffect(() => {
    setStatusFilter(initialStatusFilter || 'all');
  }, [initialStatusFilter]);

  useEffect(() => {
    if (initialPanel === 'global-glossary') setIsGlobalGlossaryPanelOpen(true);
  }, [initialPanel]);

  useEffect(() => {
    if (initialCreate) openCreateForm();
  }, [initialCreate]);

  const filteredMeetings = useMemo(() => filterMeetingManagementItems(meetings, {
    query,
    status: statusFilter
  }), [meetings, query, statusFilter]);

  const loadMeetingManagementData = async () => {
    const routeMeetingId = pageInfoFromLocation().meetingId;
    setIsLoadingMeetings(true);
    setMeetingLoadError('');
    const [meetingResult, glossaryResult] = await Promise.allSettled([
      readClientRef.current.listMeetingHistory(),
      glossaryClientRef.current.listEntries()
    ]);

    if (meetingResult.status === 'rejected') {
      setMeetingLoadError(meetingManagementErrorMessage(meetingResult.reason, '無法載入會議資料。'));
    } else {
      const meetingItems = meetingResult.value;
      setMeetings(meetingItems);
      if (routeMeetingId) await selectMeeting(routeMeetingId, glossaryResult.status === 'fulfilled' ? glossaryResult.value : []);
    }

    setGlossaryEntries(glossaryResult.status === 'fulfilled' ? glossaryResult.value : []);
    setIsLoadingMeetings(false);
  };

  useEffect(() => {
    void loadMeetingManagementData();
  }, []);

  useEffect(() => {
    if (!isGlossaryDrawerOpen) return undefined;
    const handleKeyDown = (event) => {
      if (event.key === 'Escape') setIsGlossaryDrawerOpen(false);
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [isGlossaryDrawerOpen]);

  useEffect(() => {
    if (!isGlobalGlossaryPanelOpen) return undefined;
    const handleKeyDown = (event) => {
      if (event.key === 'Escape') setIsGlobalGlossaryPanelOpen(false);
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [isGlobalGlossaryPanelOpen]);

  function clearMeetingForm() {
    setSelectedMeeting(null);
    setName('');
    setSourceLanguageCode(DEFAULT_SOURCE_LANGUAGE_CODE);
    setTargetLanguageCode('en');
    setSelectedGlossaryIds([]);
    setPrivateGlossaryEntries([]);
    setPrivateGlossarySource('');
    setPrivateGlossaryTranslation('');
    setEditingPrivateGlossarySource('');
    setNotice('');
    setIsGlossaryDrawerOpen(false);
  }

  function openCreateForm() {
    clearMeetingForm();
    setViewMode('form');
  }

  function returnToMeetingList() {
    clearMeetingForm();
    setViewMode('list');
  }

  async function selectMeeting(id, availableGlossaryEntries = glossaryEntries) {
    setError('');
    try {
      const detail = await readClientRef.current.getMeetingDetail(id);
      const meeting = detail?.meeting;
      if (!meeting) {
        const error = new Error('Meeting not found.');
        error.code = 'meeting_not_found';
        throw error;
      }
      setSelectedMeeting(meeting);
      setName(meeting?.name || '');
      setSourceLanguageCode(meeting?.sourceLanguageCode || DEFAULT_SOURCE_LANGUAGE_CODE);
      const meetingTargetLanguageCode = meeting?.targetLanguageCode || 'en';
      setTargetLanguageCode(meetingTargetLanguageCode);
      setSelectedGlossaryIds(availableGlossaryEntries.filter((entry) => (meeting?.glossaryEntries || []).some((item) => item.source === entry.source && entry.translations?.[meetingTargetLanguageCode] === item.target)).map((entry) => entry.id));
      setPrivateGlossaryEntries(Array.isArray(meeting?.privateGlossaryEntries) ? meeting.privateGlossaryEntries : []);
      setViewMode('form');
    } catch (loadError) {
      setError(meetingApiErrorMessage(loadError, '無法載入會議設定。'));
    }
  }

  function selectedEntries() {
    return glossaryEntries.filter((entry) => selectedGlossaryIds.includes(entry.id)).map((entry) => ({
      source: entry.source,
      target: entry.translations?.[targetLanguageCode],
      replacementAliases: entry.replacementAliases?.[targetLanguageCode] || []
    })).filter((entry) => entry.target);
  }

  function savePrivateGlossaryEntry() {
    const source = privateGlossarySource.trim();
    const translation = privateGlossaryTranslation.trim();
    if (!source || !translation) return;
    const existing = privateGlossaryEntries.find((entry) => entry.source === (editingPrivateGlossarySource || source));
    const nextEntry = {
      ...(existing || {}),
      source,
      translations: { ...(existing?.translations || {}), [targetLanguageCode]: translation },
      replacementAliases: { ...(existing?.replacementAliases || {}) }
    };
    setPrivateGlossaryEntries((current) => {
      const withoutEdited = current.filter((entry) => entry.source !== (editingPrivateGlossarySource || source));
      return [nextEntry, ...withoutEdited];
    });
    setPrivateGlossarySource('');
    setPrivateGlossaryTranslation('');
    setEditingPrivateGlossarySource('');
  }

  async function saveMeeting() {
    if (selectedMeeting?.status === 'completed') return;
    setError('');
    setNotice('');
    setIsSaving(true);
    try {
      const isUpdating = Boolean(selectedMeeting?.id);
      const input = { name: name.trim() || null, sourceLanguageCode, targetLanguageCode, glossaryEntries: selectedEntries(), privateGlossaryEntries };
      const meeting = isUpdating
        ? await managementClientRef.current.update(selectedMeeting.id, input)
        : await managementClientRef.current.create(input);
      setSelectedMeeting(meeting);
      setMeetings((current) => [meeting, ...current.filter((item) => item.id !== meeting.id)]);
      setNotice(isUpdating ? '會議設定已更新。' : '會議已建立。');
    } catch (requestError) {
      setError(requestError?.status === 409 ? '已完成會議不可修改設定。' : '無法儲存會議設定。');
    } finally {
      setIsSaving(false);
    }
  }

  async function deleteMeeting(meeting) {
    if (!meeting?.id || meeting.status !== 'created') return;
    if (!window.confirm(`確定要刪除「${meeting.name || meeting.id}」嗎？此操作無法復原。`)) return;

    setError('');
    try {
      await managementClientRef.current.delete(meeting.id);
      setMeetings((current) => current.filter((item) => item.id !== meeting.id));
      setNotice('會議已刪除。');
    } catch (requestError) {
      setError(requestError?.status === 409
        ? '只有尚未開始的會議可以刪除。'
        : '無法刪除會議。');
    }
  }

  function openMeetingCard(meeting) {
    if (!meeting?.id) return;
    if (meeting.status === 'completed') onOpenHistory(meeting.id);
    else onOpenSettings?.(meeting.id);
  }

  function meetingCardActionLabel(status) {
    if (status === 'active') return '確認設定並開啟字幕';
    if (status === 'interrupted') return '確認設定並繼續字幕';
    if (status === 'completed') return '查看翻譯紀錄';
    return '編輯並開始會議';
  }

  function meetingCardStatusLabel(status) {
    if (status === 'interrupted') return '可續錄';
    return meetingManagementStatusLabel(status);
  }

  function meetingCardDescription(status) {
    if (status === 'active') return '即時字幕正在進行中，可開啟工作區查看。';
    if (status === 'interrupted') return '會議已暫停，現有字幕與翻譯可繼續錄製。';
    if (status === 'completed') return '會議已完成，翻譯紀錄與字幕已保存。';
    return '會議設定已建立，準備好後即可開始。';
  }

  function meetingCardStatusIcon(status) {
    if (status === 'active') return Activity;
    if (status === 'completed') return CheckCircle2;
    if (status === 'created' || status === 'interrupted') return CalendarDays;
    return FileText;
  }

  return (
    <section className="feature-page meeting-center-page meeting-management-page meetings-page" aria-labelledby="meeting-management-title">
      <GeminiCredentialNotice showSettingsLink={false} />
      {viewMode === 'form' ? (
        <div className="meeting-management-back-row">
          <button className="button secondary" type="button" onClick={returnToMeetingList}>返回會議清單</button>
        </div>
      ) : null}
      <div className="meeting-management-status">
        {error ? <p className="error-message" role="alert">{error}</p> : null}
        {notice ? <p className="success-message" role="status">{notice}</p> : null}
      </div>
      {viewMode === 'form' ? (
        <div className={`meeting-management-grid ${selectedMeeting ? '' : 'settings-only'}`}>
          <section className="control-panel" aria-label="會議設定">
          <div className="title-block">
            <div className="title-block-header">
              <div><p className="eyebrow">MEETING SETUP</p><h3>{selectedMeeting?.status === 'completed' ? '會議設定' : selectedMeeting ? '編輯會議設定' : '建立會議'}</h3></div>
            </div>
            <p>{selectedMeeting?.status === 'completed' ? '會議已完成，設定內容僅供查看。' : '設定語言與會議字典，儲存後即可開始會議。'}</p>
          </div>
          <label className="field"><span>會議名稱</span><input value={name} onChange={(event) => setName(event.target.value)} placeholder="例如：產品會議" maxLength={120} readOnly={selectedMeeting?.status === 'completed'} /></label>
          <label className="field"><span>主要輸入語言</span><select value={sourceLanguageCode} onChange={(event) => setSourceLanguageCode(event.target.value)} disabled={selectedMeeting?.status === 'completed'}>{SUPPORTED_LANGUAGES.map((language) => <option key={language.code} value={language.code}>{language.label}</option>)}</select></label>
          <label className="field"><span>目標語言</span><select value={targetLanguageCode} onChange={(event) => setTargetLanguageCode(event.target.value)} disabled={selectedMeeting?.status === 'completed'}>{SUPPORTED_LANGUAGES.map((language) => <option key={language.code} value={language.code}>{language.label}</option>)}</select></label>
          <button
            className="button secondary glossary-drawer-trigger"
            type="button"
            onClick={() => setIsGlossaryDrawerOpen(true)}
            aria-haspopup="dialog"
            aria-expanded={isGlossaryDrawerOpen}
            disabled={selectedMeeting?.status === 'completed'}
          >
            <BookOpen size={18} aria-hidden="true" />
            會議字典
            <span className="glossary-count-badge">
              {selectedGlossaryIds.filter((id) => liveGlossaryEntriesForTarget(glossaryEntries, targetLanguageCode).some((entry) => entry.id === id)).length}
            </span>
          </button>
          <div className="meeting-private-glossary" aria-label="Meeting 私有字典">
            <div className="title-block-header"><h4>Meeting 私有字典</h4></div>
            <p className="export-note">只套用於目前 Meeting，不會出現在全域字典或 Viewer。</p>
            {privateGlossaryEntries.map((entry) => (
              <div className="glossary-choice" key={entry.source}>
                <span><strong>{entry.source}</strong><small>{entry.translations?.[targetLanguageCode] || '尚未設定目前語言翻譯'}</small></span>
                {selectedMeeting?.status !== 'completed' ? <span className="meeting-actions">
                  <button className="button detail-button" type="button" onClick={() => { setEditingPrivateGlossarySource(entry.source); setPrivateGlossarySource(entry.source); setPrivateGlossaryTranslation(entry.translations?.[targetLanguageCode] || ''); }}>編輯</button>
                  <button className="button detail-button danger-button" type="button" onClick={() => setPrivateGlossaryEntries((current) => current.filter((item) => item.source !== entry.source))}>刪除</button>
                </span> : null}
              </div>
            ))}
            {selectedMeeting?.status !== 'completed' ? <div className="glossary-quick-add">
              <label className="field"><span>私有原文</span><input value={privateGlossarySource} onChange={(event) => setPrivateGlossarySource(event.target.value)} placeholder="例如：專案代號" disabled={isSaving} /></label>
              <label className="field"><span>翻譯（{targetLanguageLabelFor(targetLanguageCode) || targetLanguageCode}）</span><input value={privateGlossaryTranslation} onChange={(event) => setPrivateGlossaryTranslation(event.target.value)} placeholder="例如：Project Codename" disabled={isSaving} /></label>
              <button className="button secondary" type="button" onClick={savePrivateGlossaryEntry} disabled={!privateGlossarySource.trim() || !privateGlossaryTranslation.trim()}>{editingPrivateGlossarySource ? '更新私有詞條' : '新增私有詞條'}</button>
            </div> : null}
          </div>
          <div className="meeting-management-actions">
            {selectedMeeting?.status !== 'completed' ? <button className="button primary" type="button" onClick={saveMeeting} disabled={isSaving}>{isSaving ? '儲存中…' : selectedMeeting ? '儲存變更' : '建立會議'}</button> : null}
            {selectedMeeting ? (
              selectedMeeting.status === 'completed'
                ? <button className="button secondary" type="button" onClick={() => onOpenHistory(selectedMeeting.id)}>前往翻譯紀錄</button>
                : <>
                  <button className="button secondary" type="button" onClick={() => onOpenLive(selectedMeeting.id)}>前往即時字幕</button>
                  {['active', 'interrupted'].includes(selectedMeeting.status) && onEndMeeting ? <button className="button detail-button danger-button" type="button" onClick={() => onEndMeeting(selectedMeeting.id)}>結束會議</button> : null}
                </>
              ) : null}
          </div>
          {selectedMeeting?.status === 'created' ? (
            <section className="meeting-danger-zone" aria-labelledby="meeting-danger-zone-title">
              <div>
                <h4 id="meeting-danger-zone-title">危險操作</h4>
                <p>刪除尚未開始的會議後，設定內容將無法復原。</p>
              </div>
              <button className="button detail-button danger-button" type="button" onClick={() => deleteMeeting(selectedMeeting)}>
                <Trash2 size={16} aria-hidden="true" />
                刪除會議
              </button>
            </section>
          ) : null}
          </section>
        </div>
      ) : null}
      {viewMode === 'list' ? <section className="history-panel" aria-label="會議列表">
        <div className="meeting-table-toolbar">
          <label className="field meeting-search-field">
            <span>搜尋會議</span>
            <div className="meeting-toolbar-input">
              <Search size={20} aria-hidden="true" />
              <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜尋名稱、語言或狀態" />
            </div>
          </label>
          <label className="field meeting-status-filter-field">
            <span>篩選狀態</span>
            <div className="meeting-toolbar-input meeting-toolbar-select">
              <SlidersHorizontal size={20} aria-hidden="true" />
              <select value={statusFilter} onChange={(event) => setStatusFilter(event.target.value)}>
                {MEETING_STATUS_FILTERS.map((filter) => <option key={filter.value} value={filter.value}>{filter.label}</option>)}
              </select>
            </div>
          </label>
          <a className="button secondary meeting-glossary-toolbar-button" href="#glossary">
            <BookOpen size={19} aria-hidden="true" />
            全域字典
          </a>
        </div>
          {isLoadingMeetings ? <p className="history-empty">正在載入會議…</p> : null}
          {meetingLoadError ? <p className="error-message" role="alert">{meetingLoadError} <button className="inline-retry" type="button" onClick={() => void loadMeetingManagementData()}>重新載入</button></p> : null}
          {!isLoadingMeetings && !meetingLoadError && meetings.length === 0 ? <p className="history-empty">尚無會議。建立第一場會議開始使用。</p> : null}
          {!isLoadingMeetings && !meetingLoadError && meetings.length > 0 && filteredMeetings.length === 0 ? <p className="history-empty">找不到符合條件的會議。</p> : null}
        <div className="meeting-card-grid" aria-label="既有會議列表">
          {filteredMeetings.map((meeting) => {
            const StatusIcon = meetingCardStatusIcon(meeting.status);
            const startedAt = meeting.startedAt || null;
            const updatedAt = meetingManagementLastUpdated(meeting);
            const startedFullTime = formatRecordTime(startedAt);
            const fullTime = formatRecordTime(updatedAt);
            return (
              <article
                className={`meeting-card meeting-card-${meeting.status || 'unknown'}`}
                key={meeting.id}
                role="button"
                tabIndex={0}
                onClick={() => openMeetingCard(meeting)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter' || event.key === ' ') {
                    event.preventDefault();
                    openMeetingCard(meeting);
                  }
                }}
                aria-label={`${meeting.name || meeting.id || '未命名會議'}，${meetingCardStatusLabel(meeting.status)}`}
              >
                <div className="meeting-card-topline">
                  <span className="meeting-status-badge">
                    <span className="meeting-status-dot" aria-hidden="true" />
                    {meetingCardStatusLabel(meeting.status)}
                  </span>
                  <span className="meeting-card-icon" aria-hidden="true"><StatusIcon size={27} strokeWidth={1.8} /></span>
                </div>
                <h3>{meeting.name || meeting.id || '未命名會議'}</h3>
                <div className="meeting-card-metadata">
                  <span><Globe2 size={18} aria-hidden="true" />{meetingLanguageLabel(meeting)}</span>
                  <span><CalendarDays size={18} aria-hidden="true" />開始時間：<time data-testid="meeting-card-started-at" dateTime={startedAt || undefined} title={startedFullTime}>{formatMeetingListTime(startedAt)}</time></span>
                  <span><Clock3 size={18} aria-hidden="true" />最後更新：<time data-testid="meeting-card-updated-at" dateTime={updatedAt || undefined} title={fullTime}>{formatMeetingListTime(updatedAt)}</time></span>
                </div>
                <div className="meeting-card-divider" />
                <div className="meeting-card-footer">
                  <p><StatusIcon size={19} aria-hidden="true" />{meetingCardDescription(meeting.status)}</p>
                  <div className="meeting-card-actions">
                    <button
                      className="button meeting-card-action"
                      type="button"
                      onClick={(event) => {
                        event.stopPropagation();
                        openMeetingCard(meeting);
                      }}
                    >
                      <span className="meeting-card-action-label">{meetingCardActionLabel(meeting.status)}</span>
                    </button>
                    {meeting.status === 'created' ? (
                      <button
                        className="button detail-button danger-button meeting-card-delete"
                        type="button"
                        aria-label={`刪除 ${meeting.name || meeting.id || '未命名會議'}`}
                        onClick={(event) => {
                          event.stopPropagation();
                          void deleteMeeting(meeting);
                        }}
                      >
                        <Trash2 size={16} aria-hidden="true" />
                        刪除
                      </button>
                    ) : null}
                  </div>
                </div>
              </article>
            );
          })}
        </div>
      </section> : null}
      <LiveGlossaryDrawer
        open={isGlossaryDrawerOpen}
        entries={glossaryEntries}
        targetLanguageCode={targetLanguageCode}
        selectedEntryIds={selectedGlossaryIds}
        disabled={isSaving}
        onClose={() => setIsGlossaryDrawerOpen(false)}
        onEntriesChange={setGlossaryEntries}
        onSelectionChange={setSelectedGlossaryIds}
        onOpenManager={() => {
          setIsGlossaryDrawerOpen(false);
          window.location.hash = '#meetings?panel=global-glossary';
        }}
      />
      {isGlobalGlossaryPanelOpen ? (
        <div className="global-glossary-modal-backdrop" role="presentation" onClick={() => setIsGlobalGlossaryPanelOpen(false)}>
          <section className="global-glossary-modal" role="dialog" aria-modal="true" aria-labelledby="global-glossary-title" onClick={(event) => event.stopPropagation()}>
            <header className="global-glossary-modal-header">
              <div>
                <p className="eyebrow">GLOBAL GLOSSARY</p>
                <h2 id="global-glossary-title">全域字典</h2>
                <p>可供不同 Meeting 選用；不會混入任何單一會議的私有詞彙。</p>
              </div>
              <button className="icon-button dialog-close-button" type="button" aria-label="關閉全域字典" onClick={() => setIsGlobalGlossaryPanelOpen(false)}><X size={20} aria-hidden="true" /></button>
            </header>
            <GlossaryPanel entries={glossaryEntries} onEntriesChange={setGlossaryEntries} />
          </section>
        </div>
      ) : null}
    </section>
  );
}

export function MeetingDetailPage({ detail, detailError = '', onRetry }) {
  const [activeSection, setActiveSection] = useState('record');

  useEffect(() => {
    setActiveSection('record');
  }, [detail?.meeting?.id]);

  const sections = [
    ['record', '紀錄'],
    ['translation', '翻譯內容'],
    ['export', '匯出']
  ];

  return (
    <section className="feature-page meeting-detail-page glossary-page" aria-labelledby="meeting-detail-page-title">
      <div className="meeting-detail-layout">
        <aside className="meeting-detail-directory" aria-label="會議內容">
          <div className="meeting-detail-directory-heading"><strong>會議內容</strong></div>
          <nav aria-label="會議內容目錄">
            {sections.map(([id, label]) => (
              <button
                key={id}
                className={activeSection === id ? 'is-active' : ''}
                type="button"
                aria-current={activeSection === id ? 'page' : undefined}
                onClick={() => setActiveSection(id)}
              >
                {label}
              </button>
            ))}
          </nav>
        </aside>
        <div className="meeting-detail-page-scroll">
          <MeetingRecordDetail detail={detail} detailError={detailError} activeSection={activeSection} onRetry={onRetry} />
        </div>
      </div>
    </section>
  );
}

export function MeetingRecordDetail({ detail, detailError = '', activeSection, onRetry }) {
  if (activeSection === 'translation') {
    return <MeetingTranslationSection detail={detail} detailError={detailError} onRetry={onRetry} />;
  }

  if (activeSection === 'export') {
    return <MeetingExportSection detail={detail} detailError={detailError} onRetry={onRetry} />;
  }

  if (detail === undefined) {
    return <MeetingDetailState title="正在載入會議詳細資料"><p className="history-empty">正在載入已儲存的會議…</p></MeetingDetailState>;
  }

  if (!detail) {
    return <MeetingDetailState title="無法取得會議詳細資料"><p className="error-message" role="alert">{detailError || '此會議紀錄無法使用。'} <button className="inline-retry" type="button" onClick={onRetry}>重試</button></p></MeetingDetailState>;
  }
  const retentionNotice = meetingRetentionNotice(detail.meeting);

  return (
    <section className="meeting-record-section" aria-label="會議紀錄">
      <div className="meeting-record-section-heading">
        <div>
          <p className="eyebrow">MEETING RECORD</p>
          <h2>{meetingTitle(detail.meeting)}</h2>
          <p>會議基本資訊與完成狀態。</p>
          {retentionNotice ? <p className="export-note" data-testid="meeting-retention-notice" role="status">{retentionNotice}</p> : null}
        </div>
      </div>
      <dl className="session-detail-metadata meeting-detail-metadata">
        <div><dt>會議名稱</dt><dd>{meetingTitle(detail.meeting)}</dd></div>
        <div><dt>狀態</dt><dd>{meetingStatusLabel(detail.meeting?.status)}</dd></div>
        <div><dt>開始時間</dt><dd>{formatRecordTime(detail.meeting?.startedAt)}</dd></div>
        <div><dt>結束時間</dt><dd>{formatRecordTime(detail.meeting?.endedAt)}</dd></div>
        <div><dt>持續時間</dt><dd>{formatDuration(detail.meeting?.durationMs)}</dd></div>
        <div><dt>段落數</dt><dd>{detail.meeting?.segmentSummary?.totalSegments || 0}</dd></div>
        <div><dt>原文完成</dt><dd>{detail.meeting?.transcriptSummary?.sourceFinalCount || 0}</dd></div>
        <div><dt>翻譯完成</dt><dd>{detail.meeting?.transcriptSummary?.translationFinalCount || 0}</dd></div>
      </dl>
    </section>
  );
}

export function MeetingTranslationSection({ detail, detailError = '', onRetry }) {
  const [translationTab, setTranslationTab] = useState('source');

  if (detail === undefined) return <MeetingDetailState title="正在載入翻譯內容"><p className="history-empty">正在載入已儲存的會議…</p></MeetingDetailState>;
  if (!detail) return <MeetingDetailState title="無法取得翻譯內容"><p className="error-message" role="alert">{detailError || '此會議紀錄無法使用。'} <button className="inline-retry" type="button" onClick={onRetry}>重試</button></p></MeetingDetailState>;

  const readingContent = meetingReadingContent(detail);
  const content = translationTab === 'source' ? readingContent.sourceTranscript : readingContent.translationArticle;
  const contentTitle = translationTab === 'source' ? '原始逐字稿' : '翻譯內容';
  return (
    <section className="meeting-record-section" aria-label="翻譯內容">
      <div className="meeting-record-section-heading"><div><p className="eyebrow">TRANSLATION</p><h2>翻譯內容</h2><p>查看這場會議完成的翻譯結果。</p></div></div>
      {detail.localTranscriptStatus === 'recovered' ? <LocalTranscriptRecoveryNotice /> : null}
      <div className="reading-tabs" role="tablist" aria-label="原文與翻譯內容切換">
        <button className={`reading-tab${translationTab === 'source' ? ' active' : ''}`} type="button" role="tab" aria-selected={translationTab === 'source'} onClick={() => setTranslationTab('source')}>原文</button>
        <button className={`reading-tab${translationTab === 'translation' ? ' active' : ''}`} type="button" role="tab" aria-selected={translationTab === 'translation'} onClick={() => setTranslationTab('translation')}>翻譯</button>
      </div>
      <ReadingContentMetadata content={content} />
      <section className="meeting-record-content-block" aria-label={contentTitle}>
        <div className="meeting-detail-section-heading"><h3>{contentTitle}</h3></div>
        {content.paragraphs.length > 0 ? <div className="session-transcript-article article-content">{content.paragraphs.map((paragraph, index) => <p key={`meeting-${translationTab}-${index}`}>{paragraph}</p>)}</div> : <p className="history-empty">{translationTab === 'source' ? '尚無原始逐字稿。' : '尚無翻譯內容。'}</p>}
      </section>
    </section>
  );
}

export function MeetingExportSection({ detail, detailError = '', onRetry }) {
  if (detail === undefined) return <MeetingDetailState title="正在載入匯出內容"><p className="history-empty">正在載入已儲存的會議…</p></MeetingDetailState>;
  if (!detail) return <MeetingDetailState title="無法取得匯出內容"><p className="error-message" role="alert">{detailError || '此會議紀錄無法使用。'} <button className="inline-retry" type="button" onClick={onRetry}>重試</button></p></MeetingDetailState>;

  return (
    <section className="meeting-record-section meeting-export-section" aria-label="匯出" data-history-section="export">
      <div className="meeting-record-section-heading"><div><p className="eyebrow">EXPORT</p><h2>匯出</h2><p>下載語音紀錄或匯出字幕檔案。</p></div></div>
      <section className="meeting-export-block" aria-label="語音下載"><h3>語音下載</h3><p className="export-note">下載這場會議保存的原始語音或翻譯語音。</p><AudioArtifactDownloads title="" audioArtifacts={detail.audioArtifacts} cloudAudioArtifacts={detail.cloudAudioArtifacts} inputLabel="下載原始語音" translationLabel="下載翻譯語音" hideUnavailableLinks /></section>
      <MeetingTranscriptExportPanel detail={detail} />
    </section>
  );
}

export function MeetingTranscriptExportPanel({ detail }) {
  const cues = Array.isArray(detail?.cues) ? detail.cues : [];
  if (cues.length > 0) {
    return (
      <>
        {detail.localTranscriptStatus === 'recovered' ? <LocalTranscriptRecoveryNotice /> : null}
        <LocalMeetingExportPanel meetingId={detail.meeting?.id} cues={cues} />
      </>
    );
  }
  return isSupabaseConfigured()
    ? <CloudMeetingExportPanel meetingId={detail?.meeting?.id} />
    : <CloudExportUnavailableNotice meetingId={detail?.meeting?.id} />;
}

function LocalTranscriptRecoveryNotice() {
  return (
    <p className="export-note" data-testid="local-transcript-recovery" role="status">
      已從這個瀏覽器的本機保存資料恢復字幕。查看與匯出可正常使用；若 Viewer 尚無內容，代表雲端同步仍未完成。
    </p>
  );
}

export function CloudExportUnavailableNotice({ meetingId = '' }) {
  const meetingHref = isSupabaseConfigured() && meetingId
    ? `#meeting-detail?meetingId=${encodeURIComponent(meetingId)}&section=export`
    : '';

  return (
    <section className="meeting-export-block cloud-export-unavailable" aria-label="字幕匯出" data-testid="cloud-export-unavailable" data-history-section="export">
      <h3>字幕匯出</h3>
      <p className="export-note">字幕匯出僅支援 Supabase cloud mode。此 local runtime 不會直接產生瀏覽器檔案。</p>
      {meetingHref ? <a className="button secondary" href={meetingHref}>前往會議 cloud 匯出</a> : null}
    </section>
  );
}

export function MeetingDetailState({ title, children }) {
  return <section className="meeting-record-section" aria-label={title}><div className="meeting-record-section-heading"><h2>{title}</h2></div>{children}</section>;
}

export function MeetingDetail({ detail, detailError = '', activeSection = 'overview', onRetryDetail }) {
  const [readingTab, setReadingTab] = useState('translationArticle');

  const meetingId = detail?.meeting?.id;
  const readingContent = useMemo(() => meetingReadingContent(detail), [detail]);

  useEffect(() => {
    setReadingTab('translationArticle');
  }, [meetingId]);

  useEffect(() => {
    if (!meetingId || activeSection === 'overview') return undefined;
    if (activeSection === 'source' || activeSection === 'translation') {
      setReadingTab(activeSection === 'source' ? 'sourceTranscript' : 'translationArticle');
    }
    const timer = window.setTimeout(() => {
      document.querySelector(`[data-history-section="${activeSection === 'translation' ? 'source' : activeSection}"]`)?.scrollIntoView({ block: 'start', behavior: 'smooth' });
    }, 0);
    return () => window.clearTimeout(timer);
  }, [activeSection, meetingId]);

  if (detail === undefined) {
    return (
      <section className="session-detail meeting-detail" aria-label="會議詳細資料">
        <div className="session-detail-header">
          <h3>正在載入會議詳細資料</h3>
        </div>
        <p className="history-empty">正在載入已儲存的會議…</p>
      </section>
    );
  }

  if (!detail) {
    return (
      <section className="session-detail meeting-detail" aria-label="會議詳細資料">
        <div className="session-detail-header">
          <h3>無法取得會議詳細資料</h3>
        </div>
        <p className="error-message" role="alert">{detailError || '此翻譯紀錄無法使用。'} <button className="inline-retry" type="button" onClick={onRetryDetail}>重試</button></p>
      </section>
    );
  }

  return (
    <section className="session-detail meeting-detail" aria-label="會議詳細資料">
      <div className="session-detail-header">
        <h3>{meetingTitle(detail.meeting)}詳細資料</h3>
      </div>

      <dl className="session-detail-metadata meeting-detail-metadata" data-history-section="overview">
        <div><dt>狀態</dt><dd>{meetingStatusLabel(detail.meeting?.status)}</dd></div>
        <div><dt>開始時間</dt><dd>{formatRecordTime(detail.meeting?.startedAt)}</dd></div>
        <div><dt>結束時間</dt><dd>{formatRecordTime(detail.meeting?.endedAt)}</dd></div>
        <div><dt>持續時間</dt><dd>{formatDuration(detail.meeting?.durationMs)}</dd></div>
        <div><dt>段落</dt><dd>{meetingSegmentSummaryLabel(detail.meeting?.segmentSummary)}</dd></div>
        <div><dt>逐字稿</dt><dd>{transcriptSummaryLabel(detail.meeting?.transcriptSummary)}</dd></div>
      </dl>

      <AudioArtifactDownloads
        title="整場語音紀錄下載"
        audioArtifacts={detail.audioArtifacts}
        cloudAudioArtifacts={detail.cloudAudioArtifacts}
        inputLabel="下載整場原始語音"
        translationLabel="下載整場翻譯語音"
      />

      <ReadingContentTabs
        content={readingContent}
        selectedTab={readingTab}
        onSelectTab={setReadingTab}
        historySection="source"
      />

      <MeetingTranscriptExportPanel detail={detail} />
    </section>
  );
}

export function LiveGlossaryDrawer({
  open,
  entries,
  targetLanguageCode,
  selectedEntryIds,
  disabled,
  readOnly = false,
  onClose,
  onEntriesChange,
  onSelectionChange,
  onOpenManager
}) {
  const [source, setSource] = useState('');
  const [translation, setTranslation] = useState('');
  const [isSaving, setIsSaving] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [status, setStatus] = useState('');
  const [error, setError] = useState('');
  const [recentlyAddedEntryId, setRecentlyAddedEntryId] = useState('');
  const glossaryListRef = useRef(null);
  const locallyAddedEntryIdsRef = useRef(new Set());
  const apiClientRef = useRef(createGlossaryApiClient());

  useEffect(() => {
    if (!open) return undefined;
    let cancelled = false;
    setIsLoading(true);
    setError('');
    locallyAddedEntryIdsRef.current = new Set();
    void apiClientRef.current.listEntries()
      .then((loadedEntries) => {
        if (!cancelled) {
          onEntriesChange((currentEntries) => {
            const current = Array.isArray(currentEntries) ? currentEntries : [];
            const loadedIds = new Set(loadedEntries.map((entry) => entry?.id).filter(Boolean));
            const locallyAddedEntries = current.filter((entry) => (
              locallyAddedEntryIdsRef.current.has(entry?.id) && !loadedIds.has(entry?.id)
            ));
            return [...locallyAddedEntries, ...loadedEntries];
          });
        }
      })
      .catch(() => {
        if (!cancelled) setError('無法載入字典。請稍後再試。');
      })
      .finally(() => {
        if (!cancelled) setIsLoading(false);
      });
    return () => { cancelled = true; };
  }, [open, onEntriesChange]);

  function resetQuickAdd() {
    setSource('');
    setTranslation('');
  }

  async function saveQuickEntry() {
    setIsSaving(true);
    setStatus('');
    setError('');
    try {
      const entry = await apiClientRef.current.createEntry({
        source: source.trim(),
        translations: { [targetLanguageCode]: translation.trim() },
        scope: 'live'
      });
      locallyAddedEntryIdsRef.current.add(entry.id);
      onEntriesChange(mergeGlossaryEntry(entries, entry));
      onSelectionChange((current) => [...new Set([...current, entry.id])]);
      setRecentlyAddedEntryId(entry.id);
      setStatus('詞條已新增並套用。');
      resetQuickAdd();
    } catch {
      setError('無法新增詞條。請確認原文與翻譯皆已填寫。');
    } finally {
      setIsSaving(false);
    }
  }

  const targetEntries = liveGlossaryEntriesForTarget(entries, targetLanguageCode);
  const settingsDisabled = disabled || readOnly;
  const canSave = source.trim().length > 0 && translation.trim().length > 0 && !isSaving && !settingsDisabled;

  useEffect(() => {
    if (!recentlyAddedEntryId || !targetEntries.some((entry) => entry.id === recentlyAddedEntryId)) return;
    glossaryListRef.current?.scrollTo({ top: 0, behavior: 'auto' });
    setRecentlyAddedEntryId('');
  }, [recentlyAddedEntryId, targetEntries]);

  return (
    <>
      <div className={`glossary-drawer-backdrop${open ? ' is-open' : ''}`} onClick={onClose} aria-hidden="true" />
      <aside className={`glossary-drawer${open ? ' is-open' : ''}`} aria-label="本次翻譯字典" aria-hidden={!open}>
        <div className="glossary-drawer-header">
          <div>
            <p className="eyebrow">即時字幕</p>
            <h2>本次使用字典</h2>
            <p>{readOnly ? '這些詞條來自會議建立設定；如需修改，請回會議管理。' : '選取的詞條會套用到本次翻譯與後續分段。'}</p>
          </div>
          <button className="icon-button dialog-close-button" type="button" onClick={onClose} aria-label="關閉字典" tabIndex={open ? 0 : -1}>
            <X size={20} aria-hidden="true" />
          </button>
        </div>

        <div className="glossary-drawer-body">
          {isLoading ? <p className="history-empty">正在載入字典…</p> : null}
          {error ? <p className="error-message" role="alert">{error}</p> : null}
          {!isLoading && targetEntries.length === 0 ? (
            <div className="glossary-drawer-empty">
              <BookOpen size={28} aria-hidden="true" />
              <strong>目前沒有可用詞條</strong>
              <p>新增常用名稱或專有名詞，讓翻譯更一致。</p>
            </div>
          ) : null}
          {targetEntries.length > 0 ? (
            <div className="glossary-drawer-list" ref={glossaryListRef}>
              {targetEntries.map((entry) => (
                <label className={`glossary-choice${selectedEntryIds.includes(entry.id) ? ' is-selected' : ''}`} key={entry.id}>
                  <input
                    type="checkbox"
                    checked={selectedEntryIds.includes(entry.id)}
                    onChange={(event) => onSelectionChange((current) => event.target.checked
                      ? [...new Set([...current, entry.id])]
                      : current.filter((id) => id !== entry.id))}
                    disabled={settingsDisabled}
                    tabIndex={open ? 0 : -1}
                  />
                  <span>
                    <strong>{entry.source}</strong>
                    <small>{entry.target}</small>
                  </span>
                </label>
              ))}
            </div>
          ) : null}

          {!readOnly ? (
            <div className="glossary-quick-add">
              <h3>快速新增詞條</h3>
              <label className="field">
                <span>原文</span>
                <input value={source} onChange={(event) => setSource(event.target.value)} placeholder="例如：產品名稱" disabled={settingsDisabled || isSaving} tabIndex={open ? 0 : -1} />
              </label>
              <label className="field">
                <span>翻譯（{targetLanguageLabelFor(targetLanguageCode) || targetLanguageCode}）</span>
                <input value={translation} onChange={(event) => setTranslation(event.target.value)} placeholder="例如：正式翻譯" disabled={settingsDisabled || isSaving} tabIndex={open ? 0 : -1} />
              </label>
              <button className="button primary" type="button" onClick={saveQuickEntry} disabled={!canSave} tabIndex={open ? 0 : -1}>
                {isSaving ? '儲存中…' : '新增並套用'}
              </button>
              {status ? <p className="success-message" role="status">{status}</p> : null}
            </div>
          ) : null}
        </div>

        <div className="glossary-drawer-footer">
          <button className="button secondary" type="button" onClick={onOpenManager} tabIndex={open ? 0 : -1}>{readOnly ? '回會議管理修改' : '前往完整字典管理'}</button>
        </div>
      </aside>
    </>
  );
}

export function GlobalGlossaryPanel({ entries: sharedEntries = [], onEntriesChange, categories: sharedCategories = [], onCategoriesChange }) {
  const [entries, setEntries] = useState(sharedEntries);
  const [query, setQuery] = useState('');
  const [category, setCategory] = useState('all');
  const [language, setLanguage] = useState('all');
  const [sort, setSort] = useState('updated');
  const [selectedIds, setSelectedIds] = useState([]);
  const [editingEntry, setEditingEntry] = useState(null);
  const [isDrawerOpen, setIsDrawerOpen] = useState(false);
  const [hasAttemptedEntrySave, setHasAttemptedEntrySave] = useState(false);
  const [isLoading, setIsLoading] = useState(true);
  const [isSaving, setIsSaving] = useState(false);
  const [isBulkSaving, setIsBulkSaving] = useState(false);
  const [status, setStatus] = useState('');
  const [error, setError] = useState('');
  const [categories, setCategories] = useState(sharedCategories);
  const [isCategoryDialogOpen, setIsCategoryDialogOpen] = useState(false);
  const [editingCategory, setEditingCategory] = useState(null);
  const [categoryLabel, setCategoryLabel] = useState('');
  const [categoryQuery, setCategoryQuery] = useState('');
  const [isMoreCategoriesOpen, setIsMoreCategoriesOpen] = useState(false);
  const [isCategorySaving, setIsCategorySaving] = useState(false);
  const [importPreview, setImportPreview] = useState(null);
  const [importFile, setImportFile] = useState(null);
  const [importResolutions, setImportResolutions] = useState({});
  const [importSelectedRows, setImportSelectedRows] = useState([]);
  const [importSourceLanguageCode, setImportSourceLanguageCode] = useState(DEFAULT_SOURCE_LANGUAGE_CODE);
  const [importTargetLanguageCode, setImportTargetLanguageCode] = useState('en');
  const [importCategory, setImportCategory] = useState('other');
  const [isImportDialogOpen, setIsImportDialogOpen] = useState(false);
  const [isImporting, setIsImporting] = useState(false);
  const entriesRef = useRef([]);
  const editorFormRef = useRef(null);
  const apiRef = useRef(createGlossaryApiClient());

  useBodyScrollLock(isImportDialogOpen);

  useEffect(() => { entriesRef.current = sharedEntries; setEntries(sharedEntries); }, [sharedEntries]);
  useEffect(() => { setCategories(sharedCategories); }, [sharedCategories]);
  useEffect(() => {
    let cancelled = false;
    Promise.all([apiRef.current.listEntries(), apiRef.current.listCategories()]).then(([loaded, loadedCategories]) => {
      if (!cancelled) { entriesRef.current = loaded; setEntries(loaded); setCategories(loadedCategories); onEntriesChange?.(loaded); onCategoriesChange?.(loadedCategories); setError(''); }
    }).catch(() => { if (!cancelled) setError('無法載入全域字典，請稍後再試。'); })
      .finally(() => { if (!cancelled) setIsLoading(false); });
    return () => { cancelled = true; };
  }, []);

  const categoryOptions = useMemo(() => [
    { value: 'all', label: '全部分類' },
    ...(categories.length > 0 ? categories : DEFAULT_GLOSSARY_CATEGORIES).map((item) => ({ value: item.id, label: item.label }))
  ], [categories]);
  const categoryCounts = useMemo(() => {
    const counts = new Map([['all', entries.length]]);
    entries.forEach((entry) => {
      const entryCategory = entry.category || 'other';
      counts.set(entryCategory, (counts.get(entryCategory) || 0) + 1);
    });
    return counts;
  }, [entries]);
  const quickCategoryOptions = categoryOptions.length > 9
    ? [...categoryOptions.slice(0, 8), categoryOptions[categoryOptions.length - 1]]
    : categoryOptions;
  const quickCategoryIds = new Set(quickCategoryOptions.map((item) => item.value));
  const overflowCategoryOptions = categoryOptions.filter((item) => !quickCategoryIds.has(item.value));
  const filteredCategories = useMemo(() => {
    const normalizedQuery = categoryQuery.trim().toLocaleLowerCase();
    return categories.filter((item) => !normalizedQuery || item.label.toLocaleLowerCase().includes(normalizedQuery) || item.id.toLocaleLowerCase().includes(normalizedQuery));
  }, [categories, categoryQuery]);

  useEffect(() => {
    if (!isDrawerOpen) return undefined;
    const handleKeyDown = (event) => {
      if (event.key === 'Escape') closeEditor();
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [isDrawerOpen]);

  const filteredEntries = useMemo(() => {
    const normalizedQuery = query.trim().toLocaleLowerCase();
    return [...entries].filter((entry) => {
      const text = [entry.source, entry.notes, ...(entry.tags || []), ...Object.values(entry.translations || {})].join(' ').toLocaleLowerCase();
      return (!normalizedQuery || text.includes(normalizedQuery)) && (category === 'all' || (entry.category || 'other') === category) && (language === 'all' || Object.hasOwn(entry.translations || {}, language));
    }).sort((a, b) => sort === 'source' ? a.source.localeCompare(b.source) : sort === 'created' ? String(b.createdAt || '').localeCompare(String(a.createdAt || '')) : String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')));
  }, [entries, query, category, language, sort]);

  const allVisibleSelected = filteredEntries.length > 0 && filteredEntries.every((entry) => selectedIds.includes(entry.id));
  function publish(next) { entriesRef.current = next; setEntries(next); onEntriesChange?.(next); }
  function openEditor(entry = null) { setEditingEntry(entry ? { ...entry, translations: { ...entry.translations }, tags: [...(entry.tags || [])] } : { source: '', sourceLanguageCode: 'zh-Hant', translations: { en: '' }, category: categories.find((item) => item.id === 'other')?.id || categories[0]?.id || 'other', tags: [], enabled: true, notes: '', scope: 'both' }); setHasAttemptedEntrySave(false); setStatus(''); setError(''); setIsDrawerOpen(true); }
  function closeEditor() { if (isSaving) return; setIsDrawerOpen(false); setEditingEntry(null); setHasAttemptedEntrySave(false); }
  function updateEditor(field, value) { setEditingEntry((current) => ({ ...current, [field]: value })); }
  function updateTranslation(code, value) { setEditingEntry((current) => ({ ...current, translations: { ...current.translations, [code]: value } })); }
  function addTranslation() {
    setEditingEntry((current) => {
      const nextLanguage = SUPPORTED_LANGUAGES.find(({ code }) => !Object.hasOwn(current.translations || {}, code));
      if (!nextLanguage) return current;
      return { ...current, translations: { ...current.translations, [nextLanguage.code]: '' } };
    });
  }
  function changeTranslationLanguage(currentCode, nextCode) {
    if (currentCode === nextCode) return;
    setEditingEntry((current) => {
      if (Object.hasOwn(current.translations || {}, nextCode)) return current;
      return {
        ...current,
        translations: Object.fromEntries(Object.entries(current.translations || {}).map(([code, text]) => (
          [code === currentCode ? nextCode : code, text]
        )))
      };
    });
  }
  function removeTranslation(code) { setEditingEntry((current) => { const translations = { ...current.translations }; delete translations[code]; return { ...current, translations }; }); }
  async function saveEntry(event) {
    event.preventDefault();
    const translations = Object.fromEntries(Object.entries(editingEntry.translations || {}).filter(([, value]) => value.trim()));
    const hasBlankTranslation = Object.values(editingEntry.translations || {}).some((value) => !value.trim());
    setHasAttemptedEntrySave(true);
    if (!editingEntry.source.trim() || !Object.keys(translations).length || hasBlankTranslation) {
      setError('');
      requestAnimationFrame(() => editorFormRef.current?.querySelector('[aria-invalid="true"]')?.focus());
      return;
    }
    setIsSaving(true); setError(''); setStatus('');
    try {
      const payload = { ...editingEntry, source: editingEntry.source.trim(), translations, tags: editingEntry.tags || [], scope: 'live' };
      const saved = editingEntry.id ? await apiRef.current.updateEntry(editingEntry.id, payload) : await apiRef.current.createEntry(payload);
      publish(editingEntry.id ? entriesRef.current.map((entry) => entry.id === saved.id ? saved : entry) : mergeGlossaryEntry(entriesRef.current, saved));
      closeEditor(); setStatus(editingEntry.id ? '全域詞條已更新。' : '全域詞條已新增。');
    } catch { setError('無法儲存全域詞條。請確認欄位內容正確。'); } finally { setIsSaving(false); }
  }
  async function deleteEntry(entry) {
    if (!window.confirm(`確定要刪除「${entry.source}」嗎？`)) return;
    try { await apiRef.current.deleteEntry(entry.id); publish(entriesRef.current.filter((item) => item.id !== entry.id)); setSelectedIds((ids) => ids.filter((id) => id !== entry.id)); closeEditor(); setStatus('全域詞條已刪除。'); } catch { setError('無法刪除全域詞條。'); }
  }
  async function bulkUpdate(patch) {
    const targetIds = [...selectedIds];
    setIsBulkSaving(true); setError(''); setStatus('');
    try {
      const updated = [];
      for (const id of targetIds) {
        const entry = entriesRef.current.find((item) => item.id === id);
        updated.push(await apiRef.current.updateEntry(id, { ...entry, ...patch }));
      }
      const map = new Map(updated.map((entry) => [entry.id, entry])); publish(entriesRef.current.map((entry) => map.get(entry.id) || entry)); setSelectedIds([]); setStatus(`已批次${patch.enabled ? '啟用' : '停用'} ${updated.length} 筆全域詞條。`);
    } catch { setError('批次操作失敗，請稍後再試。'); }
    finally { setIsBulkSaving(false); }
  }
  async function bulkDelete() {
    const targetIds = [...selectedIds];
    if (!targetIds.length || !window.confirm(`確定要刪除已選取的 ${targetIds.length} 筆全域詞條嗎？此操作無法復原。`)) return;
    const deletedIds = [];
    setIsBulkSaving(true); setError(''); setStatus('');
    try {
      for (const id of targetIds) {
        await apiRef.current.deleteEntry(id);
        deletedIds.push(id);
      }
      const deletedIdSet = new Set(deletedIds);
      publish(entriesRef.current.filter((entry) => !deletedIdSet.has(entry.id)));
      setSelectedIds((ids) => ids.filter((id) => !deletedIdSet.has(id)));
      setStatus(`已刪除 ${deletedIds.length} 筆全域詞條。`);
    } catch {
      const deletedIdSet = new Set(deletedIds);
      if (deletedIds.length) {
        publish(entriesRef.current.filter((entry) => !deletedIdSet.has(entry.id)));
        setSelectedIds((ids) => ids.filter((id) => !deletedIdSet.has(id)));
      }
      setError(deletedIds.length ? `已刪除 ${deletedIds.length} 筆，其餘詞條尚未刪除，請再試一次。` : '無法批次刪除全域詞條，請稍後再試。');
    } finally { setIsBulkSaving(false); }
  }
  function toggleAllVisible() {
    setSelectedIds(allVisibleSelected
      ? selectedIds.filter((id) => !filteredEntries.some((entry) => entry.id === id))
      : [...new Set([...selectedIds, ...filteredEntries.map((entry) => entry.id)])]);
  }
  function publishCategories(next) { setCategories(next); onCategoriesChange?.(next); }
  function openCategoryManager() { setEditingCategory(null); setCategoryLabel(''); setCategoryQuery(''); setIsCategoryDialogOpen(true); setError(''); }
  async function saveCategory(event) {
    event.preventDefault();
    if (!categoryLabel.trim()) { setError('分類名稱不可為空白。'); return; }
    setIsCategorySaving(true); setError('');
    try {
      const wasEditingCategory = Boolean(editingCategory);
      const saved = wasEditingCategory ? await apiRef.current.updateCategory(editingCategory.id, { label: categoryLabel.trim() }) : await apiRef.current.createCategory({ label: categoryLabel.trim() });
      publishCategories(editingCategory ? categories.map((item) => item.id === saved.id ? saved : item) : [...categories, saved]);
      setEditingCategory(null); setCategoryLabel(''); setStatus(editingCategory ? '分類名稱已更新。' : '分類已新增。');
      if (!wasEditingCategory && importPreview && importFile) {
        const nextSettings = { sourceLanguageCode: importSourceLanguageCode, targetLanguageCode: importTargetLanguageCode, category: saved.id };
        setImportCategory(saved.id);
        setIsImporting(true); setError('');
        try {
          const preview = await apiRef.current.previewImport({ ...importFile, ...nextSettings });
          setImportPreview(preview); setImportResolutions({}); setImportSelectedRows(defaultSelectedImportRows(preview));
        } catch (operationError) {
          setError(glossaryImportErrorMessage(operationError, '分類已新增，但無法更新匯入預覽。'));
        } finally { setIsImporting(false); }
      }
    } catch (operationError) { setError(glossaryOperationErrorMessage(operationError, '分類名稱不可空白或重複。')); }
    finally { setIsCategorySaving(false); }
  }
  async function moveCategory(category, direction) {
    const index = categories.findIndex((item) => item.id === category.id); const nextIndex = index + direction;
    if (nextIndex < 0 || nextIndex >= categories.length) return;
    const next = [...categories]; [next[index], next[nextIndex]] = [next[nextIndex], next[index]];
    try { publishCategories(await apiRef.current.reorderCategories(next.map((item) => item.id))); setStatus('分類順序已更新。'); } catch (operationError) { setError(glossaryOperationErrorMessage(operationError, '無法更新分類順序。')); }
  }
  async function deleteCategory(category) {
    if (category.id === 'other' || !window.confirm(`確定要刪除「${category.label}」嗎？相關詞條會改歸其他。`)) return;
    try { const result = await apiRef.current.deleteCategory(category.id); publishCategories(categories.filter((item) => item.id !== category.id)); publish(entriesRef.current.map((entry) => entry.category === category.id ? { ...entry, category: 'other' } : entry)); setStatus(`分類已刪除，${result.reassignedEntryCount || 0} 筆詞條已改歸其他。`); } catch { setError('無法刪除分類。'); }
  }
  async function previewGlossaryImport(event) {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;
    const extension = file.name.toLowerCase().endsWith('.json') ? 'json' : file.name.toLowerCase().endsWith('.xlsx') ? 'xlsx' : file.name.toLowerCase().endsWith('.csv') ? 'csv' : null;
    if (!extension) { setError('請選擇 CSV、JSON 或 XLSX 檔案。'); return; }
    setIsImporting(true); setError(''); setStatus('');
    try {
      const content = extension === 'xlsx' ? arrayBufferToBase64(await file.arrayBuffer()) : await file.text();
      const preview = await apiRef.current.previewImport({ format: extension, content, sourceLanguageCode: DEFAULT_SOURCE_LANGUAGE_CODE, targetLanguageCode: 'en', category: 'other' });
      setImportFile({ name: file.name, format: extension, content });
      setImportPreview(preview); setImportResolutions({}); setImportSelectedRows(defaultSelectedImportRows(preview)); setImportSourceLanguageCode(DEFAULT_SOURCE_LANGUAGE_CODE); setImportTargetLanguageCode('en'); setImportCategory('other');
    } catch (operationError) { setError(glossaryImportErrorMessage(operationError, '無法預覽匯入檔案。')); }
    finally { setIsImporting(false); }
  }
  function openImportDialog() {
    setError(''); setStatus(''); setImportSourceLanguageCode(DEFAULT_SOURCE_LANGUAGE_CODE); setImportTargetLanguageCode('en'); setImportCategory('other'); setIsImportDialogOpen(true);
  }
  function closeImportDialog() {
    if (isImporting) return;
    setIsImportDialogOpen(false); setImportPreview(null); setImportFile(null); setImportResolutions({}); setImportSelectedRows([]); setImportSourceLanguageCode(DEFAULT_SOURCE_LANGUAGE_CODE); setImportTargetLanguageCode('en'); setImportCategory('other');
  }
  async function changeImportSetting(setting, value) {
    if (!importFile) return;
    const nextSettings = { sourceLanguageCode: importSourceLanguageCode, targetLanguageCode: importTargetLanguageCode, category: importCategory, [setting]: value };
    if (setting === 'sourceLanguageCode') setImportSourceLanguageCode(value);
    if (setting === 'targetLanguageCode') setImportTargetLanguageCode(value);
    if (setting === 'category') setImportCategory(value);
    setIsImporting(true); setError('');
    try {
      const preview = await apiRef.current.previewImport({ ...importFile, ...nextSettings });
      setImportPreview(preview); setImportResolutions({}); setImportSelectedRows(defaultSelectedImportRows(preview));
    } catch (operationError) { setError(glossaryImportErrorMessage(operationError, '無法更新匯入設定。')); }
    finally { setIsImporting(false); }
  }
  async function commitGlossaryImport() {
    if (!importPreview || !importFile) return;
    setIsImporting(true); setError('');
    try {
      const result = await apiRef.current.importEntries({ ...importFile, sourceLanguageCode: importSourceLanguageCode, targetLanguageCode: importTargetLanguageCode, category: importCategory, baseRevision: importPreview.baseRevision, resolutions: importResolutions, selectedRows: importSelectedRows });
      const [loaded, loadedCategories] = await Promise.all([apiRef.current.listEntries(), apiRef.current.listCategories()]);
      publish(loaded); publishCategories(loadedCategories); setIsImportDialogOpen(false); setImportPreview(null); setImportFile(null); setImportResolutions({}); setImportSelectedRows([]); setImportSourceLanguageCode(DEFAULT_SOURCE_LANGUAGE_CODE); setImportTargetLanguageCode('en'); setImportCategory('other');
      setStatus(`匯入完成：新增 ${result.createdCount} 筆、更新 ${result.updatedCount} 筆、跳過 ${result.skippedCount} 筆。`);
    } catch (operationError) { setError(glossaryImportErrorMessage(operationError, '匯入失敗，請重新預覽檔案。')); }
    finally { setIsImporting(false); }
  }

  return <section className="global-glossary" aria-label="全域字典詞條管理">
    <div className="global-glossary-toolbar">
      <div className="global-glossary-toolbar-main">
        <label className="field glossary-search"><span>搜尋詞條</span><div className="meeting-toolbar-input"><Search size={19} aria-hidden="true" /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜尋原文、翻譯或標籤" /></div></label>
        <div className="global-glossary-primary-actions"><button className="button secondary" type="button" onClick={openCategoryManager}><Settings size={18} aria-hidden="true" />管理分類</button><button className="button secondary" type="button" onClick={openImportDialog}><Download size={18} aria-hidden="true" />匯入字典</button><button className="button primary" type="button" onClick={() => openEditor()}><Plus size={18} aria-hidden="true" />新增詞條</button></div>
      </div>
      <div className="global-glossary-filter-row">
        <label className="field"><span>目標語言</span><select value={language} onChange={(event) => setLanguage(event.target.value)}><option value="all">所有語言</option>{SUPPORTED_LANGUAGES.map((item) => <option key={item.code} value={item.code}>{item.label}</option>)}</select></label>
        <label className="field"><span>排序</span><select value={sort} onChange={(event) => setSort(event.target.value)}><option value="updated">最近更新</option><option value="created">最近建立</option><option value="source">原文 A–Z</option></select></label>
        <button className="button secondary" type="button" onClick={() => { setQuery(''); setCategory('all'); setLanguage('all'); }}><Filter size={17} aria-hidden="true" />清除篩選</button>
      </div>
    </div>
    {selectedIds.length ? <div className="glossary-bulk-bar" role="toolbar" aria-label="已選詞條的批次操作" aria-busy={isBulkSaving}><strong>已選取 {selectedIds.length} 筆</strong><div className="glossary-bulk-actions" role="group" aria-label="批次操作"><button className="button primary glossary-bulk-action glossary-bulk-enable" type="button" onClick={() => bulkUpdate({ enabled: true })} disabled={isBulkSaving}><Check size={17} aria-hidden="true" />批次啟用</button><button className="button secondary glossary-bulk-action glossary-bulk-disable" type="button" onClick={() => bulkUpdate({ enabled: false })} disabled={isBulkSaving}><Pause size={17} aria-hidden="true" />批次停用</button><button className="button danger-button glossary-bulk-action glossary-bulk-delete" type="button" onClick={bulkDelete} disabled={isBulkSaving}><Trash2 size={17} aria-hidden="true" />批次刪除</button></div></div> : null}
    {status ? <p className="success-message" role="status">{status}</p> : null}{error ? <p className="error-message" role="alert">{error}</p> : null}
    {isImportDialogOpen ? <><div className="global-glossary-dialog-backdrop" onClick={closeImportDialog} aria-hidden="true" /><section className={`global-glossary-dialog ${importPreview ? 'glossary-import-dialog' : 'glossary-import-help-dialog'}`} role="dialog" aria-modal="true" aria-labelledby={importPreview ? 'glossary-import-title' : 'glossary-import-help-title'}><div className="global-glossary-dialog-header"><div><p className="eyebrow">{importPreview ? 'IMPORT PREVIEW' : 'IMPORT FORMAT'}</p><h2 id={importPreview ? 'glossary-import-title' : 'glossary-import-help-title'}>{importPreview ? `預覽匯入：${importFile?.name}` : '匯入字典'}</h2>{importPreview ? <p className="category-management-summary">共 {importPreview.summary.total} 筆，新增 {importPreview.summary.creates} 筆，重複 {importPreview.summary.duplicates} 筆，錯誤 {importPreview.summary.invalid} 筆；已選 {importSelectedRows.length} 筆</p> : null}</div><button className="icon-button" type="button" aria-label="關閉匯入字典" onClick={closeImportDialog} disabled={isImporting}><X size={20} aria-hidden="true" /></button></div>{importPreview ? <><div className="glossary-import-settings"><label className="field"><span>來源語言</span><select value={importSourceLanguageCode} onChange={(event) => changeImportSetting('sourceLanguageCode', event.target.value)} disabled={isImporting}>{SUPPORTED_LANGUAGES.map((item) => <option key={item.code} value={item.code}>{item.label}</option>)}</select></label><label className="field"><span>目標語言</span><select value={importTargetLanguageCode} onChange={(event) => changeImportSetting('targetLanguageCode', event.target.value)} disabled={isImporting}>{SUPPORTED_LANGUAGES.map((item) => <option key={item.code} value={item.code}>{item.label}</option>)}</select></label><div className="glossary-import-category-control"><label className="field"><span>分類</span><select value={importCategory} onChange={(event) => changeImportSetting('category', event.target.value)} disabled={isImporting || categories.length === 0}>{categories.map((item) => <option key={item.id} value={item.id}>{item.label}</option>)}</select>{categories.length === 0 ? <small className="glossary-import-category-empty">尚無分類，請新增分類。</small> : null}</label><button className="button secondary" type="button" onClick={openCategoryManager} disabled={isImporting}><Plus size={17} aria-hidden="true" />新增分類</button></div></div><div className="glossary-import-preview-list"><div className="glossary-import-selection-bar"><label><input type="checkbox" aria-label="全選可匯入項目" checked={importPreview.rows.some((row) => row.errors.length === 0 && row.status !== 'duplicate') && importPreview.rows.filter((row) => row.errors.length === 0 && row.status !== 'duplicate').every((row) => importSelectedRows.includes(row.rowNumber))} onChange={() => setImportSelectedRows((current) => current.length === importPreview.rows.filter((row) => row.errors.length === 0 && row.status !== 'duplicate').length ? [] : importPreview.rows.filter((row) => row.errors.length === 0 && row.status !== 'duplicate').map((row) => row.rowNumber))} disabled={isImporting} />全選／取消全選</label><span>錯誤與重複列無法選取，會自動略過</span></div>{importPreview.rows.map((row) => <div className={`glossary-import-row is-${row.status}${importSelectedRows.includes(row.rowNumber) ? ' is-selected' : ''}`} key={row.rowNumber}><label className="glossary-import-row-selection"><input type="checkbox" aria-label={`選取第 ${row.rowNumber} 列`} checked={importSelectedRows.includes(row.rowNumber)} onChange={() => setImportSelectedRows((current) => current.includes(row.rowNumber) ? current.filter((rowNumber) => rowNumber !== row.rowNumber) : [...current, row.rowNumber])} disabled={isImporting || row.errors.length > 0 || row.status === 'duplicate'} /><span /></label><div><strong>第 {row.rowNumber} 列{row.errors.map((item) => <small className="error-message" key={item}>{glossaryImportRowErrorMessage(item)}</small>)}</strong>{row.warnings?.map((item) => <small className="warning-message" key={item}>{glossaryImportRowErrorMessage(item)}</small>)}<span className="import-entry-preview"><strong>{row.entry?.source || '未提供原文'}</strong><span className="import-entry-arrow" aria-hidden="true">→</span><span className="import-entry-translation">{row.entry?.translations?.[importTargetLanguageCode] || '未提供翻譯'}</span></span></div>{row.status === 'conflict' ? <label className="field"><span>重複處理</span><select aria-label={`第 ${row.rowNumber} 列重複處理`} value={importResolutions[String(row.rowNumber)] || ''} onChange={(event) => setImportResolutions((current) => ({ ...current, [row.rowNumber]: event.target.value }))}><option value="">請選擇</option><option value="update">更新既有詞條</option><option value="skip">跳過</option></select></label> : <span>{row.status === 'create' ? '新增' : row.status === 'duplicate' ? '重複，略過' : '錯誤，略過'}</span>}</div>)}</div><div className="global-glossary-dialog-actions"><button className="button secondary" type="button" onClick={closeImportDialog} disabled={isImporting}>取消</button><button className="button primary" type="button" onClick={commitGlossaryImport} disabled={isImporting || categories.length === 0 || !importCategory || importSelectedRows.length === 0 || importPreview.rows.some((row) => importSelectedRows.includes(row.rowNumber) && row.status === 'conflict' && !importResolutions[String(row.rowNumber)])}>{isImporting ? '匯入中…' : '確認匯入'}</button></div></> : <div className="glossary-import-help-content"><p>支援 CSV、JSON 與 XLSX。每筆資料只需要原文與翻譯；來源語言、目標語言與分類會在選檔後設定。</p><h3>XLSX 格式</h3><p>第一個工作表的第一列請使用 <code>source</code> 與 <code>translation</code> 欄位，資料從第二列開始。</p><h3>CSV 範例</h3><pre><code>{'source,translation\n產品名稱,Product name\n會議室,Meeting room\n翻譯結果,Translation result'}</code></pre><h3>JSON 範例</h3><pre><code>{'{\n  "entries": [\n    { "source": "產品名稱", "translation": "Product name" },\n    { "source": "會議室", "translation": "Meeting room" },\n    { "source": "翻譯結果", "translation": "Translation result" }\n  ]\n}'}</code></pre><p className="export-note">每次匯入使用一組來源語言、目標語言與分類；需要新分類時，可直接在預覽的分類欄位新增。</p><div className="global-glossary-dialog-actions"><input className="sr-only" type="file" accept=".csv,.json,.xlsx,text/csv,application/json,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" id="global-glossary-import-file" onChange={previewGlossaryImport} /><label className="button primary" htmlFor="global-glossary-import-file">選擇 CSV／JSON／XLSX 檔案</label><button className="button secondary" type="button" onClick={closeImportDialog}>取消</button></div></div>}</section></> : null}
    <div className="global-glossary-layout"><aside className="glossary-category-sidebar"><div className="glossary-sidebar-heading"><strong>詞條分類</strong><span>{entries.length}</span></div>{quickCategoryOptions.map((item) => <button className={category === item.value ? 'is-active' : ''} key={item.value} type="button" onClick={() => setCategory(item.value)}><span>{item.label}</span><small>{categoryCounts.get(item.value) || 0}</small></button>)}{overflowCategoryOptions.length ? <div className="glossary-category-more"><button className={overflowCategoryOptions.some((item) => item.value === category) ? 'is-active' : ''} type="button" aria-expanded={isMoreCategoriesOpen} onClick={() => setIsMoreCategoriesOpen((open) => !open)}><span>更多分類</span><small>{overflowCategoryOptions.length}</small></button>{isMoreCategoriesOpen ? <div className="glossary-category-more-menu" role="menu">{overflowCategoryOptions.map((item) => <button className={category === item.value ? 'is-active' : ''} key={item.value} type="button" role="menuitem" onClick={() => { setCategory(item.value); setIsMoreCategoriesOpen(false); }}><span>{item.label}</span><small>{categoryCounts.get(item.value) || 0}</small></button>)}</div> : null}</div> : null}</aside><label className="glossary-mobile-category field"><span>分類</span><select value={category} onChange={(event) => setCategory(event.target.value)}>{categoryOptions.map((item) => <option key={item.value} value={item.value}>{item.label}（{categoryCounts.get(item.value) || 0}）</option>)}</select></label><div className="glossary-card-region"><div className="glossary-card-region-header"><span>{isLoading ? '載入中…' : `共 ${filteredEntries.length} 筆詞條`}</span><button className="button secondary glossary-select-all" type="button" aria-pressed={allVisibleSelected} onClick={toggleAllVisible} disabled={isLoading || filteredEntries.length === 0}>{allVisibleSelected ? '取消全選目前結果' : '全選目前結果'}</button></div>{!isLoading && !filteredEntries.length ? <div className="empty-state glossary-empty"><BookOpen size={30} aria-hidden="true" /><strong>找不到符合條件的詞條</strong><span>調整搜尋或新增一筆全域詞條。</span></div> : <div className="glossary-card-grid">{filteredEntries.map((entry) => <article className={`glossary-card${entry.enabled === false ? ' is-disabled' : ''}`} key={entry.id} onClick={() => openEditor(entry)}><div className="glossary-card-topline"><input type="checkbox" aria-label={`選取 ${entry.source}`} checked={selectedIds.includes(entry.id)} onClick={(event) => event.stopPropagation()} onChange={() => setSelectedIds((ids) => ids.includes(entry.id) ? ids.filter((id) => id !== entry.id) : [...ids, entry.id])} /><span className={`glossary-status ${entry.enabled === false ? 'is-disabled' : ''}`}><span />{entry.enabled === false ? '已停用' : '啟用中'}</span><button className="icon-button" type="button" aria-label={`更多操作：${entry.source}`} onClick={(event) => { event.stopPropagation(); openEditor(entry); }}><MoreHorizontal size={19} aria-hidden="true" /></button></div><div className="glossary-card-source"><small>{targetLanguageLabelFor(entry.sourceLanguageCode) || entry.sourceLanguageCode || '來源語言'}</small><h3>{entry.source}</h3></div><div className="glossary-card-translations">{Object.entries(entry.translations || {}).slice(0, 2).map(([code, text]) => <div key={code}><small>{targetLanguageLabelFor(code) || code}</small><p>{text}</p></div>)}{Object.keys(entry.translations || {}).length > 2 ? <small>+{Object.keys(entry.translations).length - 2} 個翻譯</small> : null}</div><div className="glossary-card-footer"><span className="glossary-category-tag">{categoryOptions.find((item) => item.value === (entry.category || 'other'))?.label}</span>{entry.tags?.slice(0, 2).map((tag) => <span className="glossary-tag" key={tag}><Tag size={12} aria-hidden="true" />{tag}</span>)}</div></article>)}</div>}</div></div>
    {isDrawerOpen && editingEntry ? <>
      <div className="global-glossary-dialog-backdrop" onClick={closeEditor} aria-hidden="true" />
      <section className="global-glossary-dialog glossary-editor-dialog" role="dialog" aria-modal="true" aria-labelledby="global-glossary-editor-title" onClick={(event) => event.stopPropagation()}>
        <div className="global-glossary-dialog-header">
          <div>
            <p className="eyebrow">GLOBAL ENTRY</p>
            <h2 id="global-glossary-editor-title">{editingEntry.id ? '編輯詞條' : '新增詞條'}</h2>
            <p className="global-glossary-editor-summary">管理原文字詞，並為同一詞條維護多種目標語言翻譯。</p>
          </div>
          <button className="icon-button dialog-close-button" type="button" aria-label="關閉編輯對話框" onClick={closeEditor} disabled={isSaving}><X size={20} aria-hidden="true" /></button>
        </div>
        <form ref={editorFormRef} className="global-glossary-form" onSubmit={saveEntry} noValidate aria-busy={isSaving}>
          <div className="global-glossary-form-body">
            <div className="glossary-form-section glossary-basic-section">
              <div className="glossary-form-section-heading">
                <div><strong>基本資料</strong><small>設定詞條原文、來源語言與管理資訊。</small></div>
              </div>
              <div className="glossary-form-grid">
                <label className="field">
                  <span>原文字詞</span>
                  <input value={editingEntry.source} onChange={(event) => updateEditor('source', event.target.value)} aria-invalid={hasAttemptedEntrySave && !editingEntry.source.trim()} aria-describedby={hasAttemptedEntrySave && !editingEntry.source.trim() ? 'glossary-source-error' : undefined} autoFocus />
                  {hasAttemptedEntrySave && !editingEntry.source.trim() ? <small id="glossary-source-error" className="glossary-field-error" role="alert">請輸入原文字詞。</small> : null}
                </label>
                <label className="field"><span>來源語言</span><select value={editingEntry.sourceLanguageCode} onChange={(event) => updateEditor('sourceLanguageCode', event.target.value)}>{SUPPORTED_LANGUAGES.map((item) => <option key={item.code} value={item.code}>{item.label}</option>)}</select></label>
              </div>
              <div className="glossary-form-grid">
                <label className="field"><span>分類</span><select value={editingEntry.category} onChange={(event) => updateEditor('category', event.target.value)}>{categoryOptions.slice(1).map((item) => <option key={item.value} value={item.value}>{item.label}</option>)}</select></label>
                <label className="field"><span>標籤（以逗號分隔）</span><input value={(editingEntry.tags || []).join(', ')} onChange={(event) => updateEditor('tags', event.target.value.split(',').map((tag) => tag.trim()).filter(Boolean))} placeholder="例如：產品、Q3" /></label>
              </div>
              <label className="field"><span>備註</span><textarea rows="4" value={editingEntry.notes || ''} onChange={(event) => updateEditor('notes', event.target.value)} placeholder="補充使用情境或翻譯說明" /></label>
            </div>

            <div className="glossary-form-section glossary-translation-section">
              <div className="glossary-form-section-heading">
                <div><strong>目標語言翻譯 <span className="glossary-translation-count">{Object.keys(editingEntry.translations || {}).length} 種語言</span></strong><small>每種語言只能加入一次，請填寫對應的正式翻譯。</small></div>
                <button className="button secondary glossary-add-translation" type="button" onClick={addTranslation} disabled={isSaving || Object.keys(editingEntry.translations || {}).length >= SUPPORTED_LANGUAGES.length}><Plus size={17} aria-hidden="true" />新增翻譯語言</button>
              </div>
              <div className="translation-list">
                {Object.entries(editingEntry.translations || {}).map(([code, text], index) => <div className="translation-row" key={code}>
                  <span className="translation-row-number" aria-hidden="true">{index + 1}</span>
                  <label className="field translation-language-field"><span>目標語言</span><select aria-label="翻譯語言" value={code} onChange={(event) => changeTranslationLanguage(code, event.target.value)}>{SUPPORTED_LANGUAGES.map((item) => <option key={item.code} value={item.code} disabled={item.code !== code && Object.hasOwn(editingEntry.translations || {}, item.code)}>{item.label}</option>)}</select></label>
                  <label className="field translation-value-field"><span>翻譯內容</span><input aria-label={`翻譯內容：${code}`} value={text} onChange={(event) => updateTranslation(code, event.target.value)} aria-invalid={hasAttemptedEntrySave && !text.trim()} aria-describedby={hasAttemptedEntrySave && !text.trim() ? `translation-error-${code}` : undefined} placeholder="輸入翻譯" />{hasAttemptedEntrySave && !text.trim() ? <small id={`translation-error-${code}`} className="glossary-field-error" role="alert">請輸入{targetLanguageLabelFor(code) || code}翻譯。</small> : null}</label>
                  <button className="icon-button translation-remove-button" type="button" aria-label={`移除${targetLanguageLabelFor(code) || code}翻譯`} onClick={() => removeTranslation(code)} disabled={isSaving || Object.keys(editingEntry.translations).length <= 1}><Trash2 size={17} aria-hidden="true" /></button>
                </div>)}
              </div>
            </div>

            <label className="glossary-enabled-toggle"><input type="checkbox" checked={editingEntry.enabled !== false} onChange={(event) => updateEditor('enabled', event.target.checked)} /><span><strong>啟用詞條</strong><small>停用後仍保留在全域字典，但不會被會議選用。</small></span></label>
          </div>
          <div className="global-glossary-dialog-actions">
            {editingEntry.id ? <button className="button danger-button glossary-delete-action" type="button" onClick={() => deleteEntry(editingEntry)} disabled={isSaving}>刪除詞條</button> : null}
            <button className="button secondary" type="button" onClick={closeEditor} disabled={isSaving}>取消</button>
            <button className="button primary" type="submit" disabled={isSaving}>{isSaving ? '儲存中…' : editingEntry.id ? '儲存變更' : '新增詞條'}</button>
          </div>
        </form>
      </section>
    </> : null}
    {isCategoryDialogOpen ? <><div className="global-glossary-dialog-backdrop" onClick={() => setIsCategoryDialogOpen(false)} aria-hidden="true" /><section className="global-glossary-dialog category-management-dialog" role="dialog" aria-modal="true" aria-labelledby="category-management-title" onClick={(event) => event.stopPropagation()}><div className="global-glossary-dialog-header"><div><p className="eyebrow">GLOBAL CATEGORIES</p><h2 id="category-management-title">管理分類</h2><p className="category-management-summary">共 {categories.length} 個分類</p></div><button className="icon-button dialog-close-button" type="button" aria-label="關閉分類管理" onClick={() => setIsCategoryDialogOpen(false)}><X size={20} aria-hidden="true" /></button></div><form className="category-create-form" onSubmit={saveCategory}><label className="field"><span>{editingCategory ? '編輯分類名稱' : '新增分類'}</span><input value={categoryLabel} onChange={(event) => setCategoryLabel(event.target.value)} placeholder="例如：專案名詞" autoFocus /></label><button className="button primary" type="submit" disabled={isCategorySaving}>{isCategorySaving ? '儲存中…' : editingCategory ? '儲存名稱' : '新增分類'}</button></form><label className="category-management-search field"><span>搜尋分類</span><div className="meeting-toolbar-input"><Search size={18} aria-hidden="true" /><input type="search" value={categoryQuery} onChange={(event) => setCategoryQuery(event.target.value)} placeholder="搜尋分類名稱" /></div></label><div className="category-management-list">{filteredCategories.map((item) => { const index = categories.findIndex((categoryItem) => categoryItem.id === item.id); return <div className="category-management-row" key={item.id}><span><strong title={item.label}>{item.label}</strong><small>{categoryCounts.get(item.id) || 0} 筆詞條{item.id === 'other' ? ' · 不可刪除' : ''}</small></span><div className="category-management-actions"><button className="icon-button" type="button" aria-label={`上移 ${item.label}`} onClick={() => moveCategory(item, -1)} disabled={index === 0}>↑</button><button className="icon-button" type="button" aria-label={`下移 ${item.label}`} onClick={() => moveCategory(item, 1)} disabled={index === categories.length - 1}>↓</button><button className="button detail-button" type="button" onClick={() => { setEditingCategory(item); setCategoryLabel(item.label); }}>編輯</button><button className="button danger-button" type="button" onClick={() => deleteCategory(item)} disabled={item.id === 'other'}>刪除</button></div></div>; })}{!filteredCategories.length ? <div className="category-management-empty">找不到符合的分類。</div> : null}</div></section></> : null}
  </section>;
}

function arrayBufferToBase64(arrayBuffer) {
  const bytes = new Uint8Array(arrayBuffer);
  let binary = '';
  const chunkSize = 0x8000;
  for (let index = 0; index < bytes.length; index += chunkSize) binary += String.fromCharCode(...bytes.subarray(index, index + chunkSize));
  return btoa(binary);
}

export function GlossaryPanel({ entries: sharedEntries = [], onEntriesChange }) {
  const [entries, setEntries] = useState(sharedEntries);
  const [source, setSource] = useState('');
  const [targetLanguageCode, setTargetLanguageCode] = useState('en');
  const [translation, setTranslation] = useState('');
  const [scope, setScope] = useState('history');
  const [editingEntry, setEditingEntry] = useState(null);
  const [status, setStatus] = useState('');
  const [error, setError] = useState('');
  const [isLoading, setIsLoading] = useState(true);
  const [isSaving, setIsSaving] = useState(false);
  const entriesRef = useRef([]);
  const glossaryApiClientRef = useRef(createGlossaryApiClient());

  useEffect(() => {
    entriesRef.current = sharedEntries;
    setEntries(sharedEntries);
  }, [sharedEntries]);

  useEffect(() => {
    let cancelled = false;
    setIsLoading(true);
    glossaryApiClientRef.current.listEntries()
      .then((loadedEntries) => {
        if (!cancelled) {
          publishEntries(loadedEntries);
          setError('');
        }
      })
      .catch(() => {
        if (!cancelled) setError('無法載入字典。請確認伺服器正在執行且字典儲存檔可寫入。');
      })
      .finally(() => {
        if (!cancelled) setIsLoading(false);
      });
    return () => { cancelled = true; };
  }, []);

  function resetForm() {
    setSource('');
    setTargetLanguageCode('en');
    setTranslation('');
    setScope('history');
    setEditingEntry(null);
  }

  async function saveEntry() {
    setIsSaving(true);
    setStatus('');
    setError('');
    try {
      const translations = {
        ...(editingEntry?.translations || {}),
        [targetLanguageCode]: translation
      };
      const payload = { source, translations, scope };
      if (editingEntry && hasReplacementAliases(editingEntry.replacementAliases)) {
        payload.replacementAliases = editingEntry.replacementAliases;
      }
      const entry = editingEntry
        ? await glossaryApiClientRef.current.updateEntry(editingEntry.id, payload)
        : await glossaryApiClientRef.current.createEntry(payload);
      publishEntries(editingEntry
        ? entriesRef.current.map((item) => item.id === entry.id ? entry : item)
        : mergeGlossaryEntry(entriesRef.current, entry));
      setStatus(editingEntry ? '字典詞條已更新。' : '字典詞條已新增。');
      resetForm();
    } catch {
      setError('無法儲存字典詞條。請確認原文與翻譯皆已填寫。');
    } finally {
      setIsSaving(false);
    }
  }

  async function deleteEntry(entry) {
    if (!window.confirm('確定要刪除此字典詞條？')) {
      return;
    }

    setStatus('');
    setError('');
    try {
      await glossaryApiClientRef.current.deleteEntry(entry.id);
      publishEntries(entriesRef.current.filter((item) => item.id !== entry.id));
      if (editingEntry?.id === entry.id) resetForm();
      setStatus('字典詞條已刪除。');
    } catch {
      setError('無法刪除字典詞條。');
    }
  }

  function startEditing(entry) {
    const firstLanguageCode = Object.keys(entry.translations || {})[0] || 'en';
    setEditingEntry(entry);
    setSource(entry.source || '');
    setTargetLanguageCode(firstLanguageCode);
    setTranslation(entry.translations?.[firstLanguageCode] || '');
    setScope(entry.scope || 'history');
    setStatus('');
    setError('');
  }

  function publishEntries(next) {
    entriesRef.current = next;
    setEntries(next);
    onEntriesChange?.(next);
  }

  const canSave = source.trim().length > 0 && translation.trim().length > 0 && !isSaving;

  return (
    <section className="glossary-panel" aria-label="翻譯字典詞條管理">
      <div className="controls glossary-controls">
        <label className="field">
          <span>詞條</span>
          <input value={source} onChange={(event) => setSource(event.target.value)} placeholder="例如：產品名稱" />
        </label>
        <label className="field">
          <span>目標語言</span>
          <select value={targetLanguageCode} onChange={(event) => {
            const nextLanguageCode = event.target.value;
            setTargetLanguageCode(nextLanguageCode);
            setTranslation(editingEntry?.translations?.[nextLanguageCode] || '');
          }}>
            {SUPPORTED_LANGUAGES.map((language) => <option key={language.code} value={language.code}>{language.label}</option>)}
          </select>
        </label>
        <label className="field">
          <span>替換成</span>
          <input value={translation} onChange={(event) => setTranslation(event.target.value)} placeholder="例如：正式翻譯" />
        </label>
        <label className="field">
          <span>套用範圍</span>
          <select value={scope} onChange={(event) => setScope(event.target.value)}>
            <option value="live">即時字幕</option>
            <option value="history">歷史重新翻譯</option>
            <option value="both">兩者</option>
          </select>
        </label>
        <button className="button detail-button" type="button" disabled={!canSave} onClick={saveEntry}>
          {isSaving ? '儲存中…' : editingEntry ? '更新詞條' : '新增詞條'}
        </button>
        {editingEntry ? <button className="button detail-button" type="button" onClick={resetForm}>取消編輯</button> : null}
      </div>
      <div className="glossary-feedback">
        {error ? <p className="error-message glossary-form-message" role="alert">{error}</p> : null}
        {!canSave && !isSaving && !editingEntry ? <p className="form-hint">請填寫詞條與替換內容後，才能新增。</p> : null}
        {status ? <p className="success-message" role="status">{status}</p> : null}
        {isLoading ? <p className="history-empty">正在載入字典…</p> : null}
        {!isLoading && entries.length === 0 ? <div className="empty-state"><p className="history-empty">尚無字典詞條。</p><p className="history-empty">新增常用名稱或專有名詞後，翻譯會更一致。</p></div> : null}
      </div>
      <div className="glossary-table-scroll">
        <AgGridReact
            {...dataGridProps('glossary-data-grid', { fixedHeight: true })}
            aria-label="翻譯字典詞條列表"
            columnDefs={[
              { headerName: '詞條', field: 'source', width: 220, cellRenderer: GlossarySourceCell },
              { headerName: '翻譯內容', valueGetter: ({ data }) => glossaryTranslationLabel(data.translations), minWidth: 280, flex: 1 },
              { headerName: '套用範圍', valueGetter: ({ data }) => glossaryScopeLabel(data.scope), width: 150 },
              { headerName: '操作', width: 220, sortable: false, cellRenderer: GlossaryActionsCell }
            ]}
            context={{ onEdit: startEditing, onDelete: deleteEntry }}
            rowData={entries}
            getRowId={({ data }) => data.id || data.source}
        />
      </div>
    </section>
  );
}

export function SessionDetail({ detail, historyRecord, activeSection = 'overview', detailError = '', onRetryDetail }) {
  const [readingTab, setReadingTab] = useState('translationArticle');
  const sessionRecordId = detail?.session?.id;

  useEffect(() => {
    setReadingTab('translationArticle');
  }, [sessionRecordId]);

  useEffect(() => {
    if (!sessionRecordId || activeSection === 'overview') return undefined;
    if (activeSection === 'source' || activeSection === 'translation') {
      setReadingTab(activeSection === 'source' ? 'sourceTranscript' : 'translationArticle');
    }
    const timer = window.setTimeout(() => {
      document.querySelector(`[data-history-section="${activeSection === 'translation' ? 'source' : activeSection}"]`)?.scrollIntoView({ block: 'start', behavior: 'smooth' });
    }, 0);
    return () => window.clearTimeout(timer);
  }, [activeSection, sessionRecordId]);

  const sessionRecord = useMemo(
    () => sessionRecordForDetailDTO(detail, historyRecord),
    [detail, historyRecord]
  );
  const sourceItems = useMemo(
    () => finalTranscriptItemsForStream(detail?.sourceTranscript?.items, 'source'),
    [detail?.sourceTranscript?.items]
  );
  const translationItems = useMemo(
    () => finalTranscriptItemsForStream(detail?.selectedTranslationOutput?.items, 'translation'),
    [detail?.selectedTranslationOutput?.items]
  );
  const historyCues = useMemo(
    () => cueListForDisplay({ finalCues: detail?.cues || [] }, { includePartial: false }),
    [detail?.cues]
  );
  const readingContent = useMemo(
    () => readingContentForDetail(detail, { sourceItems, translationItems, sessionRecord }),
    [detail, sourceItems, translationItems, sessionRecord]
  );
  if (detail === undefined) {
    return (
      <section className="session-detail" aria-label="工作階段詳細資料">
        <div className="session-detail-header">
          <h3>正在載入工作階段詳細資料</h3>
        </div>
        <p className="history-empty">正在載入已儲存的工作階段…</p>
      </section>
    );
  }

  if (!detail) {
    return (
      <section className="session-detail" aria-label="工作階段詳細資料">
        <div className="session-detail-header">
          <h3>無法取得工作階段詳細資料</h3>
        </div>
        <p className="error-message" role="alert">{detailError || '此翻譯紀錄無法使用。'} <button className="inline-retry" type="button" onClick={onRetryDetail}>重試</button></p>
      </section>
    );
  }

  return (
    <section className="session-detail" aria-label="工作階段詳細資料">
      <div className="session-detail-header">
        <h3>{historyLanguageLabel(sessionRecord)}詳細資料</h3>
      </div>

      <dl className="session-detail-metadata" data-history-section="overview">
        <div>
          <dt>目標語言</dt>
          <dd>{targetLanguageLabelFor(sessionRecord.targetLanguageCode) || sessionRecord.targetLanguageLabel || sessionRecord.targetLanguageCode || '未知語言'}</dd>
        </div>
        {sessionRecord.sourceLanguageCode ? (
          <div>
            <dt>主要輸入語言</dt>
            <dd>{targetLanguageLabelFor(sessionRecord.sourceLanguageCode) || sessionRecord.sourceLanguageCode}</dd>
          </div>
        ) : null}
        <div>
          <dt>狀態</dt>
          <dd>{historyStatusLabel(sessionRecord.status)}</dd>
        </div>
        <div>
          <dt>開始時間</dt>
          <dd>{formatRecordTime(sessionRecord.startedAt)}</dd>
        </div>
        <div>
          <dt>結束時間</dt>
          <dd>{formatRecordTime(sessionRecord.endedAt)}</dd>
        </div>
        <div>
          <dt>持續時間</dt>
          <dd>{formatDuration(sessionRecord.durationMs)}</dd>
        </div>
        <div>
          <dt>逐字稿</dt>
          <dd>{transcriptSummaryLabel(sessionRecord.transcriptSummary)}</dd>
        </div>
        {shouldShowFailureReason(sessionRecord) ? (
          <div>
            <dt>失敗原因</dt>
            <dd>{sessionRecord.failureReason}</dd>
          </div>
        ) : null}
        {sessionRecord.failureCategory ? (
          <div>
            <dt>失敗類別</dt>
            <dd>{failureCategoryLabel(sessionRecord.failureCategory)}</dd>
          </div>
        ) : null}
        {sessionRecord.inputDeviceLabelSnapshot ? (
          <div>
            <dt>麥克風</dt>
            <dd>{sessionRecord.inputDeviceLabelSnapshot}</dd>
          </div>
        ) : null}
      </dl>

      <AudioArtifactDownloads
        title="語音紀錄下載"
        audioArtifacts={sessionRecord.audioArtifacts}
        inputLabel="下載原始語音紀錄"
        translationLabel="下載翻譯語音紀錄"
      />

      {historyCues.length > 0 ? (
        <section className="session-cue-section" aria-label="已儲存字幕" data-testid="session-cue-list">
          <h4>字幕</h4>
          <div className="cue-history-columns" data-testid="history-cue-columns" aria-hidden="true">
            <span>原文</span>
            <span>翻譯</span>
          </div>
          <div className="cue-list cue-list-history">
            {historyCues.map((cue) => <FinalCueRow key={cue.cueId} cue={cue} />)}
          </div>
        </section>
      ) : (
        <ReadingContentTabs
          content={readingContent}
          selectedTab={readingTab}
          onSelectTab={setReadingTab}
          historySection="source"
        />
      )}
      <CloudExportUnavailableNotice meetingId={sessionRecord.meetingId} />
    </section>
  );
}

export function ReadingContentTabs({ content, selectedTab, onSelectTab, historySection = '' }) {
  const selectedContent = selectedTab === 'sourceTranscript'
    ? content.sourceTranscript
    : content.translationArticle;
  const selectedTitle = selectedTab === 'sourceTranscript' ? '原始逐字稿' : '翻譯內容';

  return (
    <section className="session-reading-panel" aria-label="歷史紀錄閱讀內容" data-testid="legacy-transcript-fallback" data-history-section={historySection || undefined}>
      <div className="reading-tabs" role="tablist" aria-label="歷史紀錄內容切換">
        <button
          className={`reading-tab${selectedTab === 'translationArticle' ? ' active' : ''}`}
          type="button"
          role="tab"
          aria-selected={selectedTab === 'translationArticle'}
          onClick={() => onSelectTab('translationArticle')}
        >
          翻譯內容
        </button>
        <button
          className={`reading-tab${selectedTab === 'sourceTranscript' ? ' active' : ''}`}
          type="button"
          role="tab"
          aria-selected={selectedTab === 'sourceTranscript'}
          onClick={() => onSelectTab('sourceTranscript')}
        >
          原始逐字稿
        </button>
      </div>

      <section className="session-transcript-section" aria-label={selectedTitle}>
        <div className="reading-content-header">
          <h4>{selectedTitle}</h4>
          <ReadingContentMetadata content={selectedContent} />
        </div>
        {selectedContent.paragraphs.length === 0 ? (
          <p className="history-empty">{readingContentEmptyText(selectedContent)}</p>
        ) : (
          <div className="session-transcript-article article-content">
            {selectedContent.paragraphs.map((paragraph, index) => (
              <p key={`${selectedTab}-article-${index}`}>{paragraph}</p>
            ))}
          </div>
        )}
      </section>
    </section>
  );
}

export function ReadingContentMetadata({ content }) {
  const metadata = [];

  if (content.kind === 'translationArticle') {
    metadata.push(`目標語言：${targetLanguageLabelFor(content.targetLanguageCode) || content.targetLanguageLabel || content.targetLanguageCode || '未知語言'}`);
    metadata.push(`建立時間：${formatRecordTime(content.createdAt)}`);
    metadata.push(`完成時間：${formatRecordTime(content.completedAt)}`);
  } else {
    metadata.push(`建立時間：${formatRecordTime(content.createdAt)}`);
    metadata.push(`完成時間：${formatRecordTime(content.finalizedAt)}`);
  }

  return <p className="reading-metadata">{metadata.join('　')}</p>;
}

function readingContentForDetail(detail, { sourceItems, translationItems, sessionRecord }) {
  if (detail?.readingContent?.translationArticle && detail?.readingContent?.sourceTranscript) {
    return detail.readingContent;
  }

  const translationParagraphs = buildTranscriptArticleParagraphs(translationItems);
  const sourceParagraphs = buildTranscriptArticleParagraphs(sourceItems);
  const fallbackStatus = terminalContentStatus(sessionRecord);

  return {
    translationArticle: {
      kind: 'translationArticle',
      status: translationParagraphs.length > 0 ? 'available' : fallbackStatus,
      targetLanguageCode: detail?.selectedTranslationOutput?.targetLanguageCode || sessionRecord.targetLanguageCode || null,
      targetLanguageLabel: detail?.selectedTranslationOutput?.targetLanguageLabel || sessionRecord.targetLanguageLabel || null,
      version: detail?.selectedTranslationOutput?.version ?? null,
      paragraphs: translationParagraphs,
      text: translationParagraphs.join('\n\n'),
      createdAt: detail?.selectedTranslationOutput?.createdAt ?? sessionRecord.startedAt ?? null,
      completedAt: detail?.selectedTranslationOutput?.completedAt ?? sessionRecord.endedAt ?? null,
      emptyReason: translationParagraphs.length > 0 ? null : emptyReasonForContentStatus(fallbackStatus)
    },
    sourceTranscript: {
      kind: 'sourceTranscript',
      status: sourceParagraphs.length > 0 ? 'available' : fallbackStatus,
      paragraphs: sourceParagraphs,
      text: sourceParagraphs.join('\n\n'),
      createdAt: detail?.sourceTranscript?.createdAt ?? sessionRecord.startedAt ?? null,
      finalizedAt: detail?.sourceTranscript?.finalizedAt ?? sessionRecord.endedAt ?? null,
      emptyReason: sourceParagraphs.length > 0 ? null : emptyReasonForContentStatus(fallbackStatus)
    }
  };
}

function terminalContentStatus(sessionRecord) {
  if (!['completed', 'stopped', 'failed', 'expired'].includes(sessionRecord?.status)) {
    return 'processing';
  }

  return sessionRecord.status === 'failed' ? 'failed' : 'empty';
}

function emptyReasonForContentStatus(status) {
  if (status === 'processing') return 'processing';
  if (status === 'failed') return 'finalize_failed';
  return 'no_content';
}

function readingContentEmptyText(content) {
  if (content.emptyReason === 'processing') {
    return '此工作階段尚未結束，正式內容仍在處理中。';
  }

  if (content.emptyReason === 'finalize_failed') {
    return '工作階段結束時未能產生新的正式內容；已保留既有歷史資料。';
  }

  return content.kind === 'translationArticle'
    ? '尚無翻譯內容。'
    : '尚無原始逐字稿。';
}

function historyLanguageLabel(record) {
  return sessionDisplayName(record);
}

function sessionDisplayName(record = {}) {
  const sourceLanguage = targetLanguageLabelFor(record.sourceLanguageCode) || record.sourceLanguageLabel || record.sourceLanguageCode || targetLanguageLabelFor(DEFAULT_SOURCE_LANGUAGE_CODE) || '來源語言未標記';
  const targetLanguage = targetLanguageLabelFor(record.targetLanguageCode) || record.targetLanguageLabel || record.targetLanguageCode || '未知語言';
  const purpose = record.recordKind === 'retranslation' ? '重新翻譯' : '即時翻譯';
  return `${formatRecordTime(record.startedAt)} · ${sourceLanguage} → ${targetLanguage} · ${purpose}`;
}

function failureCategoryLabel(category) {
  const labels = {
    user_intent: '使用者手動停止',
    microphone_capture: '麥克風無法使用',
    connection: '連線中斷',
    token: '工作階段授權失敗',
    provider: '翻譯服務暫時失敗'
  };

  return labels[category] || category;
}

function historyStatusLabel(status) {
  const labels = {
    active: '進行中',
    stopped: '已停止',
    failed: '失敗',
    expired: '已過期',
    completed: '已完成',
    interrupted: '已中斷'
  };

  return labels[status] || status;
}

function translationExecutionStatusLabel(executionOrStatus) {
  const status = typeof executionOrStatus === 'string' ? executionOrStatus : executionOrStatus?.status;
  const providerAttemptStatus = typeof executionOrStatus === 'string' ? '' : executionOrStatus?.providerAttemptStatus;
  const failureInfo = typeof executionOrStatus === 'string' ? null : executionOrStatus?.failureInfo;

  if ((status === 'running' || status === 'processing' || status === 'queued') && providerAttemptStatus === 'in_flight') {
    return '正在送往 Gemini';
  }

  if (status === 'failed' && isProviderTimeoutFailure(failureInfo)) {
    return '已逾時';
  }

  const labels = {
    queued: '已排隊',
    processing: '處理中',
    running: '處理中',
    failed: '失敗',
    cancelled: '已取消'
  };

  return labels[status] || status || '未知狀態';
}

function translationExecutionTimingText(execution, nowMs = Date.now()) {
  const startValue = execution?.providerAttemptedAt || execution?.startedAt || execution?.createdAt;
  const startMs = timestampMs(startValue);
  if (!Number.isFinite(startMs)) {
    return '';
  }

  const endMs = timestampMs(execution?.providerCompletedAt || execution?.completedAt);
  const durationMs = Number.isFinite(endMs)
    ? endMs - startMs
    : nowMs - startMs;

  if (!Number.isFinite(durationMs) || durationMs < 0) {
    return '';
  }

  return `已等待 ${formatDuration(durationMs)}`;
}

function translationFailureReasonText(failureInfo) {
  return `失敗原因：${translationFailureReasonLabel(failureInfo)}`;
}

function translationFailureReasonLabel(failureInfo = {}) {
  const code = typeof failureInfo?.code === 'string' ? failureInfo.code : '';
  const status = Number.isInteger(failureInfo?.status) ? failureInfo.status : null;

  if (code === 'unauthorized' || status === 401) {
    return 'Gemini API 金鑰未授權，請確認後端 GEMINI_API_KEY。';
  }

  if (isProviderTimeoutFailure(failureInfo)) {
    return 'Gemini 回應逾時，請稍後重試。';
  }

  if (code === 'forbidden' || status === 403) {
    return 'Gemini API 權限不足或專案未啟用此模型。';
  }

  if (code === 'bad_request' || status === 400) {
    return `Gemini 拒絕此翻譯請求（${providerDiagnosticText(failureInfo)}），請確認模型與翻譯內容格式。`;
  }

  if (code === 'rate_limited' || status === 429) {
    return 'Gemini 暫時限制此請求，可能是短時間速率、Token、模型容量或滾動用量限制；不一定代表每日用量已達上限，請稍後重試。';
  }

  if (code === 'server_error' || (status >= 500 && status <= 599)) {
    return 'Gemini 服務暫時失敗，請稍後重試。';
  }

  if (typeof failureInfo?.message === 'string' && failureInfo.message.trim()) {
    return failureInfo.message.trim();
  }

  const reason = typeof failureInfo?.reason === 'string' && failureInfo.reason.trim() ? failureInfo.reason.trim() : '';
  if (reason === 'provider_execution_failed' || failureInfo?.category === 'provider') {
    return 'Gemini 翻譯提供者執行失敗，請稍後重試。';
  }
  if (reason) {
    return `翻譯失敗（${reason}），請稍後重試。`;
  }

  return '翻譯提供者執行失敗，請稍後重試。';
}

function providerDiagnosticText(failureInfo = {}) {
  const status = Number.isInteger(failureInfo.status) ? `HTTP ${failureInfo.status}` : '';
  const code = failureInfo.providerCode ?? failureInfo.providerStatus ?? failureInfo.code;
  const message = typeof failureInfo.providerMessage === 'string' && failureInfo.providerMessage.trim()
    ? failureInfo.providerMessage.trim()
    : '';
  const model = typeof failureInfo.model === 'string' && failureInfo.model.trim() ? `model=${failureInfo.model.trim()}` : '';
  return [status, code ? `code=${code}` : '', message, model].filter(Boolean).join('；') || 'provider error';
}

function isProviderTimeoutFailure(failureInfo = {}) {
  const code = typeof failureInfo?.code === 'string' ? failureInfo.code : '';
  const status = Number.isInteger(failureInfo?.status) ? failureInfo.status : null;
  return code === 'provider_timeout' || status === 504;
}

function timestampMs(value) {
  if (typeof value === 'number') {
    return value;
  }

  if (typeof value !== 'string' || value.length === 0) {
    return NaN;
  }

  return new Date(value).getTime();
}

function translationOutputTitle(output) {
  const languageLabel = targetLanguageLabelFor(output.targetLanguageCode) || output.targetLanguageCode || '未知語言';
  return `${languageLabel}重新翻譯`;
}

function glossaryReplacementLabel(entry = {}) {
  const replacements = Object.entries(entry.translations || {})
    .map(([, text]) => `${entry.source} → ${text}`);
  return replacements.join('、') || entry.source || '未命名字典詞條';
}

function glossaryOperationErrorMessage(error, fallback) {
  const details = [];
  if (Number.isInteger(error?.status)) details.push(`HTTP ${error.status}`);
  if (typeof error?.code === 'string' && error.code.trim()) details.push(`錯誤代碼：${error.code}`);
  return details.length > 0 ? `${fallback}（${details.join('，')}）` : fallback;
}

function glossaryImportErrorMessage(error, fallback) {
  if (error?.code === 'glossary_import_invalid' && Array.isArray(error.details) && error.details.length > 0) {
    const rows = error.details.map((detail) => `第 ${detail.rowNumber} 列：${detail.errors.join('、')}`).join('；');
    return `匯入資料無效（${rows}）`;
  }
  return error?.message || fallback;
}

function glossaryImportRowErrorMessage(message) {
  const text = String(message || '');
  if (text === 'Import contains a duplicate source term.') return '來源詞重複。';
  if (text.includes('.source must be a non-empty string.')) return '來源詞不可為空白。';
  if (text.includes('.translations.') && text.includes('must be a non-empty string.')) return '翻譯內容不可為空白。';
  if (text.includes('.category is invalid.')) return '分類無效。';
  if (text.includes('has unsupported source language:')) return '來源語言不支援。';
  if (text.includes('has unsupported target language:')) return '目標語言不支援。';
  return '資料格式不正確。';
}

function defaultSelectedImportRows(preview = {}) {
  return (preview.rows || []).filter((row) => row.errors?.length === 0 && row.status !== 'duplicate').map((row) => row.rowNumber);
}

function mergeGlossaryEntry(entries = [], entry) {
  if (!entry?.id) return entries;
  const withoutEntry = entries.filter((item) => item.id !== entry.id);
  return [entry, ...withoutEntry];
}

function glossaryLanguagesLabel(translations = {}) {
  const label = Object.entries(translations)
    .map(([languageCode]) => targetLanguageLabelFor(languageCode) || languageCode)
    .join('、');
  return label ? `目標語言：${label}` : '目標語言：未設定';
}

function glossaryTranslationLabel(translations = {}) {
  const values = Object.entries(translations)
    .map(([languageCode, text]) => `${targetLanguageLabelFor(languageCode) || languageCode}：${text}`)
    .join('、');
  return values || '尚未設定翻譯';
}

function hasReplacementAliases(replacementAliases = {}) {
  return Object.values(replacementAliases)
    .some((aliases) => Array.isArray(aliases) && aliases.length > 0);
}

function glossaryScopeLabel(scope) {
  const labels = {
    live: '套用範圍：即時字幕',
    history: '套用範圍：歷史重新翻譯',
    both: '套用範圍：兩者'
  };

  return labels[scope] || labels.history;
}

function transcriptSummaryLabel(summary = {}) {
  const sourceFinalCount = summary.sourceFinalCount || 0;
  const translationFinalCount = summary.translationFinalCount || 0;

  if (!summary.hasTranscript && sourceFinalCount === 0 && translationFinalCount === 0) {
    return '沒有逐字稿';
  }

  return `原文完成：${sourceFinalCount} · 翻譯完成：${translationFinalCount}`;
}

function shouldShowFailureReason(record) {
  return (record.status === 'failed' || record.status === 'expired') && record.failureReason;
}

function finalTranscriptItemsForStream(items = [], stream) {
  return items
    .filter((item) => item.stream === stream && item.status === 'final')
    .sort((a, b) => (a.sequence || 0) - (b.sequence || 0));
}

function sessionRecordForDetailDTO(detail, historyRecord) {
  const session = detail?.session || {};
  const selectedTranslationOutput = detail?.selectedTranslationOutput || {};

  return {
    ...session,
    targetLanguageCode: historyRecord?.targetLanguageCode || selectedTranslationOutput.targetLanguageCode || null,
    targetLanguageLabel: historyRecord?.targetLanguageLabel || selectedTranslationOutput.targetLanguageLabel || null,
    recordKind: historyRecord?.recordKind || session.recordKind || 'session',
    retranslatedFrom: historyRecord?.retranslatedFrom || session.retranslatedFrom || null
  };
}

function meetingReadingContent(detail) {
  const source = detail?.readingContent?.sourceTranscript;
  const translation = detail?.readingContent?.translationArticle;

  return {
    sourceTranscript: source
      ? toTraditionalChineseSourceContent({
          ...source,
          createdAt: source.createdAt ?? detail?.meeting?.startedAt ?? null,
          finalizedAt: source.finalizedAt ?? detail?.meeting?.endedAt ?? null,
          emptyReason: source.emptyReason || (source.status === 'empty' ? 'no_content' : null)
        })
      : {
          kind: 'sourceTranscript',
          status: 'empty',
          text: '',
          paragraphs: [],
          emptyReason: 'no_content',
          createdAt: detail?.meeting?.startedAt ?? null,
          finalizedAt: detail?.meeting?.endedAt ?? null
        },
    translationArticle: translation
      ? {
          ...translation,
          createdAt: translation.createdAt ?? detail?.meeting?.startedAt ?? null,
          completedAt: translation.completedAt ?? detail?.meeting?.endedAt ?? null,
          emptyReason: translation.emptyReason || (translation.status === 'empty' ? 'no_content' : null)
        }
      : {
          kind: 'translationArticle',
          status: 'empty',
          text: '',
          paragraphs: [],
          emptyReason: 'no_content',
          targetLanguageCode: null,
          targetLanguageLabel: null,
          createdAt: detail?.meeting?.startedAt ?? null,
          completedAt: detail?.meeting?.endedAt ?? null
        }
  };
}

function meetingTitle(record = {}) {
  return record.name || `長會議 · ${formatRecordTime(record.startedAt)}`;
}

function meetingStatusLabel(status) {
  const labels = {
    created: '已建立',
    active: '進行中',
    completed: '已完成',
    interrupted: '已中斷',
    failed: '失敗'
  };

  return labels[status] || status || '未知狀態';
}

function meetingSegmentStatusLabel(status) {
  return meetingStatusLabel(status);
}

function meetingSegmentSummaryLabel(summary = {}) {
  const total = summary.totalSegments || 0;
  const counts = summary.countsByStatus || {};
  const parts = [
    counts.completed ? `完成 ${counts.completed}` : '',
    counts.active ? `進行中 ${counts.active}` : '',
    counts.interrupted ? `中斷 ${counts.interrupted}` : '',
    counts.failed ? `失敗 ${counts.failed}` : ''
  ].filter(Boolean);

  return parts.length > 0 ? `${total} 段（${parts.join('、')}）` : `${total} 段`;
}

function meetingExceptionSummaryLabel(summary = {}) {
  const counts = summary.countsByStatus || {};
  const interrupted = counts.interrupted || 0;
  const failed = counts.failed || 0;

  if (interrupted === 0 && failed === 0) {
    return '無';
  }

  return [`中斷 ${interrupted}`, `失敗 ${failed}`].join(' · ');
}

function formatRecordTime(value) {
  if (!value) {
    return '無資料';
  }

  const date = new Date(value);

  if (Number.isNaN(date.getTime())) {
    return String(value);
  }

  return date.toLocaleString('zh-Hant');
}

function meetingRetentionNotice(meeting) {
  if (Number(meeting?.lifecycleContractVersion) !== 2 || !['completed', 'failed', 'interrupted'].includes(meeting?.status)) return '';
  const purgeAt = Date.parse(meeting?.purgeAt || '');
  if (!Number.isFinite(purgeAt)) return '';
  return purgeAt <= Date.now()
    ? '這場會議的暫存內容已到期，匯出與下載可能即將失效。'
    : `字幕與音檔暫存至 ${formatRecordTime(meeting.purgeAt)}；請在期限前完成匯出或下載。`;
}

function formatMeetingListTime(value) {
  if (!value) return '無資料';

  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);

  return new Intl.DateTimeFormat('zh-TW', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false
  }).format(date).replace(/\s+/g, ' ');
}

function meetingLanguageLabel(meeting = {}) {
  const source = targetLanguageLabelFor(meeting.sourceLanguageCode) || meeting.sourceLanguageCode || '未設定';
  const target = targetLanguageLabelFor(meeting.targetLanguageCode) || meeting.targetLanguageCode || '未設定';
  return `${source} → ${target}`;
}

function formatDuration(durationMs) {
  if (!Number.isFinite(durationMs)) {
    return '無資料';
  }

  const totalSeconds = Math.round(durationMs / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;

  if (minutes === 0) {
    return `${seconds} 秒`;
  }

  return `${minutes} 分 ${seconds} 秒`;
}

function meetingRecordSortTime(record) {
  const startedAt = new Date(record.startedAt).getTime();

  if (Number.isFinite(startedAt)) {
    return startedAt;
  }

  const endedAt = new Date(record.endedAt).getTime();

  return Number.isFinite(endedAt) ? endedAt : 0;
}

function downloadBlob(blob, fileName) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = fileName;
  link.style.display = 'none';
  document.body.append(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 0);
}

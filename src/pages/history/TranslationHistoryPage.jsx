import React, { useMemo, useState } from 'react';
import { Clock3, Filter, Search, X } from 'lucide-react';
import '../../styles/translation-history.css';

export function TranslationHistoryPage({
  entries = [], selectedEntry, selectedSessionDetail, selectedMeetingDetail,
  selectedSection = 'overview', isLoading = false, loadError = '', detailError = '',
  onOpenEntry, onCloseEntry, onDeleteRecord, onRetry, helpers, SessionDetail, MeetingDetail
}) {
  const [query, setQuery] = useState('');
  const [statusFilter, setStatusFilter] = useState('all');
  const [sortMode, setSortMode] = useState('recent');
  const filteredEntries = useMemo(() => entries.filter((entry) => (
    (statusFilter === 'all' || entry.record?.status === statusFilter) && helpers.historyEntryMatches(entry, query)
  )).sort((left, right) => {
    const leftTime = Date.parse(left.record?.updatedAt || left.record?.startedAt || '') || 0;
    const rightTime = Date.parse(right.record?.updatedAt || right.record?.startedAt || '') || 0;
    return sortMode === 'started' ? (Date.parse(right.record?.startedAt || '') || 0) - (Date.parse(left.record?.startedAt || '') || 0) : rightTime - leftTime;
  }), [entries, helpers, query, sortMode, statusFilter]);
  const selectedId = selectedEntry?.record?.id || '';
  const selectedKind = selectedEntry?.kind || '';
  const sectionItems = [['overview', '紀錄'], ['source', '原文'], ['translation', '翻譯'], ['export', '匯出']];

  return (
    <section className={`feature-page translation-history-page${selectedEntry ? ' has-selection' : ''}`} aria-labelledby="translation-history-page-title">
      <div className="translation-history-content">
        <div className="translation-history-toolbar">
          <label className="field history-search-field"><span>搜尋紀錄</span><div className="history-search-control"><Search size={18} aria-hidden="true" /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜尋會議、日期、語言或狀態" /></div></label>
          <label className="field"><span>狀態</span><select value={statusFilter} onChange={(event) => setStatusFilter(event.target.value)}><option value="all">全部狀態</option><option value="completed">已完成</option><option value="active">進行中</option><option value="interrupted">可繼續</option><option value="failed">失敗</option></select></label>
          <label className="field"><span>排序</span><select value={sortMode} onChange={(event) => setSortMode(event.target.value)}><option value="recent">最近更新</option><option value="started">最近開始</option></select></label>
          <button className="button secondary" type="button" onClick={() => { setQuery(''); setStatusFilter('all'); setSortMode('recent'); }}><Filter size={17} aria-hidden="true" />清除篩選</button>
        </div>
        {loadError ? <p className="error-message" role="alert">{loadError} <button className="inline-retry" type="button" onClick={onRetry}>重試</button></p> : null}
        <div className="translation-history-layout">
          <aside className="history-directory" aria-label="翻譯紀錄目錄"><div className="history-directory-heading"><strong>紀錄狀態</strong><span>{entries.length}</span></div>{[['all', '全部紀錄'], ['completed', '已完成'], ['active', '進行中'], ['interrupted', '可繼續'], ['failed', '失敗']].map(([value, label]) => <button className={statusFilter === value ? 'is-active' : ''} type="button" key={value} onClick={() => setStatusFilter(value)}><span>{label}</span><small>{value === 'all' ? entries.length : entries.filter((entry) => entry.record?.status === value).length}</small></button>)}</aside>
          <div className="translation-history-main">
            {!isLoading && filteredEntries.length === 0 ? <div className="empty-state history-empty-card"><Clock3 size={30} aria-hidden="true" /><strong>{entries.length ? '找不到符合條件的紀錄' : '尚無翻譯紀錄'}</strong><span>{entries.length ? '調整搜尋或篩選條件。' : '完成一次即時翻譯後，紀錄會出現在這裡。'}</span></div> : null}
            {isLoading && entries.length === 0 ? <p className="history-empty">正在載入翻譯紀錄…</p> : null}
            {filteredEntries.length > 0 ? <div className="history-card-region-header"><span>共 {filteredEntries.length} 筆紀錄</span></div> : null}
            <div className="translation-history-card-grid">{filteredEntries.map((entry) => { const record = entry.record; const isSelected = selectedId === record.id && selectedKind === entry.kind; return <article className={`translation-history-card${isSelected ? ' is-selected' : ''}`} key={`${entry.kind}-${record.id}`}><div className="translation-history-card-topline"><span className={`history-status history-status-${record.status}`}>{entry.kind === 'meeting' ? helpers.meetingStatusLabel(record.status) : helpers.historyStatusLabel(record.status)}</span><small>{entry.kind === 'meeting' ? '會議' : '單次翻譯'}</small></div><h2>{helpers.historyEntryTitle(entry)}</h2><p className="history-card-language">{helpers.historyEntrySummary(entry)}</p><dl className="history-card-metadata"><div><dt>開始時間</dt><dd>{helpers.formatRecordTime(record.startedAt)}</dd></div><div><dt>持續時間</dt><dd>{helpers.formatDuration(record.durationMs)}</dd></div></dl><div className="translation-history-card-footer"><button className="button detail-button" type="button" onClick={() => onOpenEntry(entry, 'overview')}>{isSelected ? '查看中' : '查看內容'}</button>{entry.kind === 'session' && !['completed', 'failed', 'expired', 'stopped'].includes(record.status) ? <a className="button detail-button" href={record.meetingId ? `#live?meetingId=${encodeURIComponent(record.meetingId)}` : `#live?sessionId=${encodeURIComponent(record.id)}`}>繼續翻譯</a> : null}<button className="button detail-button danger-button" type="button" onClick={() => onDeleteRecord(record)}>刪除</button></div></article>; })}</div>
          </div>
          {selectedEntry ? <aside className="translation-history-detail" aria-label="翻譯紀錄詳細資料"><div className="translation-history-detail-header"><div><p className="eyebrow">TRANSLATION RECORD</p><h2>{helpers.historyEntryTitle(selectedEntry)}</h2></div><button className="icon-button" type="button" aria-label="關閉翻譯紀錄詳細資料" onClick={onCloseEntry}><X size={20} aria-hidden="true" /></button></div><nav className="history-detail-directory" aria-label="紀錄內容目錄">{sectionItems.map(([value, label]) => <button key={value} className={selectedSection === value ? 'is-active' : ''} type="button" aria-current={selectedSection === value ? 'page' : undefined} onClick={() => onOpenEntry(selectedEntry, value)}>{label}</button>)}</nav><div className="translation-history-detail-body">{selectedEntry.kind === 'session' ? <SessionDetail detail={selectedSessionDetail} historyRecord={selectedEntry.record} activeSection={selectedSection} detailError={detailError} onRetryDetail={onRetry} onRetranslationSubmitted={onRetry} /> : <MeetingDetail detail={selectedMeetingDetail} activeSection={selectedSection} detailError={detailError} onRetryDetail={onRetry} />}</div></aside> : null}
        </div>
      </div>
    </section>
  );
}

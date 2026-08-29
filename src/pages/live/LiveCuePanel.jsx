import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Check, Copy, Radio } from 'lucide-react';
import { effectiveSourceForCue, effectiveTranslationForCue } from '../../lib/cueContent.js';
import { cueListForDisplay, sourceTextForCopy, translationTextForCopy } from '../../lib/cueUi.js';
import { wrapSubtitleText } from '../../lib/subtitleCueExport.js';

// Refinement status is shown in the panel badge; Cue rows keep the normal
// surface so async polishing cannot obscure live transcript content.
export function cueHasRefinedResult(cue) {
  return cue?.refinement?.status === 'completed'
    && Boolean((cue?.refinedSource || cue?.refinedTranslation || '').trim());
}

export function LiveCuePanel({
  cueState,
  fallbackTranscriptItems = [],
  status,
  statusLabelOverride,
  isPaused,
  isStopped,
  polishingState,
  polishedArticle,
  onPolishingRetry,
  copiedSource,
  copiedTranslation,
  onCopySource,
  onCopyTranslation
}) {
  const panelRef = useRef(null);
  const cueListRef = useRef(null);
  const [isFollowingLatest, setIsFollowingLatest] = useState(false);
  const [showSource, setShowSource] = useState(true);
  const cues = useMemo(() => cueListForDisplay(cueState, { requireSourceTextForPartial: true }), [cueState]);
  const hasContent = cues.length > 0 || fallbackTranscriptItems.length > 0 || Boolean(polishedArticle?.text);

  useEffect(() => {
    const list = cueListRef.current;
    if (!list) return undefined;
    const updateFollowState = () => setIsFollowingLatest(isCueListAtLatestPosition(list));
    updateFollowState();
    window.addEventListener('resize', updateFollowState);
    return () => window.removeEventListener('resize', updateFollowState);
  }, []);

  useEffect(() => {
    const list = cueListRef.current;
    if (!list || !isFollowingLatest || cues.length === 0) return;
    list.scrollTo({ top: list.scrollHeight, behavior: cues.at(-1)?.status === 'final' ? 'smooth' : 'auto' });
  }, [cues.length, cues.at(-1)?.cueId, cues.at(-1)?.updatedTimeMs, isFollowingLatest]);

  function toggleSourceVisibility(nextValue) {
    const list = cueListRef.current;
    const scrollTop = list?.scrollTop || 0;
    setShowSource(nextValue);
    window.requestAnimationFrame(() => { if (cueListRef.current) cueListRef.current.scrollTop = scrollTop; });
  }

  return (
    <section className="cue-panel meeting-settings-card" aria-label="即時字幕" data-testid="live-cue-panel" ref={panelRef}>
      <div className="cue-panel-header meeting-settings-card-header">
        <div><h2>即時字幕</h2><p className="meeting-settings-card-description">{isPaused ? '已暫停，字幕內容會保留。' : isStopped ? '本次工作階段已結束。' : '翻譯是主要閱讀內容；可隨時收合原文核對欄。'}</p></div>
        <div className="cue-panel-actions">
          <span className={`live-inline-status live-inline-status-${status} status-pill`} aria-label={`即時字幕狀態：${statusLabel(status, statusLabelOverride)}`}><Radio size={15} aria-hidden="true" />{statusLabel(status, statusLabelOverride)}</span>
          <label className="source-visibility-toggle"><input type="checkbox" checked={showSource} onChange={(event) => toggleSourceVisibility(event.target.checked)} data-testid="source-visibility-toggle" /><span>顯示原文</span></label>
          {hasContent ? <><TranscriptPolishingStatus polishingState={polishingState} onRetry={onPolishingRetry} />{!isFollowingLatest ? <button className="button detail-button" type="button" data-testid="follow-latest-button" onClick={() => { cueListRef.current?.scrollTo({ top: cueListRef.current.scrollHeight, behavior: 'smooth' }); setIsFollowingLatest(true); }}>回到最新字幕</button> : null}</> : null}
        </div>
      </div>
      <div ref={cueListRef} onScroll={(event) => setIsFollowingLatest(isCueListAtLatestPosition(event.currentTarget))} className={`cue-list ${hasContent ? '' : 'cue-list-empty'}`} data-testid="cue-list" role="log" aria-live="polite" aria-label="字幕列表">
        {!hasContent ? <p className="cue-empty cue-empty-prominent" data-testid="cue-empty-state">開始翻譯後，原文與翻譯字幕會顯示在這裡</p> : null}
        {hasContent ? <div className={`cue-reading-layout${showSource ? '' : ' is-source-hidden'}`}>
          {showSource ? <CueLanguageHeader stream="source" onCopy={onCopySource} copied={copiedSource} disabled={!sourceTextForCopy(cueState.finalCues)} /> : null}
          <CueLanguageHeader stream="translation" onCopy={onCopyTranslation} copied={copiedTranslation} disabled={!translationTextForCopy(cueState.finalCues)} />
          {fallbackTranscriptItems.length > 0 ? <div className="cue-recovery-fallback" data-testid="cue-recovery-fallback" aria-label="已保存但尚未整理的逐字稿">
            {fallbackTranscriptItems.map((item) => <article className="cue-row cue-row-recovered" key={`recovered-${item.id}`}>
              <div className="cue-row-meta"><span className="cue-partial-status">已保存逐字稿</span></div>
              <div className="cue-text-toggle">
                {showSource && item.stream === 'source' ? <SourceCueText text={wrapSubtitleText(item.text, item.sourceLanguageCode)} /> : null}
                {item.stream === 'translation' ? <TranslatedCueText text={wrapSubtitleText(item.text, item.targetLanguageCode)} /> : null}
              </div>
            </article>)}
          </div> : null}
          <div className="cue-section-list" data-testid="cue-paired-list">{cues.map((cue) => cue.status === 'final' ? <FinalCueRow key={cue.cueId} cue={cue} paired showSource={showSource} /> : <PartialCueRow key={`partial-${cue.cueId || 'current'}`} cue={cue} paired showSource={showSource} />)}</div>
        </div> : null}
      </div>
      {polishedArticle?.text ? <section className="transcript-panel" data-testid="polished-article" aria-label="潤飾文章版"><div className="article-panel-header"><h3>潤飾文章版</h3></div><div className="article-content"><p>{polishedArticle.text}</p></div></section> : null}
    </section>
  );
}

function CueLanguageHeader({ stream, onCopy, copied, disabled }) {
  return <section className={`cue-language-section cue-${stream}-column`} aria-label={stream === 'source' ? '即時字幕原文' : '即時字幕翻譯'}><div className="cue-section-header"><h3>{stream === 'source' ? '輸入／原文' : '翻譯'}</h3><button className="button detail-button" type="button" onClick={onCopy} disabled={disabled}><Copy size={14} aria-hidden="true" />{copied ? '已複製' : stream === 'source' ? '複製原文' : '複製翻譯'}</button></div></section>;
}

function FinalCueRow({ cue, ...props }) { return <CueRow cue={cue} {...props} />; }
function PartialCueRow({ cue, ...props }) { return <CueRow cue={cue} partial {...props} />; }

function TranscriptPolishingStatus({ polishingState, onRetry }) {
  const status = polishingState?.status || 'idle';
  if (status === 'idle') return null;
  const label = ['running', 'dirty', 'processing'].includes(status) ? '潤飾中' : status === 'queued' ? '等待潤飾' : status === 'failed' ? '潤飾失敗' : status === 'completed' ? '潤飾完成' : '尚未開始潤飾';
  const errorText = polishingState?.error || '';
  return <span className={`transcript-polishing-badge transcript-polishing-badge-${status}`} aria-live="polite" aria-label={`${label}${errorText ? `：${errorText}` : ''}`} data-testid="transcript-polishing-status" title={errorText || undefined}>{label}{status === 'completed' && polishingState.version ? ` · v${polishingState.version}` : ''}{errorText && status === 'failed' ? `：${errorText}` : ''}{status === 'failed' && polishingState.executionId ? <button className="button detail-button polishing-retry-button" type="button" onClick={() => onRetry?.(polishingState.executionId)}>重試</button> : null}</span>;
}

function CueRow({ cue, partial = false, stream, paired = false, showSource = true }) {
  const [showRaw, setShowRaw] = useState(false);
  const label = cue.terminalStatus === 'saved-pending' ? '未完成語句已保存' : partial ? cue.translationStatus === 'failed' ? '翻譯失敗' : '辨識中／翻譯中' : `字幕 ${cue.sequence || ''}`;
  const sourceText = paired || stream ? effectiveSourceForCue(cue, showRaw ? 'raw' : 'refined') : cue.sourceText;
  const translationText = paired || stream ? effectiveTranslationForCue(cue, showRaw ? 'raw' : 'refined') : cue.translatedText;
  const hasRefinedText = Boolean((cue.refinedTranslation || cue.refinedSource || '').trim());
  const hasRefinedResult = !partial && cueHasRefinedResult(cue);
  return <article className={`cue-row${partial ? ' cue-row-partial' : ''}${hasRefinedResult ? ' cue-row-refined' : ''}`} data-testid={partial ? 'cue-partial-row' : 'cue-final-row'} data-cue-id={cue.cueId || undefined} aria-label={label}>
    {partial ? <div className="cue-row-meta"><span className="cue-partial-status">{label}</span></div> : null}
    <div className="cue-text-toggle">{stream ? stream === 'source' ? <SourceCueText text={wrapSubtitleText(sourceText, cue.sourceLanguageCode)} /> : <TranslatedCueText text={wrapSubtitleText(translationText, cue.targetLanguageCode)} /> : <>{showSource ? <SourceCueText text={wrapSubtitleText(sourceText, cue.sourceLanguageCode)} /> : null}<TranslatedCueText text={wrapSubtitleText(translationText, cue.targetLanguageCode)} /></>}</div>
    {hasRefinedResult ? <span className="cue-refined-indicator" data-testid="cue-refined-indicator" aria-label="已潤飾" title="已潤飾"><Check size={14} aria-hidden="true" /></span> : null}
    {!partial && hasRefinedText ? <button className="button detail-button" type="button" onClick={() => setShowRaw((value) => !value)}>{showRaw ? '顯示修正版' : '查看原始'}</button> : null}
  </article>;
}

function SourceCueText({ text = '' }) { return <span className="cue-source" data-testid="cue-source-text">{text || '—'}</span>; }
function TranslatedCueText({ text = '' }) { return <span className="cue-translation" data-testid="cue-translated-text">{text || '—'}</span>; }

function isCueListAtLatestPosition(list) { return list.scrollHeight - list.scrollTop - list.clientHeight < 24; }
function statusLabel(status, override = '') { if (override) return override; return { idle: '準備就緒', 'requesting-permission': '正在請求麥克風權限', connecting: '正在連線', listening: '聆聽中', reconnecting: '正在重新連線', 'switching-segment': '切換下一段中', paused: '已暫停', stopped: '已停止', expired: '工作階段已過期', error: '需要處理' }[status] || status; }

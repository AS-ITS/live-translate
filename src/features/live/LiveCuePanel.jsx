import { useEffect, useMemo, useRef, useState } from 'react';
import { Copy, Radio } from 'lucide-react';
import { effectiveTranslationForCue } from '../../lib/cueContent.js';
import { cueListForDisplay, sourceTextForCopy, sourceTextForDisplay, translationTextForCopy } from '../../lib/cueUi.js';
import { transcriptTextForDisplay } from './liveTranscriptRecovery.js';
import { wrapSubtitleText } from '../../lib/subtitleCueExport.js';
import { recordLivePipelineTrace } from '../../lib/livePipelineTrace.js';

// Async translation/refinement updates the same Cue row without obscuring
// the live transcript content.
export function LiveCuePanel({
  cueState,
  fallbackTranscriptItems = [],
  status,
  statusLabelOverride,
  isPaused,
  isStopped,
  copiedSource,
  copiedTranslation,
  onCopySource,
  onCopyTranslation
}) {
  const panelRef = useRef(null);
  const cueListRef = useRef(null);
  const [isFollowingLatest, setIsFollowingLatest] = useState(false);
  const [showSource, setShowSource] = useState(true);
  const cues = useMemo(() => cueListForDisplay(cueState), [cueState]);
  const hasContent = cues.length > 0 || fallbackTranscriptItems.length > 0;

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

  useEffect(() => {
    for (const cue of cues) {
      recordLivePipelineTrace({
        stage: 'REACT_RENDER',
        recordingId: cue.sessionId || null,
        segmentId: cue.segmentId || null,
        audioTurnId: cue.audioTurnId || null,
        eventType: cue.status || null,
        isFinal: cue.status === 'final',
        sourceText: sourceTextForDisplay(cue, 'raw'),
        translationText: effectiveTranslationForCue(cue),
        cueId: cue.cueId || null,
        cueAction: 'render'
      });
    }
  }, [cues]);

  return (
    <section className="cue-panel meeting-settings-card" aria-label="即時字幕" data-testid="live-cue-panel" ref={panelRef}>
      <div className="cue-panel-header meeting-settings-card-header">
        <div><h2>即時字幕</h2><p className="meeting-settings-card-description">{isPaused ? '已暫停，字幕內容會保留。' : isStopped ? '本次工作階段已結束。' : '錄音會即時轉成來源語言字幕，翻譯會在句子完成後更新。'}</p></div>
        <div className="cue-panel-actions">
          <span className={`live-inline-status live-inline-status-${status} status-pill`} aria-label={`即時字幕狀態：${statusLabel(status, statusLabelOverride)}`}><Radio size={15} aria-hidden="true" />{statusLabel(status, statusLabelOverride)}</span>
          <button className={`button detail-button source-visibility-toggle${showSource ? ' is-active' : ''}`} type="button" data-testid="source-visibility-toggle" aria-pressed={showSource} onClick={() => setShowSource((visible) => !visible)}>顯示原文</button>
          {hasContent && !isFollowingLatest ? <button className="button detail-button" type="button" data-testid="follow-latest-button" onClick={() => { cueListRef.current?.scrollTo({ top: cueListRef.current.scrollHeight, behavior: 'smooth' }); setIsFollowingLatest(true); }}>回到最新字幕</button> : null}
        </div>
      </div>
      <div ref={cueListRef} onScroll={(event) => setIsFollowingLatest(isCueListAtLatestPosition(event.currentTarget))} className={`cue-list ${hasContent ? '' : 'cue-list-empty'}`} data-testid="cue-list" role="log" aria-live="polite" aria-label="字幕列表">
        {!hasContent ? <p className="cue-empty cue-empty-prominent" data-testid="cue-empty-state">開始錄音後，來源語音字幕會顯示在這裡</p> : null}
        {hasContent ? <div className={`cue-reading-layout${showSource ? '' : ' is-source-hidden'}`}>
          {showSource ? <CueLanguageHeader stream="source" onCopy={onCopySource} copied={copiedSource} disabled={!sourceTextForCopy(cueState.finalCues)} /> : null}
          <CueLanguageHeader stream="translation" onCopy={onCopyTranslation} copied={copiedTranslation} disabled={!translationTextForCopy(cueState.finalCues)} />
          {fallbackTranscriptItems.length > 0 ? <div className="cue-recovery-fallback" data-testid="cue-recovery-fallback" aria-label="已保存但尚未整理的逐字稿">
            {fallbackTranscriptItems.map((item) => <article className="cue-row cue-row-recovered" key={`recovered-${item.id}`}>
              <div className="cue-text-toggle">
                {showSource && item.stream === 'source' ? <SourceCueText text={wrapSubtitleText(transcriptTextForDisplay(item), item.sourceLanguageCode)} /> : null}
                {item.stream === 'translation' ? <TranslatedCueText text={wrapSubtitleText(item.text, item.targetLanguageCode)} /> : null}
              </div>
            </article>)}
          </div> : null}
          <div className="cue-section-list" data-testid="cue-paired-list">{cues.map((cue) => cue.status === 'final' ? <FinalCueRow key={cue.cueId} cue={cue} showSource={showSource} /> : <PartialCueRow key={`partial-${cue.cueId || 'current'}`} cue={cue} showSource={showSource} />)}</div>
        </div> : null}
      </div>
    </section>
  );
}

function CueLanguageHeader({ stream, onCopy, copied, disabled }) {
  return <section className={`cue-language-section cue-${stream}-column`} aria-label={stream === 'source' ? '即時字幕原文' : '即時字幕翻譯'}><div className="cue-section-header"><h3>{stream === 'source' ? '輸入／原文' : '翻譯'}</h3><button className="button detail-button" type="button" onClick={onCopy} disabled={disabled}><Copy size={14} aria-hidden="true" />{copied ? '已複製' : stream === 'source' ? '複製原文' : '複製翻譯'}</button></div></section>;
}

function FinalCueRow({ cue, ...props }) { return <CueRow cue={cue} {...props} />; }
function PartialCueRow({ cue, ...props }) { return <CueRow cue={cue} partial {...props} />; }

function CueRow({ cue, partial = false, stream, paired = false, showSource = true }) {
  const label = cue.terminalStatus === 'saved-pending' ? '未完成語句已保存' : partial ? '辨識中' : `字幕 ${cue.sequence || ''}`;
  const sourceText = sourceTextForDisplay(cue, 'raw');
  const translationText = effectiveTranslationForCue(cue);
  return <article className={`cue-row${partial ? ' cue-row-partial' : ''}`} data-testid={partial ? 'cue-partial-row' : 'cue-final-row'} data-cue-id={cue.cueId || undefined} aria-label={label}>
    {partial ? <div className="cue-row-meta"><span className="cue-partial-status">{label}</span></div> : null}
    <div className="cue-text-toggle">{showSource ? <SourceCueText text={wrapSubtitleText(sourceText, cue.sourceLanguageCode)} /> : null}{!partial ? <TranslatedCueText text={wrapSubtitleText(translationText, cue.targetLanguageCode)} /> : null}</div>
  </article>;
}

function SourceCueText({ text = '' }) { return <span className="cue-source" data-testid="cue-source-text">{text || '—'}</span>; }
function TranslatedCueText({ text = '' }) { return <span className="cue-translation" data-testid="cue-translated-text">{text || '翻譯處理中…'}</span>; }

function isCueListAtLatestPosition(list) { return list.scrollHeight - list.scrollTop - list.clientHeight < 24; }
function statusLabel(status, override = '') { if (override) return override; return { idle: '準備就緒', 'requesting-permission': '正在請求麥克風權限', connecting: '正在連線', listening: '聆聽中', reconnecting: '正在重新連線', 'switching-segment': '切換下一段中', paused: '已暫停', stopped: '已停止', expired: '工作階段已過期', error: '需要處理' }[status] || status; }

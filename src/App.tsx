import { useState, useRef, useCallback, useEffect, useSyncExternalStore } from 'react';
import type {
  AppSettings, ProcessingMode, TranscriptSession, FileQueueItem, LiveSessionState
} from './types';
import { SUPPORTED_LANGUAGES, WHISPER_MODELS } from './types';
import { isSupportedAudioFile, formatDuration, generateId, createPlaybackUrl } from './services/audioProcessor';
import { transcriptStore } from './services/transcriptStore';
import { LiveTranscriptionSession } from './services/liveSession';
import { FileQueueManager } from './services/fileQueue';
import {
  exportAsText, exportAsSRT, exportAsVTT, exportAsJSON, downloadFile
} from './services/exportService';

// ─── Store hooks ──────────────────────────────────────────────────────────────

function useTranscriptStore() {
  const getSnapshot = useCallback(() => ({
    sessions: transcriptStore.getSessions(),
    activeId: transcriptStore.getActiveSession()?.id || null,
  }), []);
  const subscribe = useCallback((cb: () => void) => transcriptStore.subscribe(cb), []);
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

// ─── Main App ─────────────────────────────────────────────────────────────────

export default function App() {
  // Settings state
  const [settings, setSettings] = useState<AppSettings>({
    processingMode: 'speech',
    sourceLanguage: 'auto',
    targetLanguage: 'en',
    modelId: 'Xenova/whisper-tiny',
    enableTranslation: false,
    enableWebGPU: false,
    enableTimestamps: true,
    chunkDuration: 30,
    maxConcurrentJobs: 1,
    processingProvider: 'local',
    liveChunkDuration: 6,
    liveOverlapDuration: 2,
    maxBufferedChunks: 5,
  });

  // UI state
  const [showSettings, setShowSettings] = useState(false);
  const [activeTab, setActiveTab] = useState<'live' | 'files' | 'results'>('live');
  const [notification, setNotification] = useState<{ type: 'info' | 'error' | 'success'; message: string } | null>(null);
  const [dragOver, setDragOver] = useState(false);
  const [editingSegmentId, setEditingSegmentId] = useState<string | null>(null);
  const [selectedSessionId, setSelectedSessionId] = useState<string | null>(null);
  const [showTranslation, setShowTranslation] = useState(false);

  // Store subscription
  const storeState = useTranscriptStore();
  const sessions = storeState.sessions;
  const activeSession = selectedSessionId
    ? sessions.find(s => s.id === selectedSessionId) || sessions[0] || null
    : sessions[0] || null;

  // Refs and state
  const liveSessionRef = useRef<LiveTranscriptionSession | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [fileQueue, setFileQueue] = useState<FileQueueManager | null>(null);

  // Initialize file queue
  useEffect(() => {
    const queue = new FileQueueManager({
      modelId: settings.modelId,
      language: settings.sourceLanguage,
      mode: settings.processingMode,
      enableWebGPU: settings.enableWebGPU,
      chunkDuration: settings.chunkDuration,
      enableTranslation: settings.enableTranslation,
      targetLanguage: settings.targetLanguage,
      maxConcurrent: settings.maxConcurrentJobs,
    });
    setFileQueue(queue);
    return () => queue.destroy();
  }, []);

  // Update file queue config when settings change
  useEffect(() => {
    fileQueue?.updateConfig({
      modelId: settings.modelId,
      language: settings.sourceLanguage,
      mode: settings.processingMode,
      enableWebGPU: settings.enableWebGPU,
      chunkDuration: settings.chunkDuration,
      enableTranslation: settings.enableTranslation,
      targetLanguage: settings.targetLanguage,
    });
  }, [fileQueue, settings.modelId, settings.sourceLanguage, settings.processingMode, settings.enableWebGPU, settings.chunkDuration, settings.enableTranslation, settings.targetLanguage]);

  // Notification auto-dismiss
  useEffect(() => {
    if (notification) {
      const timer = setTimeout(() => setNotification(null), 6000);
      return () => clearTimeout(timer);
    }
  }, [notification]);

  function notify(type: 'info' | 'error' | 'success', message: string) {
    setNotification({ type, message });
  }

  // ─── Live Transcription ─────────────────────────────────────────────────────

  const startLiveSession = useCallback(async (sourceType: 'microphone' | 'display_capture') => {
    // Cancel existing live session
    if (liveSessionRef.current) {
      liveSessionRef.current.cancel();
      liveSessionRef.current = null;
    }

    const sessionId = generateId();
    const label = sourceType === 'microphone' ? 'Microphone' : 'Tab Audio';
    
    transcriptStore.createLiveSession(label, sourceType, settings.processingMode);
    
    const session = new LiveTranscriptionSession({
      sessionId,
      modelId: settings.modelId,
      language: settings.sourceLanguage,
      mode: settings.processingMode,
      enableWebGPU: settings.enableWebGPU,
      chunkDuration: settings.liveChunkDuration,
      overlapDuration: settings.liveOverlapDuration,
      maxBufferedChunks: settings.maxBufferedChunks,
      enableTranslation: settings.enableTranslation,
      targetLanguage: settings.targetLanguage,
    });
    
    liveSessionRef.current = session;
    setActiveTab('results');
    setSelectedSessionId(sessionId);
    
    try {
      await session.start(sourceType);
      notify('success', `${label} transcription started`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      notify('error', msg);
      liveSessionRef.current = null;
    }
  }, [settings]);

  const pauseLiveSession = useCallback(() => {
    liveSessionRef.current?.pause();
  }, []);

  const resumeLiveSession = useCallback(() => {
    liveSessionRef.current?.resume();
  }, []);

  const stopLiveSession = useCallback(() => {
    liveSessionRef.current?.stop();
    liveSessionRef.current = null;
    notify('info', 'Live session stopped');
  }, []);

  const cancelLiveSession = useCallback(() => {
    liveSessionRef.current?.cancel();
    liveSessionRef.current = null;
    notify('info', 'Live session cancelled');
  }, []);

  const isLiveActive = liveSessionRef.current !== null;
  const liveState = activeSession?.liveState;

  // ─── File Handling ──────────────────────────────────────────────────────────

  const handleFileSelect = useCallback((files: FileList | null) => {
    if (!files || files.length === 0) return;
    
    const fileArray = Array.from(files);
    const validFiles = fileArray.filter(f => isSupportedAudioFile(f) && f.size > 0);
    
    if (validFiles.length === 0) {
      notify('error', 'No supported audio/video files found');
      return;
    }
    
    if (validFiles.length < fileArray.length) {
      notify('info', `${fileArray.length - validFiles.length} unsupported file(s) skipped`);
    }
    
    const ids = fileQueue?.addFiles(validFiles) || [];
    if (ids.length > 0) {
      setActiveTab('results');
      notify('success', `Added ${ids.length} file(s) to queue`);
    }
  }, [fileQueue]);

  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setDragOver(true);
  }, []);

  const handleDragLeave = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setDragOver(false);
  }, []);

  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setDragOver(false);
    handleFileSelect(e.dataTransfer.files);
  }, [handleFileSelect]);

  // ─── Export ─────────────────────────────────────────────────────────────────

  const handleExport = useCallback((format: 'txt' | 'srt' | 'vtt' | 'json') => {
    if (!activeSession) {
      notify('error', 'No transcript selected');
      return;
    }
    
    if (activeSession.segments.length === 0 && activeSession.soundEvents.length === 0) {
      notify('error', 'No data to export');
      return;
    }
    
    const baseName = activeSession.sourceLabel?.replace(/\.[^.]+$/, '') || 'transcript';
    const options = {
      includeTimestamps: settings.enableTimestamps,
      includeTranslation: showTranslation && activeSession.translatedSegments.length > 0,
      translatedSegments: activeSession.translatedSegments,
    };
    
    let content: string;
    let mimeType: string;
    let ext: string;
    
    switch (format) {
      case 'txt':
        content = exportAsText(activeSession.segments, options);
        mimeType = 'text/plain';
        ext = 'txt';
        break;
      case 'srt':
        content = exportAsSRT(activeSession.segments, options);
        mimeType = 'text/plain';
        ext = 'srt';
        break;
      case 'vtt':
        content = exportAsVTT(activeSession.segments, options);
        mimeType = 'text/vtt';
        ext = 'vtt';
        break;
      case 'json':
        content = exportAsJSON(activeSession.segments, options, {
          language: activeSession.language,
          sourceFile: activeSession.fileName,
        });
        mimeType = 'application/json';
        ext = 'json';
        break;
      default:
        return;
    }
    
    downloadFile(content, `${baseName}.${ext}`, mimeType);
    notify('success', `Exported as ${format.toUpperCase()}`);
  }, [activeSession, settings.enableTimestamps, showTranslation]);

  // ─── Segment Editing ────────────────────────────────────────────────────────

  const updateSegmentText = useCallback((sessionId: string, segmentId: string, text: string) => {
    transcriptStore.updateSegment(sessionId, segmentId, text);
  }, []);

  // ─── Session Management ─────────────────────────────────────────────────────

  const removeSession = useCallback((id: string) => {
    transcriptStore.removeSession(id);
    if (selectedSessionId === id) {
      setSelectedSessionId(null);
    }
  }, [selectedSessionId]);

  const clearAllSessions = useCallback(() => {
    if (liveSessionRef.current) {
      liveSessionRef.current.cancel();
      liveSessionRef.current = null;
    }
    transcriptStore.clearAll();
    setSelectedSessionId(null);
    notify('info', 'All sessions cleared');
  }, []);

  // ─── Status Helpers ─────────────────────────────────────────────────────────

  const getStatusBadge = (session: TranscriptSession) => {
    const state = session.isLive ? session.liveState : session.status;
    const colors: Record<string, string> = {
      idle: 'bg-slate-700 text-slate-300',
      capturing: 'bg-emerald-900/50 text-emerald-300 border border-emerald-700/50',
      paused: 'bg-amber-900/50 text-amber-300 border border-amber-700/50',
      processing: 'bg-blue-900/50 text-blue-300 border border-blue-700/50',
      completed: 'bg-emerald-900/50 text-emerald-300 border border-emerald-700/50',
      failed: 'bg-red-900/50 text-red-300 border border-red-700/50',
      cancelled: 'bg-slate-700 text-slate-400',
      ended: 'bg-slate-700 text-slate-400',
      requesting_permission: 'bg-violet-900/50 text-violet-300',
      ready: 'bg-blue-900/50 text-blue-300',
      processing_stopped: 'bg-blue-900/50 text-blue-300',
      error: 'bg-red-900/50 text-red-300',
      downloading_model: 'bg-violet-900/50 text-violet-300',
      waiting_for_model: 'bg-violet-900/50 text-violet-300',
      decoding: 'bg-blue-900/50 text-blue-300',
    };
    
    const labels: Record<string, string> = {
      idle: 'Idle',
      capturing: '● Live',
      paused: '⏸ Paused',
      processing: '⟳ Processing',
      completed: '✓ Done',
      failed: '✗ Failed',
      cancelled: '⊘ Cancelled',
      ended: '✓ Ended',
      requesting_permission: '⋯ Permission',
      ready: '● Ready',
      processing_stopped: '⟳ Finalizing',
      error: '✗ Error',
      downloading_model: '↓ Downloading',
      waiting_for_model: '⋯ Loading',
      decoding: '⟳ Decoding',
    };
    
    const color = colors[state || ''] || 'bg-slate-700 text-slate-300';
    const label = labels[state || ''] || state || 'Unknown';
    
    return <span className={`text-xs font-medium px-2 py-0.5 rounded-full ${color}`}>{label}</span>;
  };

  // ─── Cleanup on unmount ─────────────────────────────────────────────────────

  useEffect(() => {
    return () => {
      liveSessionRef.current?.cancel();
      fileQueue?.destroy();
    };
  }, []);

  // ─── Render ─────────────────────────────────────────────────────────────────

  return (
    <div className="min-h-screen bg-slate-950 text-slate-100 flex flex-col">
      {/* Notification */}
      {notification && (
        <div className={`fixed top-4 right-4 z-50 px-4 py-3 rounded-lg shadow-lg max-w-md animate-in
          ${notification.type === 'error' ? 'bg-red-900/90 border border-red-700 text-red-100' : ''}
          ${notification.type === 'success' ? 'bg-emerald-900/90 border border-emerald-700 text-emerald-100' : ''}
          ${notification.type === 'info' ? 'bg-slate-800/90 border border-slate-600 text-slate-100' : ''}
        `} role="alert" aria-live="polite">
          <p className="text-sm">{notification.message}</p>
        </div>
      )}

      {/* Header */}
      <header className="border-b border-slate-800 bg-slate-900/80 backdrop-blur-sm sticky top-0 z-40">
        <div className="max-w-7xl mx-auto px-4 py-3 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="w-8 h-8 rounded-lg bg-gradient-to-br from-blue-500 to-violet-600 flex items-center justify-center flex-shrink-0">
              <svg className="w-4 h-4 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M19 11a7 7 0 01-7 7m0 0a7 7 0 01-7-7m7 7v4m0 0H8m4 0h4m-4-8a3 3 0 01-3-3V5a3 3 0 116 0v6a3 3 0 01-3 3z" />
              </svg>
            </div>
            <div>
              <h1 className="text-base font-semibold text-slate-100">AudioScribe</h1>
              <p className="text-xs text-slate-500 hidden sm:block">Local-first multilingual transcription</p>
            </div>
          </div>
          
          {/* Tab navigation */}
          <nav className="flex gap-1" role="tablist">
            {(['live', 'files', 'results'] as const).map(tab => (
              <button
                key={tab}
                role="tab"
                aria-selected={activeTab === tab}
                onClick={() => setActiveTab(tab)}
                className={`px-3 py-1.5 text-sm font-medium rounded-lg transition-colors
                  ${activeTab === tab
                    ? 'bg-slate-800 text-slate-100'
                    : 'text-slate-400 hover:text-slate-200 hover:bg-slate-800/50'
                  }`}
              >
                {tab === 'live' ? '🎙 Live' : tab === 'files' ? '📁 Files' : '📝 Results'}
                {tab === 'results' && sessions.length > 0 && (
                  <span className="ml-1.5 text-xs text-slate-500">({sessions.length})</span>
                )}
              </button>
            ))}
          </nav>

          <button
            onClick={() => setShowSettings(true)}
            className="p-2 rounded-lg hover:bg-slate-800 transition-colors text-slate-400 hover:text-slate-200"
            aria-label="Settings"
            title="Settings"
          >
            <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M9.594 3.94c.09-.542.56-.94 1.11-.94h2.593c.55 0 1.02.398 1.11.94l.213 1.281c.063.374.313.686.645.87.074.04.147.083.22.127.324.196.72.257 1.075.124l1.217-.456a1.125 1.125 0 011.37.49l1.296 2.247a1.125 1.125 0 01-.26 1.431l-1.003.827c-.293.24-.438.613-.431.992a6.759 6.759 0 010 .255c-.007.378.138.75.43.99l1.005.828c.424.35.534.954.26 1.43l-1.298 2.247a1.125 1.125 0 01-1.369.491l-1.217-.456c-.355-.133-.75-.072-1.076.124a6.57 6.57 0 01-.22.128c-.331.183-.581.495-.644.869l-.213 1.28c-.09.543-.56.941-1.11.941h-2.594c-.55 0-1.02-.398-1.11-.94l-.213-1.281c-.062-.374-.312-.686-.644-.87a6.52 6.52 0 01-.22-.127c-.325-.196-.72-.257-1.076-.124l-1.217.456a1.125 1.125 0 01-1.369-.49l-1.297-2.247a1.125 1.125 0 01.26-1.431l1.004-.827c.292-.24.437-.613.43-.992a6.932 6.932 0 010-.255c.007-.378-.138-.75-.43-.99l-1.004-.828a1.125 1.125 0 01-.26-1.43l1.297-2.247a1.125 1.125 0 011.37-.491l1.216.456c.356.133.751.072 1.076-.124.072-.044.146-.087.22-.128.332-.183.582-.495.644-.869l.214-1.281z" />
              <path strokeLinecap="round" strokeLinejoin="round" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
            </svg>
          </button>
        </div>
      </header>

      {/* Main Content */}
      <main className="flex-1 max-w-7xl mx-auto w-full px-4 py-6">
        
        {/* ─── Live Tab ─────────────────────────────────────────────────────── */}
        {activeTab === 'live' && (
          <div className="space-y-6 max-w-2xl mx-auto">
            <div className="text-center mb-8">
              <h2 className="text-xl font-semibold text-slate-100 mb-2">Live Transcription</h2>
              <p className="text-sm text-slate-400">
                Real-time speech recognition from microphone or browser tab audio.
                Transcript appears progressively as you speak.
              </p>
            </div>

            {/* Mode selector */}
            <div className="bg-slate-900 border border-slate-800 rounded-xl p-4">
              <label className="block text-sm font-medium text-slate-300 mb-3">Recognition Mode</label>
              <div className="flex gap-2">
                {([
                  { mode: 'speech' as ProcessingMode, label: '🎙 Speech', desc: 'Spoken dialogue' },
                  { mode: 'song' as ProcessingMode, label: '🎵 Song', desc: 'Sung lyrics (less reliable)' },
                  { mode: 'sound_classification' as ProcessingMode, label: '🔊 Sounds', desc: 'Environmental sounds' },
                ]).map(({ mode, label, desc }) => (
                  <button
                    key={mode}
                    onClick={() => setSettings(s => ({ ...s, processingMode: mode }))}
                    className={`flex-1 px-3 py-3 rounded-lg text-left transition-all
                      ${settings.processingMode === mode
                        ? 'bg-blue-600/20 border border-blue-500/50 text-blue-200'
                        : 'bg-slate-800 border border-slate-700 text-slate-400 hover:bg-slate-700'
                      }`}
                  >
                    <div className="text-sm font-medium">{label}</div>
                    <div className="text-xs opacity-70 mt-0.5">{desc}</div>
                  </button>
                ))}
              </div>
              {settings.processingMode === 'song' && (
                <p className="text-xs text-amber-400/80 mt-3">
                  ⚠ Song/singing recognition is significantly less reliable than speech. Results may be incomplete.
                </p>
              )}
            </div>

            {/* Language */}
            <div className="bg-slate-900 border border-slate-800 rounded-xl p-4">
              <label className="block text-sm font-medium text-slate-300 mb-2">Source Language</label>
              <select
                value={settings.sourceLanguage}
                onChange={(e) => setSettings(s => ({ ...s, sourceLanguage: e.target.value }))}
                className="w-full bg-slate-800 border border-slate-700 rounded-lg px-3 py-2 text-sm text-slate-200 focus:outline-none focus:ring-1 focus:ring-blue-500"
              >
                <option value="auto">Auto-detect</option>
                {Object.entries(SUPPORTED_LANGUAGES).map(([code, name]) => (
                  <option key={code} value={code}>{name}</option>
                ))}
              </select>
            </div>

            {/* Live Controls */}
            <div className="bg-slate-900 border border-slate-800 rounded-xl p-4">
              <label className="block text-sm font-medium text-slate-300 mb-3">Start Live Session</label>
              
              <div className="grid grid-cols-2 gap-3">
                <button
                  onClick={() => startLiveSession('microphone')}
                  disabled={isLiveActive}
                  className={`flex items-center justify-center gap-2 px-4 py-3 rounded-lg text-sm font-medium transition-all
                    ${isLiveActive
                      ? 'bg-slate-800 text-slate-600 cursor-not-allowed'
                      : 'bg-emerald-600 text-white hover:bg-emerald-500 shadow-lg shadow-emerald-600/20'
                    }`}
                >
                  <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M19 11a7 7 0 01-7 7m0 0a7 7 0 01-7-7m7 7v4m0 0H8m4 0h4m-4-8a3 3 0 01-3-3V5a3 3 0 116 0v6a3 3 0 01-3 3z" />
                  </svg>
                  Microphone
                </button>
                
                <button
                  onClick={() => startLiveSession('display_capture')}
                  disabled={isLiveActive}
                  className={`flex items-center justify-center gap-2 px-4 py-3 rounded-lg text-sm font-medium transition-all
                    ${isLiveActive
                      ? 'bg-slate-800 text-slate-600 cursor-not-allowed'
                      : 'bg-violet-600 text-white hover:bg-violet-500 shadow-lg shadow-violet-600/20'
                    }`}
                >
                  <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M9 17.25v1.007a3 3 0 01-.879 2.122L7.5 21h9l-.621-.621A3 3 0 0115 18.257V17.25m6-12V15a2.25 2.25 0 01-2.25 2.25H5.25A2.25 2.25 0 013 15V5.25m18 0A2.25 2.25 0 0018.75 3H5.25A2.25 2.25 0 003 5.25m18 0V12a2.25 2.25 0 01-2.25 2.25H5.25A2.25 2.25 0 013 12V5.25" />
                  </svg>
                  Tab Audio
                </button>
              </div>

              {isLiveActive && (
                <div className="mt-4 space-y-3">
                  <div className="flex items-center gap-2">
                    <span className="relative flex h-3 w-3">
                      {liveState === 'capturing' && (
                        <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-75"></span>
                      )}
                      <span className={`relative inline-flex rounded-full h-3 w-3 ${
                        liveState === 'capturing' ? 'bg-emerald-500' :
                        liveState === 'paused' ? 'bg-amber-500' :
                        'bg-slate-500'
                      }`}></span>
                    </span>
                    <span className="text-sm text-slate-300">
                      {liveState === 'capturing' ? 'Capturing audio...' :
                       liveState === 'paused' ? 'Paused' :
                       liveState === 'processing_stopped' ? 'Finalizing...' :
                       liveState === 'requesting_permission' ? 'Requesting permission...' :
                       'Active'}
                    </span>
                    {activeSession?.processingBacklog && activeSession.processingBacklog > 0 && (
                      <span className="text-xs text-amber-400 ml-auto">
                        ⚠ {activeSession.processingBacklog} chunk(s) queued
                        {activeSession.droppedChunks ? ` • ${activeSession.droppedChunks} dropped` : ''}
                      </span>
                    )}
                  </div>
                  
                  <div className="flex gap-2">
                    {liveState === 'capturing' ? (
                      <button
                        onClick={pauseLiveSession}
                        className="flex-1 py-2 rounded-lg text-sm font-medium bg-amber-600/20 text-amber-300 border border-amber-600/30 hover:bg-amber-600/30 transition-colors"
                      >
                        ⏸ Pause
                      </button>
                    ) : liveState === 'paused' ? (
                      <button
                        onClick={resumeLiveSession}
                        className="flex-1 py-2 rounded-lg text-sm font-medium bg-emerald-600/20 text-emerald-300 border border-emerald-600/30 hover:bg-emerald-600/30 transition-colors"
                      >
                        ▶ Resume
                      </button>
                    ) : null}
                    
                    <button
                      onClick={stopLiveSession}
                      className="flex-1 py-2 rounded-lg text-sm font-medium bg-slate-700 text-slate-200 hover:bg-slate-600 transition-colors"
                    >
                      ⏹ Stop & Finalize
                    </button>
                    
                    <button
                      onClick={cancelLiveSession}
                      className="flex-1 py-2 rounded-lg text-sm font-medium bg-red-900/30 text-red-300 border border-red-800/50 hover:bg-red-900/50 transition-colors"
                    >
                      ✕ Cancel
                    </button>
                  </div>
                </div>
              )}

              {!isLiveActive && (
                <p className="text-xs text-slate-500 mt-3">
                  Tab audio capture requires selecting "Share tab audio" or "Share system audio" in the browser dialog.
                  Browser support varies — Chrome and Edge work best.
                </p>
              )}
            </div>

            {/* Model info */}
            <div className="bg-slate-900/50 border border-slate-800/50 rounded-xl p-4">
              <div className="flex items-center gap-2 text-xs text-slate-500">
                <span className="w-2 h-2 rounded-full bg-emerald-500"></span>
                <span>Model: {WHISPER_MODELS[settings.modelId as keyof typeof WHISPER_MODELS]?.name}</span>
                <span>•</span>
                <span>{settings.enableWebGPU ? 'WebGPU' : 'WASM'}</span>
                <span>•</span>
                <span>All processing local</span>
              </div>
            </div>
          </div>
        )}

        {/* ─── Files Tab ────────────────────────────────────────────────────── */}
        {activeTab === 'files' && (
          <div className="space-y-6 max-w-3xl mx-auto">
            <div className="text-center mb-4">
              <h2 className="text-xl font-semibold text-slate-100 mb-2">File Transcription</h2>
              <p className="text-sm text-slate-400">
                Upload audio or video files for batch transcription. Multiple files supported.
              </p>
            </div>

            {/* Drop zone */}
            <div
              onDragOver={handleDragOver}
              onDragLeave={handleDragLeave}
              onDrop={handleDrop}
              className={`border-2 border-dashed rounded-xl p-8 text-center transition-all cursor-pointer
                ${dragOver ? 'border-blue-500 bg-blue-500/10' : 'border-slate-700 hover:border-slate-500 bg-slate-900'}`}
              onClick={() => fileInputRef.current?.click()}
              role="button"
              tabIndex={0}
              aria-label="Upload audio or video files"
              onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') fileInputRef.current?.click(); }}
            >
              <input
                ref={fileInputRef}
                type="file"
                accept="audio/*,video/*"
                multiple
                className="hidden"
                onChange={(e) => handleFileSelect(e.target.files)}
              />
              <svg className="w-12 h-12 mx-auto text-slate-500 mb-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M3 16.5v2.25A2.25 2.25 0 005.25 21h13.5A2.25 2.25 0 0021 18.75V16.5m-13.5-9L12 3m0 0l4.5 4.5M12 3v13.5" />
              </svg>
              <p className="text-sm text-slate-300 font-medium">Drop files here or click to browse</p>
              <p className="text-xs text-slate-500 mt-1">WAV, MP3, OGG, FLAC, M4A, WebM, MP4 • Multiple files supported</p>
            </div>

            {/* Mode selector for files */}
            <div className="flex gap-2">
              {(['speech', 'song', 'sound_classification'] as ProcessingMode[]).map(mode => (
                <button
                  key={mode}
                  onClick={() => setSettings(s => ({ ...s, processingMode: mode }))}
                  className={`flex-1 px-3 py-2 text-xs font-medium rounded-lg transition-all
                    ${settings.processingMode === mode
                      ? 'bg-blue-600 text-white'
                      : 'bg-slate-800 text-slate-400 hover:bg-slate-700'
                    }`}
                >
                  {mode === 'speech' ? '🎙 Speech' : mode === 'song' ? '🎵 Song' : '🔊 Sounds'}
                </button>
              ))}
            </div>

            {/* File queue */}
            <FileQueueView queue={fileQueue} />
          </div>
        )}

        {/* ─── Results Tab ──────────────────────────────────────────────────── */}
        {activeTab === 'results' && (
          <div className="space-y-4">
            {/* Session selector */}
            {sessions.length > 1 && (
              <div className="flex gap-2 overflow-x-auto pb-2">
                {sessions.map(session => (
                  <button
                    key={session.id}
                    onClick={() => setSelectedSessionId(session.id)}
                    className={`flex items-center gap-2 px-3 py-2 rounded-lg text-sm whitespace-nowrap transition-colors
                      ${(selectedSessionId || sessions[0]?.id) === session.id
                        ? 'bg-slate-800 text-slate-100 border border-slate-600'
                        : 'bg-slate-900 text-slate-400 border border-slate-800 hover:bg-slate-800'
                      }`}
                  >
                    {getStatusBadge(session)}
                    <span className="truncate max-w-[150px]">{session.sourceLabel}</span>
                    <button
                      onClick={(e) => { e.stopPropagation(); removeSession(session.id); }}
                      className="ml-1 p-0.5 rounded hover:bg-slate-700 text-slate-500 hover:text-slate-300"
                      aria-label={`Remove ${session.sourceLabel}`}
                    >
                      <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                        <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
                      </svg>
                    </button>
                  </button>
                ))}
              </div>
            )}

            {/* Active session display */}
            {activeSession ? (
              <div className="space-y-4">
                {/* Session header */}
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-3">
                    <h2 className="text-sm font-medium text-slate-200 truncate max-w-[200px]">
                      {activeSession.sourceLabel}
                    </h2>
                    {getStatusBadge(activeSession)}
                    {activeSession.language !== 'unknown' && (
                      <span className="text-xs text-slate-500">
                        {SUPPORTED_LANGUAGES[activeSession.language] || activeSession.language}
                      </span>
                    )}
                  </div>
                  
                  <div className="flex items-center gap-2">
                    {activeSession.segments.length > 0 && (
                      <>
                        {activeSession.translatedSegments.length > 0 && (
                          <button
                            onClick={() => setShowTranslation(!showTranslation)}
                            className={`px-2.5 py-1 text-xs font-medium rounded-md transition-colors
                              ${showTranslation ? 'bg-blue-600 text-white' : 'bg-slate-800 text-slate-400 hover:bg-slate-700'}`}
                          >
                            Translation
                          </button>
                        )}
                        <div className="flex gap-1">
                          {(['txt', 'srt', 'vtt', 'json'] as const).map(fmt => (
                            <button
                              key={fmt}
                              onClick={() => handleExport(fmt)}
                              className="px-2 py-1 text-xs font-medium rounded-md bg-slate-800 text-slate-400 hover:bg-slate-700 hover:text-slate-200 transition-colors"
                              title={`Export as ${fmt.toUpperCase()}`}
                            >
                              {fmt.toUpperCase()}
                            </button>
                          ))}
                        </div>
                      </>
                    )}
                    <button
                      onClick={() => removeSession(activeSession.id)}
                      className="p-1.5 rounded-lg hover:bg-slate-800 text-slate-500 hover:text-red-400 transition-colors"
                      title="Remove session"
                      aria-label="Remove session"
                    >
                      <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                        <path strokeLinecap="round" strokeLinejoin="round" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                      </svg>
                    </button>
                  </div>
                </div>

                {/* Backlog warning */}
                {activeSession.processingBacklog && activeSession.processingBacklog > 2 && (
                  <div className="bg-amber-900/20 border border-amber-700/30 rounded-lg px-3 py-2 text-xs text-amber-300">
                    ⚠ Processing is behind — {activeSession.processingBacklog} audio chunks queued.
                    {activeSession.droppedChunks ? ` ${activeSession.droppedChunks} chunk(s) were dropped due to overload.` : ''}
                    {' '}Transcript may have gaps.
                  </div>
                )}

                {/* Transcript segments */}
                {activeSession.segments.length > 0 ? (
                  <div className="bg-slate-900 border border-slate-800 rounded-xl overflow-hidden">
                    <div className="max-h-[60vh] overflow-y-auto">
                      {activeSession.segments.map((segment, index) => (
                        <div
                          key={segment.id}
                          className="border-b border-slate-800/50 last:border-0 hover:bg-slate-800/20 transition-colors"
                        >
                          <div className="flex items-start gap-3 p-3">
                            {/* Timestamp */}
                            {settings.enableTimestamps && segment.endTime > 0 && (
                              <span className="text-xs text-blue-400/70 font-mono whitespace-nowrap pt-0.5 min-w-[60px]">
                                {formatDuration(segment.startTime)}
                              </span>
                            )}
                            
                            {/* Text */}
                            {editingSegmentId === segment.id ? (
                              <textarea
                                autoFocus
                                value={segment.text}
                                onChange={(e) => updateSegmentText(activeSession.id, segment.id, e.target.value)}
                                onBlur={() => setEditingSegmentId(null)}
                                onKeyDown={(e) => { if (e.key === 'Escape') setEditingSegmentId(null); }}
                                className="flex-1 bg-slate-800 border border-blue-500/50 rounded-lg px-3 py-1.5 text-sm text-slate-100 resize-none focus:outline-none focus:ring-1 focus:ring-blue-500"
                                rows={2}
                              />
                            ) : (
                              <p
                                className={`flex-1 text-sm leading-relaxed cursor-pointer ${
                                  segment.isUncertain ? 'text-amber-200/80 italic' : 'text-slate-200'
                                }`}
                                onClick={() => setEditingSegmentId(segment.id)}
                                title="Click to edit"
                              >
                                {segment.text || <span className="text-slate-600 italic">[empty]</span>}
                              </p>
                            )}

                            {/* Translation */}
                            {showTranslation && (
                              <div className="flex-1 text-sm text-blue-300/70 italic border-l border-slate-700 pl-3">
                                {activeSession.translatedSegments.find(t => t.originalId === segment.id)?.text || '—'}
                              </div>
                            )}
                            
                            <span className="text-xs text-slate-700 font-mono">{index + 1}</span>
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
                ) : activeSession.soundEvents.length > 0 ? (
                  /* Sound classification results */
                  <div className="bg-slate-900 border border-slate-800 rounded-xl p-4">
                    <div className="space-y-2">
                      {activeSession.soundEvents.map((event, i) => (
                        <div key={i} className="flex items-center gap-3">
                          <span className="text-sm text-slate-200 flex-1 truncate">{event.label}</span>
                          <div className="w-32 h-2 bg-slate-800 rounded-full overflow-hidden">
                            <div
                              className="h-full bg-gradient-to-r from-violet-500 to-blue-500 rounded-full"
                              style={{ width: `${(event.score * 100).toFixed(0)}%` }}
                            />
                          </div>
                          <span className="text-xs text-slate-400 font-mono w-12 text-right">
                            {(event.score * 100).toFixed(1)}%
                          </span>
                        </div>
                      ))}
                    </div>
                    <p className="text-xs text-slate-600 mt-4">
                      Scores represent model confidence, not calibrated probabilities.
                    </p>
                  </div>
                ) : (
                  /* Empty / processing state */
                  <div className="bg-slate-900/50 border border-slate-800/50 rounded-xl p-8 text-center">
                    {activeSession.status === 'processing' || activeSession.status === 'decoding' || activeSession.status === 'downloading_model' || activeSession.status === 'waiting_for_model' ? (
                      <div>
                        <div className="w-8 h-8 mx-auto mb-3 border-2 border-blue-500 border-t-transparent rounded-full animate-spin"></div>
                        <p className="text-sm text-slate-300">Processing...</p>
                        <p className="text-xs text-slate-500 mt-1">
                          {activeSession.isLive ? 'Audio is being captured and processed in chunks' : 'Decoding and transcribing audio'}
                        </p>
                      </div>
                    ) : activeSession.status === 'failed' ? (
                      <div>
                        <p className="text-sm text-red-400">Processing failed</p>
                        <p className="text-xs text-slate-500 mt-1">Check settings and try again</p>
                      </div>
                    ) : (
                      <div>
                        <p className="text-sm text-slate-400">No transcript data yet</p>
                        <p className="text-xs text-slate-600 mt-1">
                          {activeSession.isLive
                            ? 'Start a live session from the Live tab'
                            : 'Add files from the Files tab'}
                        </p>
                      </div>
                    )}
                  </div>
                )}

                {/* Partial segment (live) */}
                {activeSession.partialSegment && activeSession.partialSegment.text && (
                  <div className="bg-slate-900/50 border border-blue-800/30 rounded-xl p-3">
                    <div className="flex items-start gap-3">
                      <span className="text-xs text-blue-400/50 font-mono pt-0.5">...</span>
                      <p className="flex-1 text-sm text-blue-300/70 italic">
                        {activeSession.partialSegment.text}
                      </p>
                    </div>
                  </div>
                )}
              </div>
            ) : (
              /* No sessions */
              <div className="bg-slate-900/50 border border-slate-800/50 rounded-xl p-12 text-center">
                <div className="w-16 h-16 mx-auto mb-4 rounded-2xl bg-slate-800/50 flex items-center justify-center">
                  <svg className="w-8 h-8 text-slate-600" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
                  </svg>
                </div>
                <h3 className="text-sm font-medium text-slate-400 mb-1">No transcripts yet</h3>
                <p className="text-xs text-slate-600">
                  Start a live session or upload files to begin transcription.
                </p>
              </div>
            )}

            {sessions.length > 0 && (
              <div className="flex justify-end">
                <button
                  onClick={clearAllSessions}
                  className="px-3 py-1.5 text-xs font-medium rounded-lg bg-slate-800 text-slate-400 hover:bg-red-900/30 hover:text-red-300 transition-colors"
                >
                  Clear all sessions
                </button>
              </div>
            )}
          </div>
        )}
      </main>

      {/* Settings Panel */}
      {showSettings && (
        <SettingsPanel
          settings={settings}
          onChange={setSettings}
          onClose={() => setShowSettings(false)}
        />
      )}

      {/* Footer */}
      <footer className="border-t border-slate-800/50 py-3 px-4 mt-auto">
        <div className="max-w-7xl mx-auto flex items-center justify-between text-xs text-slate-600">
          <span>AudioScribe — Local-first, privacy-conscious transcription</span>
          <span>{settings.enableWebGPU ? 'WebGPU' : 'WASM'} • {WHISPER_MODELS[settings.modelId as keyof typeof WHISPER_MODELS]?.name}</span>
        </div>
      </footer>
    </div>
  );
}

// ─── File Queue View Component ────────────────────────────────────────────────

function FileQueueView({ queue }: { queue: FileQueueManager | null }) {
  const [items, setItems] = useState<FileQueueItem[]>([]);

  useEffect(() => {
    if (!queue) return;
    const update = () => setItems(queue.getQueue());
    update();
    const unsub = queue.subscribe(update);
    const interval = setInterval(update, 500);
    return () => { unsub(); clearInterval(interval); };
  }, [queue]);

  if (items.length === 0) {
    return (
      <div className="text-center py-8">
        <p className="text-sm text-slate-500">
          Files will appear here after upload. Processing begins automatically.
        </p>
        <p className="text-xs text-slate-600 mt-2">
          Results appear in the Results tab as they complete.
        </p>
      </div>
    );
  }

  return (
    <div className="bg-slate-900 border border-slate-800 rounded-xl overflow-hidden">
      <div className="px-4 py-2 border-b border-slate-800 flex items-center justify-between">
        <span className="text-sm font-medium text-slate-300">Queue ({items.length})</span>
        <button
          onClick={() => queue?.clearCompleted()}
          className="text-xs text-slate-500 hover:text-slate-300 transition-colors"
        >
          Clear completed
        </button>
      </div>
      <div className="max-h-[40vh] overflow-y-auto divide-y divide-slate-800/50">
        {items.map(item => (
          <div key={item.id} className="px-4 py-3 flex items-center gap-3">
            <div className="flex-1 min-w-0">
              <p className="text-sm text-slate-200 truncate">{item.name}</p>
              <div className="flex items-center gap-2 mt-1">
                <span className={`text-xs ${
                  item.status === 'completed' ? 'text-emerald-400' :
                  item.status === 'failed' ? 'text-red-400' :
                  item.status === 'cancelled' ? 'text-slate-500' :
                  'text-blue-400'
                }`}>
                  {item.status === 'idle' ? 'Queued' :
                   item.status === 'decoding' ? 'Decoding...' :
                   item.status === 'processing' ? 'Transcribing...' :
                   item.status === 'completed' ? '✓ Complete' :
                   item.status === 'failed' ? `✗ ${item.error?.slice(0, 40) || 'Failed'}` :
                   item.status === 'cancelled' ? 'Cancelled' :
                   item.progressMessage}
                </span>
                <span className="text-xs text-slate-600">{(item.size / (1024 * 1024)).toFixed(1)} MB</span>
              </div>
              {(item.status === 'processing' || item.status === 'decoding') && (
                <div className="w-full h-1 bg-slate-800 rounded-full mt-1.5 overflow-hidden">
                  <div
                    className="h-full bg-blue-500 rounded-full transition-all"
                    style={{ width: `${item.progress}%` }}
                  />
                </div>
              )}
            </div>
            <div className="flex gap-1">
              {(item.status === 'failed' || item.status === 'cancelled') && (
                <button
                  onClick={() => queue?.retryItem(item.id)}
                  className="p-1 rounded hover:bg-slate-700 text-slate-500 hover:text-slate-300"
                  title="Retry"
                >
                  <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
                  </svg>
                </button>
              )}
              {(item.status === 'processing' || item.status === 'decoding' || item.status === 'idle') && (
                <button
                  onClick={() => queue?.cancelItem(item.id)}
                  className="p-1 rounded hover:bg-red-900/30 text-slate-500 hover:text-red-400"
                  title="Cancel"
                >
                  <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
                  </svg>
                </button>
              )}
              <button
                onClick={() => queue?.removeItem(item.id)}
                className="p-1 rounded hover:bg-slate-700 text-slate-500 hover:text-slate-300"
                title="Remove"
              >
                <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                </svg>
              </button>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

// ─── Settings Panel Component ─────────────────────────────────────────────────

function SettingsPanel({
  settings,
  onChange,
  onClose,
}: {
  settings: AppSettings;
  onChange: (s: AppSettings | ((prev: AppSettings) => AppSettings)) => void;
  onClose: () => void;
}) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm" onClick={onClose}>
      <div
        className="bg-slate-900 border border-slate-700 rounded-2xl w-full max-w-lg max-h-[85vh] overflow-y-auto shadow-2xl m-4"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-label="Settings"
      >
        <div className="p-6 space-y-6">
          <div className="flex items-center justify-between">
            <h2 className="text-lg font-semibold text-slate-100">Settings</h2>
            <button onClick={onClose} className="p-2 rounded-lg hover:bg-slate-800 text-slate-400" aria-label="Close">
              <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
              </svg>
            </button>
          </div>

          {/* Model */}
          <div>
            <label className="block text-sm font-medium text-slate-300 mb-2">Speech Recognition Model</label>
            <select
              value={settings.modelId}
              onChange={(e) => onChange((s: AppSettings) => ({ ...s, modelId: e.target.value }))}
              className="w-full bg-slate-800 border border-slate-700 rounded-lg px-3 py-2 text-sm text-slate-200 focus:outline-none focus:ring-1 focus:ring-blue-500"
            >
              {Object.entries(WHISPER_MODELS).map(([id, info]) => (
                <option key={id} value={id}>{info.name} ({info.size})</option>
              ))}
            </select>
            <p className="text-xs text-slate-500 mt-1">
              Smaller = faster download, less memory. Larger = better accuracy.
            </p>
          </div>

          {/* Live settings */}
          <div>
            <label className="block text-sm font-medium text-slate-300 mb-2">Live Transcription</label>
            <div className="space-y-3">
              <div>
                <label className="text-xs text-slate-400">Chunk duration: {settings.liveChunkDuration}s</label>
                <input
                  type="range" min="3" max="15" step="1"
                  value={settings.liveChunkDuration}
                  onChange={(e) => onChange((s: AppSettings) => ({ ...s, liveChunkDuration: parseInt(e.target.value) }))}
                  className="w-full mt-1"
                />
                <p className="text-xs text-slate-600">Shorter = more responsive but less accurate</p>
              </div>
              <div>
                <label className="text-xs text-slate-400">Overlap: {settings.liveOverlapDuration}s</label>
                <input
                  type="range" min="0" max="5" step="0.5"
                  value={settings.liveOverlapDuration}
                  onChange={(e) => onChange((s: AppSettings) => ({ ...s, liveOverlapDuration: parseFloat(e.target.value) }))}
                  className="w-full mt-1"
                />
                <p className="text-xs text-slate-600">Overlap helps prevent missing words at chunk boundaries</p>
              </div>
              <div>
                <label className="text-xs text-slate-400">Max buffered chunks: {settings.maxBufferedChunks}</label>
                <input
                  type="range" min="2" max="10" step="1"
                  value={settings.maxBufferedChunks}
                  onChange={(e) => onChange((s: AppSettings) => ({ ...s, maxBufferedChunks: parseInt(e.target.value) }))}
                  className="w-full mt-1"
                />
                <p className="text-xs text-slate-600">Higher = tolerates slower inference, uses more memory</p>
              </div>
            </div>
          </div>

          {/* File settings */}
          <div>
            <label className="block text-sm font-medium text-slate-300 mb-2">File Processing</label>
            <div className="space-y-2">
              <div>
                <label className="text-xs text-slate-400">Chunk duration: {settings.chunkDuration}s</label>
                <input
                  type="range" min="10" max="60" step="5"
                  value={settings.chunkDuration}
                  onChange={(e) => onChange((s: AppSettings) => ({ ...s, chunkDuration: parseInt(e.target.value) }))}
                  className="w-full mt-1"
                />
              </div>
              <div>
                <label className="text-xs text-slate-400">Max concurrent files: {settings.maxConcurrentJobs}</label>
                <input
                  type="range" min="1" max="3" step="1"
                  value={settings.maxConcurrentJobs}
                  onChange={(e) => onChange((s: AppSettings) => ({ ...s, maxConcurrentJobs: parseInt(e.target.value) }))}
                  className="w-full mt-1"
                />
              </div>
            </div>
          </div>

          {/* Options */}
          <div>
            <label className="block text-sm font-medium text-slate-300 mb-2">Options</label>
            <div className="space-y-2">
              <label className="flex items-center gap-2 text-sm text-slate-400 cursor-pointer">
                <input
                  type="checkbox"
                  checked={settings.enableTimestamps}
                  onChange={(e) => onChange((s: AppSettings) => ({ ...s, enableTimestamps: e.target.checked }))}
                />
                Include timestamps
              </label>
              <label className="flex items-center gap-2 text-sm text-slate-400 cursor-pointer">
                <input
                  type="checkbox"
                  checked={settings.enableTranslation}
                  onChange={(e) => onChange((s: AppSettings) => ({ ...s, enableTranslation: e.target.checked }))}
                />
                Translate to English (Whisper built-in)
              </label>
              <label className="flex items-center gap-2 text-sm text-slate-400 cursor-pointer">
                <input
                  type="checkbox"
                  checked={settings.enableWebGPU}
                  onChange={(e) => onChange((s: AppSettings) => ({ ...s, enableWebGPU: e.target.checked }))}
                />
                Use WebGPU (requires compatible hardware)
              </label>
            </div>
          </div>

          {/* Privacy */}
          <div className="border-t border-slate-800 pt-4">
            <h3 className="text-sm font-medium text-slate-300 mb-2">Privacy</h3>
            <div className="space-y-1 text-xs text-slate-500">
              <p>• All audio processing runs locally in your browser</p>
              <p>• No audio or transcripts sent to external servers</p>
              <p>• Models downloaded once from Hugging Face, then cached</p>
              <p>• No accounts, telemetry, or analytics</p>
              <p>• Microphone/capture streams released when session ends</p>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

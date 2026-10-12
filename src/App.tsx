import { useState, useRef, useCallback, useEffect } from 'react';
import type {
  JobState, AudioSource, TranscriptSegment, SoundEvent,
  AppSettings, ProcessingMode, JobStatus
} from './types';
import { SUPPORTED_LANGUAGES, TRANSLATION_TARGET_LANGUAGES, WHISPER_MODELS } from './types';
import {
  decodeAudioFile, prepareForWhisper, isSupportedAudioFile,
  formatDuration, createPlaybackUrl, generateId
} from './services/audioProcessor';
import {
  exportAsText, exportAsSRT, exportAsVTT, exportAsJSON, downloadFile
} from './services/exportService';

// ─── Main App ─────────────────────────────────────────────────────────────────

export default function App() {
  // State
  const [audioSource, setAudioSource] = useState<AudioSource | null>(null);
  const [job, setJob] = useState<JobState | null>(null);
  const [segments, setSegments] = useState<TranscriptSegment[]>([]);
  const [soundEvents, setSoundEvents] = useState<SoundEvent[]>([]);
  const [editingSegmentId, setEditingSegmentId] = useState<string | null>(null);
  const [showSettings, setShowSettings] = useState(false);
  const [isRecording, setIsRecording] = useState(false);
  const [recordingDuration, setRecordingDuration] = useState(0);
  const [isCapturing, setIsCapturing] = useState(false);
  const [dragOver, setDragOver] = useState(false);
  const [notification, setNotification] = useState<{ type: 'info' | 'error' | 'success'; message: string } | null>(null);

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
  });

  const workerRef = useRef<Worker | null>(null);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const recordingTimerRef = useRef<number | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const audioRef = useRef<HTMLAudioElement>(null);
  const playbackUrlRef = useRef<string | null>(null);

  // Initialize worker
  useEffect(() => {
    const worker = new Worker(
      new URL('./workers/transcription.worker.ts', import.meta.url),
      { type: 'module' }
    );
    
    worker.onmessage = (event) => {
      const { type, payload } = event.data;
      
      if (type === 'progress') {
        setJob(prev => prev ? {
          ...prev,
          progress: payload.progress,
          progressMessage: payload.message,
          status: payload.progress >= 100 ? 'processing' : prev.status,
        } : null);
      } else if (type === 'result') {
        handleWorkerResult(payload);
      } else if (type === 'error') {
        setJob(prev => prev ? {
          ...prev,
          status: 'failed',
          error: payload.error,
          progressMessage: payload.error,
        } : null);
        showNotification('error', payload.error);
      }
    };
    
    worker.onerror = (error) => {
      showNotification('error', `Worker error: ${error.message}`);
    };
    
    workerRef.current = worker;
    
    return () => {
      worker.terminate();
    };
  }, []);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      if (playbackUrlRef.current) {
        URL.revokeObjectURL(playbackUrlRef.current);
      }
      if (streamRef.current) {
        streamRef.current.getTracks().forEach(t => t.stop());
      }
      if (recordingTimerRef.current) {
        clearInterval(recordingTimerRef.current);
      }
    };
  }, []);

  // Notification auto-dismiss
  useEffect(() => {
    if (notification) {
      const timer = setTimeout(() => setNotification(null), 5000);
      return () => clearTimeout(timer);
    }
  }, [notification]);

  function showNotification(type: 'info' | 'error' | 'success', message: string) {
    setNotification({ type, message });
  }

  function handleWorkerResult(payload: any) {
    if (payload.type === 'transcription') {
      const newSegments: TranscriptSegment[] = (payload.segments || []).map((s: any, i: number) => ({
        id: s.id || `seg-${i}`,
        text: s.text || '',
        startTime: s.startTime || 0,
        endTime: s.endTime || 0,
        language: s.language || settings.sourceLanguage,
        isUncertain: settings.processingMode === 'song',
      }));
      
      setSegments(newSegments);
      setJob(prev => prev ? { ...prev, status: 'completed', progress: 100, progressMessage: 'Transcription complete' } : null);
      showNotification('success', `Transcription complete: ${newSegments.length} segments`);
    } else if (payload.type === 'classification') {
      setSoundEvents(payload.events || []);
      setJob(prev => prev ? { ...prev, status: 'completed', progress: 100, progressMessage: 'Classification complete' } : null);
      showNotification('success', 'Sound classification complete');
    } else if (payload.type === 'cancelled') {
      setJob(prev => prev ? { ...prev, status: 'cancelled', progressMessage: 'Cancelled' } : null);
    }
  }

  // ─── File Handling ──────────────────────────────────────────────────────────

  const handleFileSelect = useCallback(async (files: FileList | null) => {
    if (!files || files.length === 0) return;
    
    const file = files[0];
    
    if (!isSupportedAudioFile(file)) {
      showNotification('error', `Unsupported file type: ${file.type || 'unknown'}. Supported: WAV, MP3, OGG, FLAC, M4A, WebM, MP4`);
      return;
    }
    
    if (file.size === 0) {
      showNotification('error', 'File is empty');
      return;
    }
    
    if (file.size > 500 * 1024 * 1024) {
      showNotification('error', 'File too large (max 500MB for browser processing)');
      return;
    }
    
    try {
      // Cleanup previous
      if (playbackUrlRef.current) {
        URL.revokeObjectURL(playbackUrlRef.current);
      }
      
      const objectUrl = createPlaybackUrl(file);
      playbackUrlRef.current = objectUrl;
      
      const source: AudioSource = {
        id: generateId(),
        type: 'file',
        name: file.name,
        duration: 0,
        sampleRate: 0,
        channels: 0,
        file,
        objectUrl,
        createdAt: new Date(),
      };
      
      setAudioSource(source);
      setSegments([]);
      setSoundEvents([]);
      setJob(null);
      
      showNotification('info', `Loaded: ${file.name}`);
    } catch (err) {
      showNotification('error', `Failed to load file: ${err instanceof Error ? err.message : 'Unknown error'}`);
    }
  }, []);

  // ─── Drag and Drop ──────────────────────────────────────────────────────────

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

  // ─── Microphone Recording ──────────────────────────────────────────────────

  const startRecording = useCallback(async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      streamRef.current = stream;
      
      const mediaRecorder = new MediaRecorder(stream, {
        mimeType: MediaRecorder.isTypeSupported('audio/webm;codecs=opus')
          ? 'audio/webm;codecs=opus'
          : 'audio/webm'
      });
      
      const chunks: Blob[] = [];
      mediaRecorder.ondataavailable = (e) => {
        if (e.data.size > 0) chunks.push(e.data);
      };
      
      mediaRecorder.onstop = async () => {
        const blob = new Blob(chunks, { type: 'audio/webm' });
        const file = new File([blob], `recording-${Date.now()}.webm`, { type: 'audio/webm' });
        
        if (playbackUrlRef.current) URL.revokeObjectURL(playbackUrlRef.current);
        const objectUrl = URL.createObjectURL(blob);
        playbackUrlRef.current = objectUrl;
        
        const source: AudioSource = {
          id: generateId(),
          type: 'microphone',
          name: `Recording ${new Date().toLocaleTimeString()}`,
          duration: recordingDuration,
          sampleRate: 0,
          channels: 1,
          file,
          objectUrl,
          createdAt: new Date(),
        };
        
        setAudioSource(source);
        setSegments([]);
        setSoundEvents([]);
        setJob(null);
        setIsRecording(false);
        setRecordingDuration(0);
        
        stream.getTracks().forEach(t => t.stop());
        streamRef.current = null;
        
        showNotification('success', 'Recording saved');
      };
      
      mediaRecorderRef.current = mediaRecorder;
      mediaRecorder.start(1000);
      setIsRecording(true);
      setRecordingDuration(0);
      
      recordingTimerRef.current = window.setInterval(() => {
        setRecordingDuration(prev => prev + 1);
      }, 1000);
      
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unknown error';
      if (message.includes('Permission') || message.includes('NotAllowed')) {
        showNotification('error', 'Microphone permission denied. Please allow microphone access in your browser settings.');
      } else {
        showNotification('error', `Failed to start recording: ${message}`);
      }
    }
  }, [recordingDuration]);

  const stopRecording = useCallback(() => {
    if (mediaRecorderRef.current && mediaRecorderRef.current.state !== 'inactive') {
      mediaRecorderRef.current.stop();
    }
    if (recordingTimerRef.current) {
      clearInterval(recordingTimerRef.current);
      recordingTimerRef.current = null;
    }
  }, []);

  // ─── Display Capture ────────────────────────────────────────────────────────

  const startCapture = useCallback(async () => {
    try {
      const stream = await navigator.mediaDevices.getDisplayMedia({
        video: true,
        audio: true,
      } as any);
      
      // Check if audio track is available
      const audioTracks = stream.getAudioTracks();
      if (audioTracks.length === 0) {
        stream.getTracks().forEach(t => t.stop());
        showNotification('error', 'No audio captured. Make sure to select "Share audio" or "Share tab audio" when prompted.');
        return;
      }
      
      streamRef.current = stream;
      setIsCapturing(true);
      
      // Record the captured audio
      const mediaRecorder = new MediaRecorder(stream, {
        mimeType: MediaRecorder.isTypeSupported('audio/webm;codecs=opus')
          ? 'audio/webm;codecs=opus'
          : 'audio/webm'
      });
      
      const chunks: Blob[] = [];
      mediaRecorder.ondataavailable = (e) => {
        if (e.data.size > 0) chunks.push(e.data);
      };
      
      // Handle track ending (user stops sharing)
      audioTracks[0].onended = () => {
        if (mediaRecorder.state !== 'inactive') {
          mediaRecorder.stop();
        }
      };
      
      mediaRecorder.onstop = async () => {
        const blob = new Blob(chunks, { type: 'audio/webm' });
        const file = new File([blob], `capture-${Date.now()}.webm`, { type: 'audio/webm' });
        
        if (playbackUrlRef.current) URL.revokeObjectURL(playbackUrlRef.current);
        const objectUrl = URL.createObjectURL(blob);
        playbackUrlRef.current = objectUrl;
        
        const source: AudioSource = {
          id: generateId(),
          type: 'display_capture',
          name: `Tab capture ${new Date().toLocaleTimeString()}`,
          duration: 0,
          sampleRate: 0,
          channels: 1,
          file,
          objectUrl,
          createdAt: new Date(),
        };
        
        setAudioSource(source);
        setIsCapturing(false);
        stream.getTracks().forEach(t => t.stop());
        streamRef.current = null;
        
        showNotification('success', 'Capture saved');
      };
      
      mediaRecorderRef.current = mediaRecorder;
      mediaRecorder.start(1000);
      
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unknown error';
      if (message.includes('Permission') || message.includes('NotAllowed')) {
        showNotification('error', 'Screen capture permission denied.');
      } else {
        showNotification('error', `Capture failed: ${message}`);
      }
      setIsCapturing(false);
    }
  }, []);

  const stopCapture = useCallback(() => {
    if (mediaRecorderRef.current && mediaRecorderRef.current.state !== 'inactive') {
      mediaRecorderRef.current.stop();
    }
    if (streamRef.current) {
      streamRef.current.getTracks().forEach(t => t.stop());
      streamRef.current = null;
    }
    setIsCapturing(false);
  }, []);

  // ─── Processing ─────────────────────────────────────────────────────────────

  const startProcessing = useCallback(async () => {
    if (!audioSource?.file) {
      showNotification('error', 'No audio source loaded');
      return;
    }
    
    if (!workerRef.current) {
      showNotification('error', 'Worker not initialized');
      return;
    }
    
    const jobId = generateId();
    setJob({
      id: jobId,
      sourceId: audioSource.id,
      status: 'decoding',
      mode: settings.processingMode,
      progress: 0,
      progressMessage: 'Decoding audio...',
      startedAt: new Date(),
      cancelled: false,
    });
    
    setSegments([]);
    setSoundEvents([]);
    
    try {
      // Decode audio
      const decoded = await decodeAudioFile(audioSource.file);
      
      if (settings.processingMode === 'sound_classification') {
        // Sound classification
        const audioData = prepareForWhisper(decoded);
        
        setJob(prev => prev ? { ...prev, status: 'processing', progressMessage: 'Classifying sounds...' } : null);
        
        workerRef.current.postMessage({
          type: 'classify',
          payload: {
            audio: audioData,
            samplingRate: 16000,
            model: 'Xenova/ast-finetuned-audioset-10-10-0.4593',
            topK: 10,
          }
        });
      } else {
        // Speech/Song transcription
        const audioData = prepareForWhisper(decoded);
        
        setJob(prev => prev ? { ...prev, status: 'waiting_for_model', progressMessage: 'Loading model...' } : null);
        
        const task = settings.enableTranslation && settings.targetLanguage === 'en'
          ? 'translate'
          : 'transcribe';
        
        workerRef.current.postMessage({
          type: 'transcribe',
          payload: {
            audio: audioData,
            samplingRate: 16000,
            model: settings.modelId,
            language: settings.sourceLanguage === 'auto' ? undefined : settings.sourceLanguage,
            task,
            chunkLength: settings.chunkDuration,
            returnTimestamps: settings.enableTimestamps,
          }
        });
      }
      
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unknown error';
      setJob(prev => prev ? { ...prev, status: 'failed', error: message, progressMessage: message } : null);
      showNotification('error', `Processing failed: ${message}`);
    }
  }, [audioSource, settings]);

  const cancelProcessing = useCallback(() => {
    if (workerRef.current) {
      workerRef.current.postMessage({ type: 'cancel' });
    }
    setJob(prev => prev ? { ...prev, cancelled: true, status: 'cancelled', progressMessage: 'Cancelling...' } : null);
  }, []);

  // ─── Transcript Editing ─────────────────────────────────────────────────────

  const updateSegmentText = useCallback((id: string, text: string) => {
    setSegments(prev => prev.map(s => s.id === id ? { ...s, text } : s));
  }, []);

  // ─── Export ─────────────────────────────────────────────────────────────────

  const handleExport = useCallback((format: 'txt' | 'srt' | 'vtt' | 'json') => {
    if (segments.length === 0 && soundEvents.length === 0) {
      showNotification('error', 'No transcript data to export');
      return;
    }
    
    const baseName = audioSource?.name?.replace(/\.[^.]+$/, '') || 'transcript';
    const options = {
      includeTimestamps: settings.enableTimestamps,
      includeTranslation: false,
    };
    
    let content: string;
    let mimeType: string;
    let ext: string;
    
    switch (format) {
      case 'txt':
        content = exportAsText(segments, options);
        mimeType = 'text/plain';
        ext = 'txt';
        break;
      case 'srt':
        content = exportAsSRT(segments, options);
        mimeType = 'text/srt';
        ext = 'srt';
        break;
      case 'vtt':
        content = exportAsVTT(segments, options);
        mimeType = 'text/vtt';
        ext = 'vtt';
        break;
      case 'json':
        content = exportAsJSON(segments, options, {
          language: segments[0]?.language,
          sourceFile: audioSource?.name,
        });
        mimeType = 'application/json';
        ext = 'json';
        break;
    }
    
    downloadFile(content, `${baseName}.${ext}`, mimeType);
    showNotification('success', `Exported as ${format.toUpperCase()}`);
  }, [segments, soundEvents, audioSource, settings]);

  // ─── Clear Session ──────────────────────────────────────────────────────────

  const clearSession = useCallback(() => {
    if (playbackUrlRef.current) {
      URL.revokeObjectURL(playbackUrlRef.current);
      playbackUrlRef.current = null;
    }
    setAudioSource(null);
    setJob(null);
    setSegments([]);
    setSoundEvents([]);
    setEditingSegmentId(null);
    showNotification('info', 'Session cleared');
  }, []);

  // ─── Status Helpers ─────────────────────────────────────────────────────────

  const getStatusColor = (status: JobStatus): string => {
    switch (status) {
      case 'completed': return 'text-emerald-400';
      case 'failed': return 'text-red-400';
      case 'cancelled': return 'text-amber-400';
      case 'processing':
      case 'translating': return 'text-blue-400';
      default: return 'text-slate-400';
    }
  };

  const isProcessing = job && !['completed', 'failed', 'cancelled', 'idle'].includes(job.status);

  // ─── Render ─────────────────────────────────────────────────────────────────

  return (
    <div className="min-h-screen bg-slate-950 text-slate-100 flex flex-col">
      {/* Notification */}
      {notification && (
        <div className={`fixed top-4 right-4 z-50 px-4 py-3 rounded-lg shadow-lg max-w-md transition-all
          ${notification.type === 'error' ? 'bg-red-900/90 border border-red-700 text-red-100' : ''}
          ${notification.type === 'success' ? 'bg-emerald-900/90 border border-emerald-700 text-emerald-100' : ''}
          ${notification.type === 'info' ? 'bg-slate-800/90 border border-slate-600 text-slate-100' : ''}
        `} role="alert">
          <p className="text-sm">{notification.message}</p>
        </div>
      )}

      {/* Header */}
      <header className="border-b border-slate-800 bg-slate-900/80 backdrop-blur-sm sticky top-0 z-40">
        <div className="max-w-7xl mx-auto px-4 py-3 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="w-8 h-8 rounded-lg bg-gradient-to-br from-blue-500 to-violet-600 flex items-center justify-center">
              <svg className="w-4 h-4 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M19 11a7 7 0 01-7 7m0 0a7 7 0 01-7-7m7 7v4m0 0H8m4 0h4m-4-8a3 3 0 01-3-3V5a3 3 0 116 0v6a3 3 0 01-3 3z" />
              </svg>
            </div>
            <div>
              <h1 className="text-base font-semibold text-slate-100">AudioScribe</h1>
              <p className="text-xs text-slate-500">Local-first multilingual transcription</p>
            </div>
          </div>
          
          <div className="flex items-center gap-2">
            {job && (
              <span className={`text-xs font-medium px-2 py-1 rounded ${getStatusColor(job.status)} bg-slate-800/50`}>
                {job.status.replace(/_/g, ' ')}
              </span>
            )}
            <button
              onClick={() => setShowSettings(!showSettings)}
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
        </div>
      </header>

      {/* Main Content */}
      <main className="flex-1 max-w-7xl mx-auto w-full px-4 py-6">
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
          
          {/* Left Panel - Audio Input & Controls */}
          <div className="lg:col-span-5 space-y-4">
            
            {/* Processing Mode */}
            <div className="bg-slate-900 border border-slate-800 rounded-xl p-4">
              <h2 className="text-sm font-medium text-slate-300 mb-3">Processing Mode</h2>
              <div className="flex gap-2">
                {(['speech', 'song', 'sound_classification'] as ProcessingMode[]).map(mode => (
                  <button
                    key={mode}
                    onClick={() => setSettings(s => ({ ...s, processingMode: mode }))}
                    className={`flex-1 px-3 py-2 text-xs font-medium rounded-lg transition-all
                      ${settings.processingMode === mode
                        ? 'bg-blue-600 text-white shadow-lg shadow-blue-600/20'
                        : 'bg-slate-800 text-slate-400 hover:bg-slate-700 hover:text-slate-200'
                      }`}
                  >
                    {mode === 'speech' ? '🎙 Speech' : mode === 'song' ? '🎵 Song' : '🔊 Sounds'}
                  </button>
                ))}
              </div>
              {settings.processingMode === 'song' && (
                <p className="text-xs text-amber-400/80 mt-2">
                  ⚠ Song transcription is less reliable than speech. Results may be incomplete or inaccurate.
                </p>
              )}
            </div>

            {/* Audio Source */}
            <div className="bg-slate-900 border border-slate-800 rounded-xl p-4">
              <h2 className="text-sm font-medium text-slate-300 mb-3">Audio Source</h2>
              
              {/* File Upload */}
              <div
                onDragOver={handleDragOver}
                onDragLeave={handleDragLeave}
                onDrop={handleDrop}
                className={`border-2 border-dashed rounded-lg p-4 text-center transition-all cursor-pointer
                  ${dragOver ? 'border-blue-500 bg-blue-500/10' : 'border-slate-700 hover:border-slate-500'}`}
                onClick={() => fileInputRef.current?.click()}
                role="button"
                tabIndex={0}
                aria-label="Upload audio file"
                onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') fileInputRef.current?.click(); }}
              >
                <input
                  ref={fileInputRef}
                  type="file"
                  accept="audio/*,video/*"
                  className="hidden"
                  onChange={(e) => handleFileSelect(e.target.files)}
                />
                <svg className="w-8 h-8 mx-auto text-slate-500 mb-2" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M3 16.5v2.25A2.25 2.25 0 005.25 21h13.5A2.25 2.25 0 0021 18.75V16.5m-13.5-9L12 3m0 0l4.5 4.5M12 3v13.5" />
                </svg>
                <p className="text-sm text-slate-400">Drop audio/video file or click to browse</p>
                <p className="text-xs text-slate-600 mt-1">WAV, MP3, OGG, FLAC, M4A, WebM, MP4</p>
              </div>

              {/* Recording & Capture Buttons */}
              <div className="flex gap-2 mt-3">
                <button
                  onClick={isRecording ? stopRecording : startRecording}
                  className={`flex-1 flex items-center justify-center gap-2 px-3 py-2.5 rounded-lg text-sm font-medium transition-all
                    ${isRecording
                      ? 'bg-red-600 text-white animate-pulse'
                      : 'bg-slate-800 text-slate-300 hover:bg-slate-700'
                    }`}
                  disabled={isCapturing}
                >
                  <span className={`w-2.5 h-2.5 rounded-full ${isRecording ? 'bg-white' : 'bg-red-500'}`} />
                  {isRecording ? `Stop (${formatDuration(recordingDuration)})` : 'Record'}
                </button>
                
                <button
                  onClick={isCapturing ? stopCapture : startCapture}
                  className={`flex-1 flex items-center justify-center gap-2 px-3 py-2.5 rounded-lg text-sm font-medium transition-all
                    ${isCapturing
                      ? 'bg-violet-600 text-white'
                      : 'bg-slate-800 text-slate-300 hover:bg-slate-700'
                    }`}
                  disabled={isRecording}
                  title="Capture browser tab audio"
                >
                  <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M9 17.25v1.007a3 3 0 01-.879 2.122L7.5 21h9l-.621-.621A3 3 0 0115 18.257V17.25m6-12V15a2.25 2.25 0 01-2.25 2.25H5.25A2.25 2.25 0 013 15V5.25m18 0A2.25 2.25 0 0018.75 3H5.25A2.25 2.25 0 003 5.25m18 0V12a2.25 2.25 0 01-2.25 2.25H5.25A2.25 2.25 0 013 12V5.25" />
                  </svg>
                  {isCapturing ? 'Stop Capture' : 'Tab Audio'}
                </button>
              </div>
            </div>

            {/* Audio Player */}
            {audioSource && (
              <div className="bg-slate-900 border border-slate-800 rounded-xl p-4">
                <div className="flex items-center justify-between mb-3">
                  <div>
                    <h3 className="text-sm font-medium text-slate-200 truncate max-w-[200px]">{audioSource.name}</h3>
                    <p className="text-xs text-slate-500">
                      {audioSource.type === 'file' && audioSource.file
                        ? `${(audioSource.file.size / (1024 * 1024)).toFixed(1)} MB`
                        : audioSource.type}
                    </p>
                  </div>
                  <button
                    onClick={clearSession}
                    className="p-1.5 rounded-lg hover:bg-slate-800 text-slate-500 hover:text-slate-300 transition-colors"
                    title="Remove audio"
                    aria-label="Remove audio"
                  >
                    <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                      <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
                    </svg>
                  </button>
                </div>
                
                {audioSource.objectUrl && (
                  <audio
                    ref={audioRef}
                    src={audioSource.objectUrl}
                    controls
                    className="w-full h-10 rounded-lg"
                    style={{ filter: 'invert(0.85) hue-rotate(180deg)' }}
                  />
                )}
              </div>
            )}

            {/* Process Button */}
            <div className="flex gap-2">
              <button
                onClick={startProcessing}
                disabled={!audioSource?.file || !!isProcessing}
                className={`flex-1 py-3 rounded-xl text-sm font-semibold transition-all
                  ${!audioSource?.file || isProcessing
                    ? 'bg-slate-800 text-slate-600 cursor-not-allowed'
                    : 'bg-blue-600 text-white hover:bg-blue-500 shadow-lg shadow-blue-600/20'
                  }`}
              >
                {isProcessing ? 'Processing...' : 
                  settings.processingMode === 'sound_classification' ? 'Classify Sounds' :
                  settings.processingMode === 'song' ? 'Transcribe Song' :
                  'Transcribe'}
              </button>
              
              {isProcessing && (
                <button
                  onClick={cancelProcessing}
                  className="px-4 py-3 rounded-xl text-sm font-medium bg-slate-800 text-slate-300 hover:bg-red-900/50 hover:text-red-300 transition-all"
                >
                  Cancel
                </button>
              )}
            </div>

            {/* Progress */}
            {job && (
              <div className="bg-slate-900 border border-slate-800 rounded-xl p-4">
                <div className="flex items-center justify-between mb-2">
                  <span className={`text-xs font-medium ${getStatusColor(job.status)}`}>
                    {job.progressMessage}
                  </span>
                  <span className="text-xs text-slate-500">{Math.round(job.progress)}%</span>
                </div>
                <div className="w-full h-1.5 bg-slate-800 rounded-full overflow-hidden">
                  <div
                    className={`h-full rounded-full transition-all duration-300 ${
                      job.status === 'failed' ? 'bg-red-500' :
                      job.status === 'completed' ? 'bg-emerald-500' :
                      job.status === 'cancelled' ? 'bg-amber-500' :
                      'bg-blue-500'
                    }`}
                    style={{ width: `${job.progress}%` }}
                  />
                </div>
                {job.error && (
                  <p className="text-xs text-red-400 mt-2">{job.error}</p>
                )}
              </div>
            )}
          </div>

          {/* Right Panel - Results */}
          <div className="lg:col-span-7 space-y-4">
            
            {/* Results Header */}
            <div className="flex items-center justify-between">
              <h2 className="text-sm font-medium text-slate-300">
                {settings.processingMode === 'sound_classification' ? 'Sound Events' : 'Transcript'}
                {segments.length > 0 && (
                  <span className="text-slate-500 ml-2">({segments.length} segments)</span>
                )}
              </h2>
              
              {segments.length > 0 && (
                <div className="flex gap-1">
                  {(['txt', 'srt', 'vtt', 'json'] as const).map(fmt => (
                    <button
                      key={fmt}
                      onClick={() => handleExport(fmt)}
                      className="px-2.5 py-1 text-xs font-medium rounded-md bg-slate-800 text-slate-400 hover:bg-slate-700 hover:text-slate-200 transition-colors"
                      title={`Export as ${fmt.toUpperCase()}`}
                    >
                      {fmt.toUpperCase()}
                    </button>
                  ))}
                </div>
              )}
            </div>

            {/* Transcript Segments */}
            {segments.length > 0 ? (
              <div className="bg-slate-900 border border-slate-800 rounded-xl overflow-hidden">
                <div className="max-h-[60vh] overflow-y-auto">
                  {segments.map((segment, index) => (
                    <div
                      key={segment.id}
                      className={`group border-b border-slate-800/50 last:border-0 hover:bg-slate-800/30 transition-colors`}
                    >
                      <div className="flex items-start gap-3 p-3">
                        {/* Timestamp */}
                        {settings.enableTimestamps && segment.endTime > 0 && (
                          <button
                            className="text-xs text-blue-400/70 font-mono whitespace-nowrap pt-0.5 hover:text-blue-300 transition-colors min-w-[70px]"
                            onClick={() => {
                              if (audioRef.current && segment.startTime !== undefined) {
                                audioRef.current.currentTime = segment.startTime;
                                audioRef.current.play();
                              }
                            }}
                            title="Jump to this time"
                          >
                            {formatDuration(segment.startTime)}
                          </button>
                        )}
                        
                        {/* Text */}
                        {editingSegmentId === segment.id ? (
                          <textarea
                            autoFocus
                            value={segment.text}
                            onChange={(e) => updateSegmentText(segment.id, e.target.value)}
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
                            {segment.text || <span className="text-slate-600 italic">[empty segment]</span>}
                          </p>
                        )}
                        
                        {/* Segment number */}
                        <span className="text-xs text-slate-700 font-mono">
                          {index + 1}
                        </span>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            ) : soundEvents.length > 0 ? (
              /* Sound Classification Results */
              <div className="bg-slate-900 border border-slate-800 rounded-xl p-4">
                <div className="space-y-2">
                  {soundEvents.map((event, i) => (
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
              /* Empty State */
              <div className="bg-slate-900/50 border border-slate-800/50 rounded-xl p-12 text-center">
                <div className="w-16 h-16 mx-auto mb-4 rounded-2xl bg-slate-800/50 flex items-center justify-center">
                  <svg className="w-8 h-8 text-slate-600" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M19 11a7 7 0 01-7 7m0 0a7 7 0 01-7-7m7 7v4m0 0H8m4 0h4m-4-8a3 3 0 01-3-3V5a3 3 0 116 0v6a3 3 0 01-3 3z" />
                  </svg>
                </div>
                <h3 className="text-sm font-medium text-slate-400 mb-1">No transcript yet</h3>
                <p className="text-xs text-slate-600 max-w-sm mx-auto">
                  {settings.processingMode === 'sound_classification'
                    ? 'Load an audio file and click "Classify Sounds" to identify environmental sounds.'
                    : 'Load an audio file or record audio, then click "Transcribe" to begin.'
                  }
                </p>
                <div className="mt-4 text-xs text-slate-700">
                  <p>Model: {WHISPER_MODELS[settings.modelId as keyof typeof WHISPER_MODELS]?.name || settings.modelId}</p>
                  <p className="mt-1">All processing runs locally in your browser. No data is sent to external servers.</p>
                </div>
              </div>
            )}
          </div>
        </div>
      </main>

      {/* Settings Panel */}
      {showSettings && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm" onClick={() => setShowSettings(false)}>
          <div
            className="bg-slate-900 border border-slate-700 rounded-2xl w-full max-w-lg max-h-[80vh] overflow-y-auto shadow-2xl"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="p-6 space-y-6">
              <div className="flex items-center justify-between">
                <h2 className="text-lg font-semibold text-slate-100">Settings</h2>
                <button
                  onClick={() => setShowSettings(false)}
                  className="p-2 rounded-lg hover:bg-slate-800 text-slate-400"
                  aria-label="Close settings"
                >
                  <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
                  </svg>
                </button>
              </div>

              {/* Model Selection */}
              <div>
                <label className="block text-sm font-medium text-slate-300 mb-2">Speech Recognition Model</label>
                <select
                  value={settings.modelId}
                  onChange={(e) => setSettings(s => ({ ...s, modelId: e.target.value }))}
                  className="w-full bg-slate-800 border border-slate-700 rounded-lg px-3 py-2 text-sm text-slate-200 focus:outline-none focus:ring-1 focus:ring-blue-500"
                >
                  {Object.entries(WHISPER_MODELS).map(([id, info]) => (
                    <option key={id} value={id}>{info.name} ({info.size})</option>
                  ))}
                </select>
                <p className="text-xs text-slate-500 mt-1">
                  Smaller models download faster and use less memory but may be less accurate.
                </p>
              </div>

              {/* Source Language */}
              <div>
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

              {/* Translation */}
              <div>
                <label className="block text-sm font-medium text-slate-300 mb-2">Translation</label>
                <div className="flex items-center gap-3 mb-2">
                  <label className="flex items-center gap-2 text-sm text-slate-400 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={settings.enableTranslation}
                      onChange={(e) => setSettings(s => ({ ...s, enableTranslation: e.target.checked }))}
                      className="rounded border-slate-600 bg-slate-800 text-blue-500 focus:ring-blue-500"
                    />
                    Translate to English (Whisper built-in)
                  </label>
                </div>
                <p className="text-xs text-slate-500">
                  Whisper can translate speech directly to English. For other target languages, a separate translation model is needed (not yet implemented).
                </p>
              </div>

              {/* Processing Options */}
              <div>
                <label className="block text-sm font-medium text-slate-300 mb-2">Processing Options</label>
                <div className="space-y-2">
                  <label className="flex items-center gap-2 text-sm text-slate-400 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={settings.enableTimestamps}
                      onChange={(e) => setSettings(s => ({ ...s, enableTimestamps: e.target.checked }))}
                      className="rounded border-slate-600 bg-slate-800 text-blue-500 focus:ring-blue-500"
                    />
                    Include timestamps
                  </label>
                  <label className="flex items-center gap-2 text-sm text-slate-400 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={settings.enableWebGPU}
                      onChange={(e) => setSettings(s => ({ ...s, enableWebGPU: e.target.checked }))}
                      className="rounded border-slate-600 bg-slate-800 text-blue-500 focus:ring-blue-500"
                    />
                    Use WebGPU (requires compatible browser/GPU)
                  </label>
                </div>
              </div>

              {/* Chunk Duration */}
              <div>
                <label className="block text-sm font-medium text-slate-300 mb-2">
                  Chunk Duration: {settings.chunkDuration}s
                </label>
                <input
                  type="range"
                  min="10"
                  max="60"
                  step="5"
                  value={settings.chunkDuration}
                  onChange={(e) => setSettings(s => ({ ...s, chunkDuration: parseInt(e.target.value) }))}
                  className="w-full accent-blue-500"
                />
                <p className="text-xs text-slate-500 mt-1">
                  Longer chunks may improve accuracy but use more memory.
                </p>
              </div>

              {/* Privacy */}
              <div className="border-t border-slate-800 pt-4">
                <h3 className="text-sm font-medium text-slate-300 mb-2">Privacy & Security</h3>
                <div className="space-y-1 text-xs text-slate-500">
                  <p>• All audio processing runs locally in your browser</p>
                  <p>• No audio or transcripts are sent to external servers</p>
                  <p>• Models are downloaded once from Hugging Face and cached</p>
                  <p>• No user accounts, telemetry, or analytics</p>
                  <p>• API keys (if configured) are stored in memory only</p>
                </div>
              </div>

              {/* Clear Session */}
              <div className="border-t border-slate-800 pt-4">
                <button
                  onClick={() => { clearSession(); setShowSettings(false); }}
                  className="w-full py-2 rounded-lg bg-slate-800 text-slate-300 text-sm font-medium hover:bg-red-900/30 hover:text-red-300 transition-colors"
                >
                  Clear Session & Release Resources
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Footer */}
      <footer className="border-t border-slate-800/50 py-3 px-4">
        <div className="max-w-7xl mx-auto flex items-center justify-between text-xs text-slate-600">
          <span>AudioScribe — Local-first, privacy-conscious audio transcription</span>
          <span>
            {settings.enableWebGPU ? 'WebGPU' : 'WASM'} • {WHISPER_MODELS[settings.modelId as keyof typeof WHISPER_MODELS]?.name || 'Model'}
          </span>
        </div>
      </footer>
    </div>
  );
}

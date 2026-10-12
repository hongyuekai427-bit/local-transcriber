// Live transcription session - streaming pipeline for real-time transcription
// Implements rolling-window chunk-based live transcription using Whisper's batch inference

import type { TranscriptSegment, LiveSessionState, ProcessingMode } from '../types';
import { transcriptStore } from './transcriptStore';
import { generateId } from './audioProcessor';

interface LiveSessionConfig {
  sessionId: string;
  modelId: string;
  language: string;
  mode: ProcessingMode;
  enableWebGPU: boolean;
  chunkDuration: number; // seconds of audio per chunk
  overlapDuration: number; // seconds of overlap for dedup
  maxBufferedChunks: number;
  enableTranslation: boolean;
  targetLanguage: string;
}

export class LiveTranscriptionSession {
  private config: LiveSessionConfig;
  private worker: Worker;
  private audioContext: AudioContext | null = null;
  private mediaStream: MediaStream | null = null;
  private scriptProcessor: ScriptProcessorNode | null = null;
  private sourceNode: MediaStreamAudioSourceNode | null = null;
  
  // Audio buffer management
  private audioBuffer: Float32Array = new Float32Array(0);
  private sampleRate: number = 16000;
  private totalSamplesProcessed: number = 0;
  private sessionStartTime: number = 0;
  
  // Chunk processing state
  private chunkQueue: Float32Array[] = [];
  private isProcessingChunk: boolean = false;
  private chunkIndex: number = 0;
  private sessionVersion: number = 0; // prevents stale results
  
  // Session state
  private state: LiveSessionState = 'idle';
  private isPaused: boolean = false;
  private isCancelled: boolean = false;
  
  // Overlap/dedup tracking
  private lastFinalizedText: string = '';
  private lastFinalizedEndTime: number = 0;
  
  // Backpressure
  private droppedChunks: number = 0;
  private maxQueueSize: number;

  constructor(config: LiveSessionConfig) {
    this.config = config;
    this.maxQueueSize = config.maxBufferedChunks;
    
    // Create worker
    this.worker = new Worker(
      new URL('../workers/transcription.worker.ts', import.meta.url),
      { type: 'module' }
    );
    
    this.worker.onmessage = (event) => this.handleWorkerMessage(event);
    this.worker.onerror = (error) => {
      console.error('Live worker error:', error);
      this.handleError(`Worker error: ${error.message}`);
    };
  }

  async start(sourceType: 'microphone' | 'display_capture'): Promise<void> {
    if (this.state !== 'idle' && this.state !== 'error') {
      throw new Error(`Cannot start session in state: ${this.state}`);
    }
    
    this.isCancelled = false;
    this.sessionVersion++;
    transcriptStore.setLiveState(this.config.sessionId, 'requesting_permission');
    
    try {
      // Request media stream
      let stream: MediaStream;
      
      if (sourceType === 'microphone') {
        stream = await navigator.mediaDevices.getUserMedia({
          audio: {
            channelCount: 1,
            sampleRate: { ideal: 16000 },
            echoCancellation: true,
            noiseSuppression: true,
          }
        });
      } else {
        // Display capture
        stream = await navigator.mediaDevices.getDisplayMedia({
          video: true,
          audio: true,
        } as any);
        
        const audioTracks = stream.getAudioTracks();
        if (audioTracks.length === 0) {
          stream.getTracks().forEach(t => t.stop());
          throw new Error('No audio track available. Select "Share tab audio" or "Share system audio" when prompted.');
        }
        
        // Stop video tracks - we only need audio
        stream.getVideoTracks().forEach(t => t.stop());
        stream = new MediaStream(audioTracks);
      }
      
      this.mediaStream = stream;
      
      // Verify audio track
      const audioTracks = stream.getAudioTracks();
      if (audioTracks.length === 0) {
        throw new Error('No audio track found in the media stream');
      }
      
      // Handle track ending (user stops sharing externally)
      audioTracks[0].onended = () => {
        if (this.state === 'capturing') {
          this.stop();
        }
      };
      
      // Set up audio processing pipeline
      this.audioContext = new AudioContext({ sampleRate: 16000 });
      this.sampleRate = this.audioContext.sampleRate;
      this.sourceNode = this.audioContext.createMediaStreamSource(stream);
      
      // Use ScriptProcessorNode for live audio capture
      // AudioWorklet would be better but requires a separate file and has more complexity
      const bufferSize = 4096;
      this.scriptProcessor = this.audioContext.createScriptProcessor(bufferSize, 1, 1);
      
      this.scriptProcessor.onaudioprocess = (event) => {
        if (this.isPaused || this.isCancelled) return;
        
        const inputData = event.inputBuffer.getChannelData(0);
        this.accumulateAudio(inputData);
      };
      
      this.sourceNode.connect(this.scriptProcessor);
      this.scriptProcessor.connect(this.audioContext.destination);
      
      this.sessionStartTime = Date.now();
      this.state = 'capturing';
      transcriptStore.setLiveState(this.config.sessionId, 'capturing');
      transcriptStore.updateSession(this.config.sessionId, {
        status: 'processing',
        language: this.config.language === 'auto' ? 'detecting...' : this.config.language,
      });
      
      // Initialize model in worker
      this.worker.postMessage({
        type: 'init_model',
        payload: {
          modelId: this.config.modelId,
          useWebGPU: this.config.enableWebGPU,
        }
      });
      
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.state = 'error';
      transcriptStore.setLiveState(this.config.sessionId, 'error');
      transcriptStore.updateSession(this.config.sessionId, { status: 'failed' });
      throw err;
    }
  }

  private accumulateAudio(inputData: Float32Array) {
    // Append to buffer
    const newBuffer = new Float32Array(this.audioBuffer.length + inputData.length);
    newBuffer.set(this.audioBuffer);
    newBuffer.set(inputData, this.audioBuffer.length);
    this.audioBuffer = newBuffer;
    
    // Check if we have enough for a chunk
    const chunkSamples = this.config.chunkDuration * this.sampleRate;
    
    while (this.audioBuffer.length >= chunkSamples) {
      // Extract chunk with overlap
      const overlapSamples = this.config.overlapDuration * this.sampleRate;
      const extractLength = chunkSamples + overlapSamples;
      const actualExtract = Math.min(extractLength, this.audioBuffer.length);
      
      const chunk = this.audioBuffer.slice(0, actualExtract);
      
      // Keep overlap in buffer for next chunk
      const keepSamples = Math.min(overlapSamples, this.audioBuffer.length - chunkSamples);
      if (keepSamples > 0) {
        this.audioBuffer = this.audioBuffer.slice(chunkSamples - keepSamples);
      } else {
        this.audioBuffer = this.audioBuffer.slice(chunkSamples);
      }
      
      // Queue the chunk
      if (this.chunkQueue.length >= this.maxQueueSize) {
        // Backpressure: queue full
        this.droppedChunks++;
        transcriptStore.setBacklog(this.config.sessionId, this.chunkQueue.length, this.droppedChunks);
        // Don't silently discard - wait for queue to drain
        // But if it keeps growing, we need to skip
        if (this.chunkQueue.length >= this.maxQueueSize * 2) {
          // Force drop oldest
          this.chunkQueue.shift();
          this.droppedChunks++;
        }
      }
      
      this.chunkQueue.push(chunk);
      this.processNextChunk();
    }
    
    // Update backlog display
    if (this.chunkQueue.length > 0) {
      transcriptStore.setBacklog(this.config.sessionId, this.chunkQueue.length, this.droppedChunks);
    }
  }

  private async processNextChunk() {
    if (this.isProcessingChunk || this.chunkQueue.length === 0 || this.isCancelled) {
      return;
    }
    
    this.isProcessingChunk = true;
    const chunk = this.chunkQueue.shift()!;
    const currentChunkIndex = this.chunkIndex++;
    const currentVersion = this.sessionVersion;
    const chunkStartTime = this.totalSamplesProcessed / this.sampleRate;
    
    // Update partial segment to show processing
    transcriptStore.setPartialSegment(this.config.sessionId, {
      id: `partial-${currentChunkIndex}`,
      text: '⟳ Processing...',
      startTime: chunkStartTime,
      endTime: chunkStartTime + this.config.chunkDuration,
      isPartial: true,
    });
    
    // Send to worker
    this.worker.postMessage({
      type: 'transcribe_chunk',
      payload: {
        audio: chunk,
        samplingRate: this.sampleRate,
        chunkIndex: currentChunkIndex,
        chunkStartTime,
        language: this.config.language === 'auto' ? undefined : this.config.language,
        mode: this.config.mode,
        modelId: this.config.modelId,
        useWebGPU: this.config.enableWebGPU,
        version: currentVersion,
      }
    });
    
    // Note: isProcessingChunk will be reset when result comes back
    // If another chunk is queued, it will be processed after this one completes
  }

  private handleWorkerMessage(event: MessageEvent) {
    const { type, payload } = event.data;
    
    if (this.isCancelled) return;
    
    switch (type) {
      case 'chunk_result':
        this.handleChunkResult(payload);
        break;
      case 'model_progress':
        this.handleModelProgress(payload);
        break;
      case 'model_ready':
        this.handleModelReady();
        break;
      case 'error':
        this.handleError(payload.error);
        break;
    }
  }

  private handleChunkResult(payload: {
    chunkIndex: number;
    segments: Array<{ text: string; startTime: number; endTime: number }>;
    language?: string;
    version: number;
  }) {
    // Prevent stale results
    if (payload.version !== this.sessionVersion) return;
    
    this.isProcessingChunk = false;
    this.totalSamplesProcessed += this.config.chunkDuration * this.sampleRate;
    
    // Update language if detected
    if (payload.language && payload.language !== 'unknown') {
      transcriptStore.updateSession(this.config.sessionId, {
        language: payload.language,
        detectedLanguage: payload.language,
      });
    }
    
    // Process segments with deduplication against overlap
    const finalizedSegments: TranscriptSegment[] = [];
    
    for (const seg of payload.segments) {
      const text = seg.text?.trim();
      if (!text) continue;
      
      // Deduplication: check if this text overlaps with last finalized text
      if (this.lastFinalizedText && this.isDuplicate(text, seg.startTime)) {
        continue;
      }
      
      // Adjust timestamps to be session-relative
      const absoluteStart = seg.startTime;
      const absoluteEnd = seg.endTime > 0 ? seg.endTime : absoluteStart + 3;
      
      const segment: TranscriptSegment = {
        id: `live-${this.config.sessionId}-${payload.chunkIndex}-${finalizedSegments.length}`,
        text,
        startTime: absoluteStart,
        endTime: absoluteEnd,
        language: payload.language,
        isUncertain: this.config.mode === 'song',
      };
      
      finalizedSegments.push(segment);
      this.lastFinalizedText = text;
      this.lastFinalizedEndTime = absoluteEnd;
    }
    
    // Add finalized segments
    if (finalizedSegments.length > 0) {
      transcriptStore.addSegments(this.config.sessionId, finalizedSegments);
    }
    
    // Clear partial segment
    transcriptStore.setPartialSegment(this.config.sessionId, null);
    
    // Update backlog
    transcriptStore.setBacklog(this.config.sessionId, this.chunkQueue.length, this.droppedChunks);
    
    // Process next chunk if available
    this.processNextChunk();
  }

  private isDuplicate(newText: string, newStartTime: number): boolean {
    if (!this.lastFinalizedText) return false;
    
    // If the new segment starts before our last finalized end time,
    // it might be from the overlap region
    if (newStartTime < this.lastFinalizedEndTime) {
      // Check if the text is substantially the same as the end of last finalized
      const lastWords = this.lastFinalizedText.split(/\s+/).slice(-5).join(' ');
      const newWords = newText.split(/\s+/).slice(0, 5).join(' ');
      
      // Simple overlap check: if significant portion matches
      if (lastWords.length > 0 && newWords.length > 0) {
        const overlap = this.computeOverlap(lastWords.toLowerCase(), newWords.toLowerCase());
        if (overlap > 0.6) {
          return true;
        }
      }
    }
    
    return false;
  }

  private computeOverlap(a: string, b: string): number {
    const wordsA = a.split(/\s+/);
    const wordsB = b.split(/\s+/);
    
    let matches = 0;
    for (const word of wordsB) {
      if (wordsA.includes(word)) matches++;
    }
    
    return wordsB.length > 0 ? matches / wordsB.length : 0;
  }

  private handleModelProgress(payload: { progress: number; message: string }) {
    transcriptStore.updateSession(this.config.sessionId, {
      status: 'downloading_model' as any,
    });
  }

  private handleModelReady() {
    transcriptStore.updateSession(this.config.sessionId, {
      modelId: this.config.modelId,
    });
  }

  private handleError(error: string) {
    this.isProcessingChunk = false;
    transcriptStore.updateSession(this.config.sessionId, {
      status: 'failed',
    });
    transcriptStore.setPartialSegment(this.config.sessionId, {
      id: 'error-partial',
      text: `⚠ Error: ${error}`,
      startTime: 0,
      endTime: 0,
      isPartial: true,
    });
  }

  pause() {
    if (this.state !== 'capturing') return;
    this.isPaused = true;
    this.state = 'paused';
    transcriptStore.setLiveState(this.config.sessionId, 'paused');
  }

  resume() {
    if (this.state !== 'paused') return;
    this.isPaused = false;
    this.state = 'capturing';
    transcriptStore.setLiveState(this.config.sessionId, 'capturing');
  }

  stop() {
    if (this.state === 'ended' || this.state === 'idle') return;
    
    this.state = 'processing_stopped';
    transcriptStore.setLiveState(this.config.sessionId, 'processing_stopped');
    
    // Finalize any partial segment
    transcriptStore.finalizePartialSegment(this.config.sessionId);
    
    // Process remaining buffered audio
    if (this.audioBuffer.length > this.sampleRate) { // At least 1 second
      const finalChunk = this.audioBuffer;
      this.audioBuffer = new Float32Array(0);
      this.chunkQueue.push(finalChunk);
      this.processNextChunk();
    }
    
    // Wait for processing to finish, then clean up
    const waitForCompletion = () => {
      if (this.isProcessingChunk || this.chunkQueue.length > 0) {
        setTimeout(waitForCompletion, 500);
      } else {
        this.cleanup();
        this.state = 'ended';
        transcriptStore.setLiveState(this.config.sessionId, 'ended');
        transcriptStore.setSessionStatus(this.config.sessionId, 'completed');
      }
    };
    
    waitForCompletion();
  }

  cancel() {
    this.isCancelled = true;
    this.isPaused = false;
    this.state = 'ended';
    
    // Clear partial
    transcriptStore.setPartialSegment(this.config.sessionId, null);
    transcriptStore.setLiveState(this.config.sessionId, 'ended');
    transcriptStore.setSessionStatus(this.config.sessionId, 'cancelled');
    
    this.cleanup();
  }

  private cleanup() {
    // Stop media stream
    if (this.mediaStream) {
      this.mediaStream.getTracks().forEach(t => t.stop());
      this.mediaStream = null;
    }
    
    // Disconnect audio nodes
    if (this.scriptProcessor) {
      this.scriptProcessor.disconnect();
      this.scriptProcessor = null;
    }
    if (this.sourceNode) {
      this.sourceNode.disconnect();
      this.sourceNode = null;
    }
    if (this.audioContext) {
      this.audioContext.close().catch(() => {});
      this.audioContext = null;
    }
    
    // Clear buffers
    this.audioBuffer = new Float32Array(0);
    this.chunkQueue = [];
    
    // Terminate worker
    this.worker.terminate();
  }

  getState(): LiveSessionState {
    return this.state;
  }

  getBacklog(): { queue: number; dropped: number } {
    return { queue: this.chunkQueue.length, dropped: this.droppedChunks };
  }
}

// File queue manager - handles multiple file transcription with controlled concurrency
import type { FileQueueItem, JobStatus, ProcessingMode } from '../types';
import { transcriptStore } from './transcriptStore';
import { decodeAudioFile, prepareForWhisper, isSupportedAudioFile, generateId } from './audioProcessor';

export type QueueListener = () => void;

interface FileProcessorConfig {
  modelId: string;
  language: string;
  mode: ProcessingMode;
  enableWebGPU: boolean;
  chunkDuration: number;
  enableTranslation: boolean;
  targetLanguage: string;
  maxConcurrent: number;
}

export class FileQueueManager {
  private queue: Map<string, FileQueueItem> = new Map();
  private processingIds: Set<string> = new Set();
  private worker: Worker | null = null;
  private config: FileProcessorConfig;
  private listeners: Set<QueueListener> = new Set();
  private isCancelled: Map<string, boolean> = new Map();

  constructor(config: FileProcessorConfig) {
    this.config = config;
  }

  updateConfig(config: Partial<FileProcessorConfig>) {
    Object.assign(this.config, config);
  }

  subscribe(listener: QueueListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private notify() {
    this.listeners.forEach(l => l());
  }

  getQueue(): FileQueueItem[] {
    return Array.from(this.queue.values()).sort(
      (a, b) => a.addedAt.getTime() - b.addedAt.getTime()
    );
  }

  getItem(id: string): FileQueueItem | undefined {
    return this.queue.get(id);
  }

  addFiles(files: File[]): string[] {
    const ids: string[] = [];
    
    for (const file of files) {
      if (!isSupportedAudioFile(file)) continue;
      if (file.size === 0) continue;
      
      const id = generateId();
      const item: FileQueueItem = {
        id,
        file,
        name: file.name,
        size: file.size,
        status: 'idle',
        progress: 0,
        progressMessage: 'Queued',
        addedAt: new Date(),
      };
      
      this.queue.set(id, item);
      ids.push(id);
    }
    
    this.notify();
    this.processQueue();
    return ids;
  }

  removeItem(id: string) {
    this.cancelItem(id);
    this.queue.delete(id);
    this.notify();
  }

  cancelItem(id: string) {
    this.isCancelled.set(id, true);
    const item = this.queue.get(id);
    if (item) {
      item.status = 'cancelled';
      item.progressMessage = 'Cancelled';
    }
    this.processingIds.delete(id);
    this.notify();
  }

  retryItem(id: string) {
    const item = this.queue.get(id);
    if (!item) return;
    
    item.status = 'idle';
    item.progress = 0;
    item.progressMessage = 'Queued';
    item.error = undefined;
    this.isCancelled.set(id, false);
    this.notify();
    this.processQueue();
  }

  clearCompleted() {
    for (const [id, item] of this.queue) {
      if (item.status === 'completed' || item.status === 'cancelled' || item.status === 'failed') {
        this.queue.delete(id);
      }
    }
    this.notify();
  }

  private async processQueue() {
    while (this.processingIds.size < this.config.maxConcurrent) {
      const nextItem = this.getNextQueuedItem();
      if (!nextItem) break;
      
      this.processingIds.add(nextItem.id);
      this.processFile(nextItem).catch(err => {
        console.error('File processing error:', err);
      });
    }
  }

  private getNextQueuedItem(): FileQueueItem | null {
    for (const item of this.queue.values()) {
      if (item.status === 'idle' && !this.processingIds.has(item.id)) {
        return item;
      }
    }
    return null;
  }

  private async processFile(item: FileQueueItem) {
    const sessionId = generateId();
    item.transcriptSessionId = sessionId;
    item.status = 'decoding';
    item.progressMessage = 'Decoding audio...';
    this.notify();
    
    try {
      // Create transcript session
      const session = transcriptStore.createFileSession(
        item.name,
        item.size,
        this.config.mode
      );
      
      // Decode audio
      const decoded = await decodeAudioFile(item.file);
      
      if (this.isCancelled.get(item.id)) {
        this.finishItem(item);
        return;
      }
      
      // Prepare for model
      item.status = 'processing';
      item.progressMessage = 'Preparing audio...';
      item.progress = 20;
      this.notify();
      
      const audioData = prepareForWhisper(decoded);
      
      // Create worker for this file
      const worker = new Worker(
        new URL('../workers/transcription.worker.ts', import.meta.url),
        { type: 'module' }
      );
      
      let resultReceived = false;
      
      const result = await new Promise<any>((resolve, reject) => {
        const timeout = setTimeout(() => {
          worker.terminate();
          reject(new Error('Processing timeout'));
        }, 10 * 60 * 1000); // 10 minute timeout
        
        worker.onmessage = (event) => {
          const { type, payload } = event.data;
          
          if (this.isCancelled.get(item.id)) {
            clearTimeout(timeout);
            worker.terminate();
            resolve({ cancelled: true });
            return;
          }
          
          if (type === 'progress') {
            item.progress = 20 + (payload.progress * 0.7);
            item.progressMessage = payload.message;
            this.notify();
          } else if (type === 'result') {
            resultReceived = true;
            clearTimeout(timeout);
            resolve(payload);
          } else if (type === 'error') {
            clearTimeout(timeout);
            reject(new Error(payload.error));
          }
        };
        
        worker.onerror = (err) => {
          clearTimeout(timeout);
          reject(new Error(`Worker error: ${err.message}`));
        };
        
        if (this.config.mode === 'sound_classification') {
          worker.postMessage({
            type: 'classify',
            payload: {
              audio: audioData,
              samplingRate: 16000,
              model: 'Xenova/ast-finetuned-audioset-10-10-0.4593',
              topK: 10,
            }
          });
        } else {
          const task = this.config.enableTranslation && this.config.targetLanguage === 'en'
            ? 'translate' : 'transcribe';
          
          worker.postMessage({
            type: 'transcribe',
            payload: {
              audio: audioData,
              samplingRate: 16000,
              model: this.config.modelId,
              language: this.config.language === 'auto' ? undefined : this.config.language,
              task,
              chunkLength: this.config.chunkDuration,
              returnTimestamps: true,
            }
          });
        }
      });
      
      worker.terminate();
      
      if (this.isCancelled.get(item.id) || result?.cancelled) {
        item.status = 'cancelled';
        item.progressMessage = 'Cancelled';
        transcriptStore.setSessionStatus(session.id, 'cancelled');
        this.finishItem(item);
        return;
      }
      
      // Process results
      if (result.type === 'transcription') {
        const segments = (result.segments || []).map((s: any, i: number) => ({
          id: `${session.id}-seg-${i}`,
          text: s.text || '',
          startTime: s.startTime || 0,
          endTime: s.endTime || 0,
          language: s.language || result.language,
          isUncertain: this.config.mode === 'song',
        }));
        
        transcriptStore.addSegments(session.id, segments);
        transcriptStore.updateSession(session.id, {
          language: result.language || this.config.language,
          detectedLanguage: result.language,
          duration: decoded.duration,
        });
      } else if (result.type === 'classification') {
        transcriptStore.setSoundEvents(session.id, result.events || []);
      }
      
      item.status = 'completed';
      item.progress = 100;
      item.progressMessage = 'Complete';
      transcriptStore.setSessionStatus(session.id, 'completed');
      
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      item.status = 'failed';
      item.error = message;
      item.progressMessage = `Error: ${message}`;
      
      if (item.transcriptSessionId) {
        transcriptStore.setSessionStatus(item.transcriptSessionId, 'failed');
      }
    }
    
    this.finishItem(item);
  }

  private finishItem(item: FileQueueItem) {
    this.processingIds.delete(item.id);
    this.notify();
    // Process next in queue
    this.processQueue();
  }

  destroy() {
    for (const id of this.queue.keys()) {
      this.cancelItem(id);
    }
    if (this.worker) {
      this.worker.terminate();
      this.worker = null;
    }
  }
}

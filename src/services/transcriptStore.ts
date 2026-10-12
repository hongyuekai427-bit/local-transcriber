// Shared transcript store - manages all transcript sessions
// Used by both live and file transcription workflows
import type { TranscriptSession, TranscriptSegment, TranslationSegment, SoundEvent, JobStatus, LiveSessionState } from '../types';
import { generateId } from './audioProcessor';

export type StoreListener = () => void;

class TranscriptStore {
  private sessions: Map<string, TranscriptSession> = new Map();
  private activeSessionId: string | null = null;
  private listeners: Set<StoreListener> = new Set();

  subscribe(listener: StoreListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private notify() {
    this.listeners.forEach(l => l());
  }

  getSessions(): TranscriptSession[] {
    return Array.from(this.sessions.values()).sort(
      (a, b) => b.updatedAt.getTime() - a.updatedAt.getTime()
    );
  }

  getSession(id: string): TranscriptSession | undefined {
    return this.sessions.get(id);
  }

  getActiveSession(): TranscriptSession | null {
    if (!this.activeSessionId) return null;
    return this.sessions.get(this.activeSessionId) || null;
  }

  setActiveSession(id: string | null) {
    this.activeSessionId = id;
    this.notify();
  }

  createFileSession(
    fileName: string,
    fileSize: number,
    mode: 'speech' | 'song' | 'sound_classification'
  ): TranscriptSession {
    const session: TranscriptSession = {
      id: generateId(),
      sourceLabel: fileName,
      sourceType: 'file',
      mode,
      segments: [],
      partialSegment: null,
      language: 'unknown',
      translatedSegments: [],
      soundEvents: [],
      status: 'idle',
      createdAt: new Date(),
      updatedAt: new Date(),
      fileName,
      fileSize,
      isLive: false,
    };
    this.sessions.set(session.id, session);
    this.activeSessionId = session.id;
    this.notify();
    return session;
  }

  createLiveSession(
    sourceLabel: string,
    sourceType: 'microphone' | 'display_capture',
    mode: 'speech' | 'song' | 'sound_classification'
  ): TranscriptSession {
    const session: TranscriptSession = {
      id: generateId(),
      sourceLabel,
      sourceType,
      mode,
      segments: [],
      partialSegment: null,
      language: 'unknown',
      translatedSegments: [],
      soundEvents: [],
      status: 'idle',
      createdAt: new Date(),
      updatedAt: new Date(),
      isLive: true,
      liveState: 'idle',
    };
    this.sessions.set(session.id, session);
    this.activeSessionId = session.id;
    this.notify();
    return session;
  }

  updateSession(id: string, updates: Partial<TranscriptSession>) {
    const session = this.sessions.get(id);
    if (!session) return;
    
    Object.assign(session, updates, { updatedAt: new Date() });
    this.notify();
  }

  setSessionStatus(id: string, status: JobStatus | LiveSessionState) {
    const session = this.sessions.get(id);
    if (!session) return;
    session.status = status;
    session.updatedAt = new Date();
    this.notify();
  }

  setLiveState(id: string, liveState: LiveSessionState) {
    const session = this.sessions.get(id);
    if (!session) return;
    session.liveState = liveState;
    session.status = liveState as any;
    session.updatedAt = new Date();
    this.notify();
  }

  addSegments(id: string, segments: TranscriptSegment[]) {
    const session = this.sessions.get(id);
    if (!session) return;
    session.segments.push(...segments);
    session.updatedAt = new Date();
    this.notify();
  }

  updateSegment(id: string, segmentId: string, text: string) {
    const session = this.sessions.get(id);
    if (!session) return;
    const seg = session.segments.find(s => s.id === segmentId);
    if (seg) {
      seg.text = text;
      session.updatedAt = new Date();
      this.notify();
    }
  }

  setPartialSegment(id: string, segment: TranscriptSegment | null) {
    const session = this.sessions.get(id);
    if (!session) return;
    session.partialSegment = segment;
    session.updatedAt = new Date();
    this.notify();
  }

  finalizePartialSegment(id: string) {
    const session = this.sessions.get(id);
    if (!session || !session.partialSegment) return;
    
    const partial = session.partialSegment;
    if (partial.text.trim()) {
      partial.isPartial = false;
      session.segments.push({ ...partial });
    }
    session.partialSegment = null;
    session.updatedAt = new Date();
    this.notify();
  }

  addTranslationSegments(id: string, segments: TranslationSegment[]) {
    const session = this.sessions.get(id);
    if (!session) return;
    session.translatedSegments.push(...segments);
    session.updatedAt = new Date();
    this.notify();
  }

  setSoundEvents(id: string, events: SoundEvent[]) {
    const session = this.sessions.get(id);
    if (!session) return;
    session.soundEvents = events;
    session.updatedAt = new Date();
    this.notify();
  }

  setBacklog(id: string, backlog: number, dropped: number) {
    const session = this.sessions.get(id);
    if (!session) return;
    session.processingBacklog = backlog;
    session.droppedChunks = dropped;
    session.updatedAt = new Date();
    this.notify();
  }

  removeSession(id: string) {
    this.sessions.delete(id);
    if (this.activeSessionId === id) {
      const remaining = this.getSessions();
      this.activeSessionId = remaining.length > 0 ? remaining[0].id : null;
    }
    this.notify();
  }

  clearAll() {
    this.sessions.clear();
    this.activeSessionId = null;
    this.notify();
  }
}

// Singleton store
export const transcriptStore = new TranscriptStore();

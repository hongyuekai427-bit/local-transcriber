// Export service for generating transcript files in various formats
import type { TranscriptSegment, TranslationSegment } from '../types';
import { formatTimestamp } from './audioProcessor';

export interface ExportOptions {
  includeTimestamps: boolean;
  includeTranslation: boolean;
  translatedSegments?: TranslationSegment[];
}

/**
 * Export transcript as plain text
 */
export function exportAsText(
  segments: TranscriptSegment[],
  options: ExportOptions
): string {
  if (options.includeTimestamps) {
    return segments.map(seg => {
      const timeStr = `[${formatTime(seg.startTime)} - ${formatTime(seg.endTime)}]`;
      const translation = options.includeTranslation && options.translatedSegments
        ? options.translatedSegments.find(t => t.originalId === seg.id)
        : null;
      
      let line = `${timeStr} ${seg.text}`;
      if (translation) {
        line += `\n  → ${translation.text}`;
      }
      return line;
    }).join('\n\n');
  }
  
  return segments.map(seg => {
    const translation = options.includeTranslation && options.translatedSegments
      ? options.translatedSegments.find(t => t.originalId === seg.id)
      : null;
    
    let line = seg.text;
    if (translation) {
      line += `\n[${translation.text}]`;
    }
    return line;
  }).join('\n');
}

/**
 * Export transcript as SRT subtitle format
 */
export function exportAsSRT(
  segments: TranscriptSegment[],
  options: ExportOptions
): string {
  const validSegments = segments.filter(s => s.startTime !== undefined && s.endTime !== undefined);
  
  if (validSegments.length === 0) {
    // If no timestamps, create sequential segments
    return segments.map((seg, i) => {
      const translation = options.includeTranslation && options.translatedSegments
        ? options.translatedSegments.find(t => t.originalId === seg.id)
        : null;
      
      let text = seg.text;
      if (translation) {
        text += `\n${translation.text}`;
      }
      
      return `${i + 1}\n00:00:00,000 --> 00:00:00,000\n${text}`;
    }).join('\n\n');
  }
  
  return validSegments.map((seg, i) => {
    const translation = options.includeTranslation && options.translatedSegments
      ? options.translatedSegments.find(t => t.originalId === seg.id)
      : null;
    
    let text = seg.text;
    if (translation) {
      text += `\n${translation.text}`;
    }
    
    return `${i + 1}\n${formatTimestamp(seg.startTime, 'srt')} --> ${formatTimestamp(seg.endTime, 'srt')}\n${text}`;
  }).join('\n\n');
}

/**
 * Export transcript as WebVTT format
 */
export function exportAsVTT(
  segments: TranscriptSegment[],
  options: ExportOptions
): string {
  let vtt = 'WEBVTT\n\n';
  
  const validSegments = segments.filter(s => s.startTime !== undefined && s.endTime !== undefined);
  
  if (validSegments.length === 0) {
    vtt += segments.map((seg, i) => {
      const translation = options.includeTranslation && options.translatedSegments
        ? options.translatedSegments.find(t => t.originalId === seg.id)
        : null;
      
      let text = seg.text;
      if (translation) {
        text += `\n${translation.text}`;
      }
      
      return `${i + 1}\n00:00:00.000 --> 00:00:00.000\n${text}`;
    }).join('\n\n');
  } else {
    vtt += validSegments.map((seg, i) => {
      const translation = options.includeTranslation && options.translatedSegments
        ? options.translatedSegments.find(t => t.originalId === seg.id)
        : null;
      
      let text = seg.text;
      if (translation) {
        text += `\n${translation.text}`;
      }
      
      return `${i + 1}\n${formatTimestamp(seg.startTime, 'vtt')} --> ${formatTimestamp(seg.endTime, 'vtt')}\n${text}`;
    }).join('\n\n');
  }
  
  return vtt;
}

/**
 * Export transcript as JSON
 */
export function exportAsJSON(
  segments: TranscriptSegment[],
  options: ExportOptions,
  metadata?: { language?: string; sourceFile?: string }
): string {
  const data = {
    metadata: {
      generatedAt: new Date().toISOString(),
      language: metadata?.language || 'unknown',
      sourceFile: metadata?.sourceFile || '',
      segmentCount: segments.length,
    },
    segments: segments.map(seg => {
      const translation = options.includeTranslation && options.translatedSegments
        ? options.translatedSegments.find(t => t.originalId === seg.id)
        : null;
      
      return {
        id: seg.id,
        text: seg.text,
        startTime: seg.startTime,
        endTime: seg.endTime,
        confidence: seg.confidence,
        language: seg.language,
        ...(translation ? { translation: translation.text } : {}),
      };
    }),
  };
  
  return JSON.stringify(data, null, 2);
}

/**
 * Download a file to the user's device
 */
export function downloadFile(content: string, filename: string, mimeType: string): void {
  const blob = new Blob([content], { type: mimeType });
  const url = URL.createObjectURL(blob);
  
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  link.style.display = 'none';
  
  document.body.appendChild(link);
  link.click();
  
  // Cleanup
  setTimeout(() => {
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
  }, 100);
}

function formatTime(seconds: number): string {
  const mins = Math.floor(seconds / 60);
  const secs = Math.floor(seconds % 60);
  return `${mins}:${secs.toString().padStart(2, '0')}`;
}

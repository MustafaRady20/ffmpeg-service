export const COMPRESSION_QUEUE = 'compression';

export interface CompressionJobData {
  inputPath: string;
  originalName: string;
  generateSubtitles?: boolean;
  subtitleLanguage?: string;
  sourceLanguage?: string;
  diarize?: boolean;
}

export interface CompressionJobResult {
  servePath: string;
  discardPath: string;
  serveSize: number;
  originalName: string;
  subtitlePath?: string;
  translatedSubtitlePath?: string;
}

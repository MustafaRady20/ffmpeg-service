export const COMPRESSION_QUEUE = 'compression';

export interface CompressionJobData {
  inputPath: string;
  originalName: string;
}

export interface CompressionJobResult {
  servePath: string;
  discardPath: string;
  serveSize: number;
  originalName: string;
}

export interface ChunkDataMessage {
  chunkX: number;
  chunkZ: number;
  biome: string;
  generationTimeMs: number;
  blockCounts: Record<string, number>;
  opaqueBuffer: Float32Array;
  waterBuffer: Float32Array;
  lavaBuffer: Float32Array;
}

export type ChunkLoadedCallback = (data: ChunkDataMessage, completedCount: number, totalCount: number) => void;

/**
 * 複数チャンクの非同期並列生成を管理するマネージャークラス (3x3 / 5x5 可変対応)
 */
export class ChunkManager {
  private worker: Worker;
  private currentSeed: string;
  private queue: Array<{ chunkX: number; chunkZ: number }> = [];
  private totalToLoad = 0;
  private completedCount = 0;
  private isGenerating = false;
  private isInitialized = false;
  private currentGenerationId = 0;
  private onChunkLoaded: ChunkLoadedCallback;

  constructor(seed: string, onChunkLoaded: ChunkLoadedCallback) {
    this.currentSeed = seed;
    this.onChunkLoaded = onChunkLoaded;

    this.worker = new Worker(new URL('./chunk-worker.ts', import.meta.url), { type: 'module' });

    this.worker.onerror = (err) => {
      console.error('[Worker Fatal Error]', err);
    };

    this.worker.onmessage = (event) => {
      const data = event.data;
      if (data.type === 'INIT_DONE') {
        this.isInitialized = true;
        this.processNextInQueue();
      } else if (data.type === 'CHUNK_DONE') {
        if (data.generationId === this.currentGenerationId) {
          this.completedCount++;
          this.onChunkLoaded(data, this.completedCount, this.totalToLoad);
        }
        this.isGenerating = false;
        this.processNextInQueue();
      } else if (data.type === 'ERROR') {
        console.error(`[ChunkWorker Error] (${data.chunkX}, ${data.chunkZ}):`, data.error);
        this.isGenerating = false;
        this.processNextInQueue();
      }
    };

    this.worker.postMessage({ type: 'INIT', seed });
  }

  /**
   * 指定した中心チャンク座標の周囲 (radius: 1=3x3, 2=5x5) を中心から近い順に読み込む
   */
  public loadAreaAround(centerChunkX: number, centerChunkZ: number, radius: number = 1, seed?: string): void {
    this.currentGenerationId++;
    this.queue = [];
    this.isGenerating = false;

    if (seed !== undefined && seed !== this.currentSeed) {
      this.currentSeed = seed;
      this.isInitialized = false;
      this.worker.postMessage({ type: 'INIT', seed });
    }

    // 中心からの距離順 (チェビシェフ距離・渦巻き順) にソート
    const coords: Array<{ chunkX: number; chunkZ: number; distSq: number }> = [];

    for (let dx = -radius; dx <= radius; dx++) {
      for (let dz = -radius; dz <= radius; dz++) {
        coords.push({
          chunkX: centerChunkX + dx,
          chunkZ: centerChunkZ + dz,
          distSq: dx * dx + dz * dz,
        });
      }
    }

    coords.sort((a, b) => a.distSq - b.distSq);

    this.queue = coords.map((c) => ({ chunkX: c.chunkX, chunkZ: c.chunkZ }));
    this.totalToLoad = this.queue.length;
    this.completedCount = 0;

    if (this.isInitialized) {
      this.processNextInQueue();
    }
  }

  private processNextInQueue(): void {
    if (this.isGenerating || this.queue.length === 0 || !this.isInitialized) return;

    const next = this.queue.shift();
    if (!next) return;

    this.isGenerating = true;
    this.worker.postMessage({
      type: 'GENERATE',
      chunkX: next.chunkX,
      chunkZ: next.chunkZ,
      generationId: this.currentGenerationId,
    });
  }

  public terminate(): void {
    this.worker.terminate();
  }
}
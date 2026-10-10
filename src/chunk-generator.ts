import {
  Chunk,
  ChunkPos,
  BlockPos,
  NoiseChunkGenerator,
  RandomState,
  NoiseGeneratorSettings,
} from 'deepslate';

export interface BlockLayerSummary {
  fromY: number;
  toY: number;
  block: string;
  count: number;
}

export interface ChunkGenerationResult {
  chunkX: number;
  chunkZ: number;
  generationTimeMs: number;
  totalBlocks: number;
  blockCounts: Record<string, number>;
  columnSummary: BlockLayerSummary[];
}

/**
 * BlockState からブロックID文字列を安全に取り出すヘルパー
 */
function getBlockStateName(state: any): string {
  if (!state) return 'minecraft:air';
  if (typeof state.getName === 'function') {
    return state.getName().toString();
  }
  if (typeof state.name === 'string') {
    return state.name;
  }
  if (typeof state.toString === 'function') {
    return state.toString();
  }
  return String(state);
}

/**
 * 指定チャンクを生成し、ブロック構成と原点列の垂直断面を集計する関数
 */
export function generateAndAnalyzeChunk(
  generator: NoiseChunkGenerator,
  randomState: RandomState,
  settings: NoiseGeneratorSettings,
  chunkX: number = 0,
  chunkZ: number = 0
): ChunkGenerationResult {
  const startTime = performance.now();

  const minY = settings.noise.minY;
  const height = settings.noise.height;
  const chunkPos = ChunkPos.create(chunkX, chunkZ);
  const chunk = new Chunk(minY, height, chunkPos);

  // 1. 地形・地表ルールの一括生成
  generator.buildTerrain(randomState, chunk);

  const generationTimeMs = performance.now() - startTime;

  // 2. チャンク内全ブロック（16×16×384 = 98,304ブロック）の出現集計
  const blockCounts: Record<string, number> = {};
  let totalBlocks = 0;
  const baseBlockX = chunkX * 16;
  const baseBlockZ = chunkZ * 16;

  for (let y = minY; y < minY + height; y++) {
    for (let z = 0; z < 16; z++) {
      for (let x = 0; x < 16; x++) {
        const pos = BlockPos.create(baseBlockX + x, y, baseBlockZ + z);
        const state = chunk.getBlockState(pos);
        const blockName = getBlockStateName(state);

        blockCounts[blockName] = (blockCounts[blockName] ?? 0) + 1;
        totalBlocks++;
      }
    }
  }

  // 3. 原点列 (X=baseBlockX, Z=baseBlockZ) の垂直地層サマリー
  const columnSummary: BlockLayerSummary[] = [];
  let currentBlock = '';
  let currentFromY = minY;
  let currentCount = 0;

  for (let y = minY; y < minY + height; y++) {
    const pos = BlockPos.create(baseBlockX, y, baseBlockZ);
    const state = chunk.getBlockState(pos);
    const blockName = getBlockStateName(state);

    if (blockName !== currentBlock) {
      if (currentCount > 0) {
        columnSummary.push({
          fromY: currentFromY,
          toY: y - 1,
          block: currentBlock,
          count: currentCount,
        });
      }
      currentBlock = blockName;
      currentFromY = y;
      currentCount = 1;
    } else {
      currentCount++;
    }
  }

  if (currentCount > 0) {
    columnSummary.push({
      fromY: currentFromY,
      toY: minY + height - 1,
      block: currentBlock,
      count: currentCount,
    });
  }

  return {
    chunkX,
    chunkZ,
    generationTimeMs,
    totalBlocks,
    blockCounts,
    columnSummary,
  };
}
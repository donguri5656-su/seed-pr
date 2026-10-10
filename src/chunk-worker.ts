import {
  NoiseGeneratorSettings,
  RandomState,
  NoiseChunkGenerator,
  MultiNoiseBiomeSource,
  Chunk,
  ChunkPos,
  BlockPos,
  BlockState,
} from 'deepslate';
import {
  registerAllVanillaWorldgen,
  unwrapJson,
  normalizeDensityFunctionJson,
} from './worldgen-registries.js';
import { applySurfaceRule16x16 } from './surface-system.js';

// バニラJSONファイルを一括インポート
const noiseFiles = import.meta.glob('/src/data/minecraft/worldgen/noise/**/*.json', { eager: true });
const densityFunctionFiles = import.meta.glob('/src/data/minecraft/worldgen/density_function/**/*.json', { eager: true });
const noiseSettingsFiles = import.meta.glob('/src/data/minecraft/worldgen/noise_settings/**/*.json', { eager: true });
const dimensionFiles = import.meta.glob('/src/data/minecraft/dimension/**/*.json', { eager: true });

// バニラ 1.21 の全地表ブロックカラーパレット
const BLOCK_COLORS: Record<string, number> = {
  // 岩石・鉱物
  'minecraft:stone': 0x808080,
  'minecraft:deepslate': 0x383838,
  'minecraft:bedrock': 0x181818,
  'minecraft:tuff': 0x6c6d66,
  'minecraft:calcite': 0xdfdfdb,
  'minecraft:dripstone_block': 0x846759,
  'minecraft:obsidian': 0x14101e,
  'minecraft:magma_block': 0x8c3f15,

  // 土・草・苔
  'minecraft:grass_block': 0x5b8c32,
  'minecraft:dirt': 0x866043,
  'minecraft:coarse_dirt': 0x77553b,
  'minecraft:podzol': 0x5b3f1e,
  'minecraft:mycelium': 0x6f6265,
  'minecraft:mud': 0x3c3938,
  'minecraft:muddy_mangrove_roots': 0x443b32,
  'minecraft:moss_block': 0x596e2d,

  // 砂・砂岩・砂利
  'minecraft:gravel': 0x9e9e9e,
  'minecraft:sand': 0xdcd39e,
  'minecraft:sandstone': 0xd6cda2,
  'minecraft:red_sand': 0xc45c22,
  'minecraft:red_sandstone': 0xb6551f,
  'minecraft:clay': 0xa0a6b5,

  // 雪・氷
  'minecraft:snow_block': 0xf0f5f5,
  'minecraft:powder_snow': 0xf8fbfb,
  'minecraft:snow': 0xf0f5f5,
  'minecraft:ice': 0x90b0d0,
  'minecraft:packed_ice': 0x80a0c0,
  'minecraft:blue_ice': 0x74a7ff,

  // テラコッタ各種 (バッドランド/メサ)
  'minecraft:terracotta': 0x985e43,
  'minecraft:white_terracotta': 0xd1b1a1,
  'minecraft:orange_terracotta': 0xa05325,
  'minecraft:magenta_terracotta': 0x95576c,
  'minecraft:light_blue_terracotta': 0x706c8a,
  'minecraft:yellow_terracotta': 0xba8524,
  'minecraft:lime_terracotta': 0x677535,
  'minecraft:pink_terracotta': 0xa04d4e,
  'minecraft:gray_terracotta': 0x392a24,
  'minecraft:light_gray_terracotta': 0x876b62,
  'minecraft:cyan_terracotta': 0x575c5c,
  'minecraft:purple_terracotta': 0x764556,
  'minecraft:blue_terracotta': 0x4a3b5b,
  'minecraft:brown_terracotta': 0x4d3223,
  'minecraft:green_terracotta': 0x4c522a,
  'minecraft:red_terracotta': 0x8e3c2e,
  'minecraft:black_terracotta': 0x251610,
};

function getBlockStateName(state: any): string {
  if (!state) return 'minecraft:air';
  if (typeof state.getName === 'function') return state.getName().toString();
  if (typeof state.name === 'string') return state.name;
  if (typeof state.toString === 'function') return state.toString();
  return String(state);
}

let generator: NoiseChunkGenerator | null = null;
let randomState: RandomState | null = null;
let settings: NoiseGeneratorSettings | null = null;
let biomeSource: MultiNoiseBiomeSource | null = null;

// Worker の初期化
function initWorker(seedBigInt: bigint) {
  registerAllVanillaWorldgen(noiseFiles, densityFunctionFiles, dimensionFiles);

  const overworldNoiseSettingsModule = noiseSettingsFiles['/src/data/minecraft/worldgen/noise_settings/overworld.json'];
  const overworldDimensionModule = dimensionFiles['/src/data/minecraft/dimension/overworld.json'];

  const noiseSettingsRaw = unwrapJson(overworldNoiseSettingsModule);
  const dimensionJson = unwrapJson(overworldDimensionModule);

  const preparedSettings = { ...noiseSettingsRaw };
  if (!preparedSettings.material_rule && preparedSettings.surface_rule) {
    preparedSettings.material_rule = preparedSettings.surface_rule;
  }

  const normalizedNoiseSettings = normalizeDensityFunctionJson(preparedSettings);
  settings = NoiseGeneratorSettings.fromJson(normalizedNoiseSettings);
  randomState = new RandomState(settings, seedBigInt);
  biomeSource = MultiNoiseBiomeSource.fromJson(dimensionJson.generator.biome_source);
  generator = new NoiseChunkGenerator(biomeSource, settings);
}

/**
 * ブロックが空気または水/溶岩に接しているか (視認可能面を持つか) を高速判定する関数
 */
function isBlockExposed(
  chunk: Chunk,
  baseBlockX: number,
  baseBlockZ: number,
  x: number,
  y: number,
  z: number,
  minY: number,
  maxY: number
): boolean {
  // チャンク外周面 (x=0,15 または z=0,15) や最底面・天井は、隣接チャンクとの境界のため露出扱い
  if (x === 0 || x === 15 || z === 0 || z === 15 || y === minY || y === maxY) {
    return true;
  }

  // 6方向の隣接ブロックのいずれかが空気または液体なら、このブロックは露出している
  const neighbors = [
    [baseBlockX + x, y + 1, baseBlockZ + z],
    [baseBlockX + x, y - 1, baseBlockZ + z],
    [baseBlockX + x + 1, y, baseBlockZ + z],
    [baseBlockX + x - 1, y, baseBlockZ + z],
    [baseBlockX + x, y, baseBlockZ + z + 1],
    [baseBlockX + x, y, baseBlockZ + z - 1],
  ];

  for (let i = 0; i < 6; i++) {
    const [nx, ny, nz] = neighbors[i];
    const nPos = BlockPos.create(nx, ny, nz);
    const nState = chunk.getBlockState(nPos);
    if (nState.equals(BlockState.AIR) || nState.isFluid()) {
      return true;
    }
  }

  // 6面すべてが不透明ブロックで埋まっている (地中の見えないブロック)
  return false;
}

// チャンクの生成とボクセル配列化 (隠面カリング付き)
function generateChunk(chunkX: number, chunkZ: number, generationId: number) {
  if (!generator || !randomState || !settings || !biomeSource) {
    throw new Error('Workerが初期化されていません');
  }

  const startTime = performance.now();
  const minY = settings.noise.minY;
  const chunkHeight = settings.noise.height;
  const maxY = minY + chunkHeight - 1;
  const chunkPos = ChunkPos.create(chunkX, chunkZ);
  const chunk = new Chunk(minY, chunkHeight, chunkPos);

  const centerQuartX = (chunkX * 16 + 8) >> 2;
  const centerQuartZ = (chunkZ * 16 + 8) >> 2;
  const biomeId = biomeSource.getBiome(centerQuartX, 64 >> 2, centerQuartZ, randomState.sampler);

  // 1. ベース地形充填
  generator.buildTerrain(randomState, chunk, false, biomeId);

  // 2. 16×16 全面への地表ルール適用
  applySurfaceRule16x16(chunk, settings, randomState, biomeSource, (generator as any).globalFluidPicker);

  const generationTimeMs = performance.now() - startTime;

  // ブロックデータの収集 (地中隠面カリングを適用)
  const baseBlockX = chunkX * 16;
  const baseBlockZ = chunkZ * 16;

  const opaqueList: number[] = [];
  const waterList: number[] = [];
  const lavaList: number[] = [];
  const blockCounts: Record<string, number> = {};

  for (let y = minY; y <= maxY; y++) {
    for (let z = 0; z < 16; z++) {
      for (let x = 0; x < 16; x++) {
        const pos = BlockPos.create(baseBlockX + x, y, baseBlockZ + z);
        const state = chunk.getBlockState(pos);
        const blockName = getBlockStateName(state);

        if (blockName === 'minecraft:air') continue;

        blockCounts[blockName] = (blockCounts[blockName] ?? 0) + 1;

        if (blockName === 'minecraft:water') {
          // 水は半透明なのでそのまま描画
          waterList.push(baseBlockX + x + 0.5, y + 0.5, baseBlockZ + z + 0.5);
        } else if (blockName === 'minecraft:lava') {
          // 溶岩も発光表現のためそのまま描画
          lavaList.push(baseBlockX + x + 0.5, y + 0.5, baseBlockZ + z + 0.5);
        } else {
          // 不透明ブロック: 表面・空洞に露出しているブロックだけを描画 (地中の見えないブロックを除外)
          if (isBlockExposed(chunk, baseBlockX, baseBlockZ, x, y, z, minY, maxY)) {
            const color = BLOCK_COLORS[blockName] ?? 0xba55d3;
            opaqueList.push(baseBlockX + x + 0.5, y + 0.5, baseBlockZ + z + 0.5, color);
          }
        }
      }
    }
  }

  const opaqueBuffer = new Float32Array(opaqueList);
  const waterBuffer = new Float32Array(waterList);
  const lavaBuffer = new Float32Array(lavaList);

  return {
    generationId,
    chunkX,
    chunkZ,
    biome: biomeId.toString(),
    generationTimeMs,
    blockCounts,
    opaqueBuffer,
    waterBuffer,
    lavaBuffer,
  };
}

// メッセージ受信ハンドラ
self.onmessage = (event) => {
  const data = event.data;
  if (data.type === 'INIT') {
    try {
      initWorker(BigInt(data.seed));
      self.postMessage({ type: 'INIT_DONE' });
    } catch (err: any) {
      self.postMessage({ type: 'ERROR', error: String(err?.stack ?? err) });
    }
  } else if (data.type === 'GENERATE') {
    try {
      const res = generateChunk(data.chunkX, data.chunkZ, data.generationId);
      self.postMessage(
        {
          type: 'CHUNK_DONE',
          generationId: res.generationId,
          chunkX: res.chunkX,
          chunkZ: res.chunkZ,
          biome: res.biome,
          generationTimeMs: res.generationTimeMs,
          blockCounts: res.blockCounts,
          opaqueBuffer: res.opaqueBuffer,
          waterBuffer: res.waterBuffer,
          lavaBuffer: res.lavaBuffer,
        },
        [res.opaqueBuffer.buffer, res.waterBuffer.buffer, res.lavaBuffer.buffer]
      );
    } catch (err: any) {
      self.postMessage({
        type: 'ERROR',
        generationId: data.generationId,
        chunkX: data.chunkX,
        chunkZ: data.chunkZ,
        error: String(err?.stack ?? err),
      });
    }
  }
};
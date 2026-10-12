import {
  Chunk,
  BlockPos,
  BlockState,
  ChunkPos,
  Identifier,
  NoiseGeneratorSettings,
  RandomState,
  MultiNoiseBiomeSource,
  NoiseChunk,
  MaterialRuleContext,
} from 'deepslate';

/**
 * BlockState からブロックID文字列を安全に取り出すヘルパー
 */
function getBlockStateName(state: any): string {
  if (!state) return 'minecraft:air';
  if (typeof state.getName === 'function') return state.getName().toString();
  if (typeof state.name === 'string') return state.name;
  if (typeof state.toString === 'function') return state.toString();
  return String(state);
}

/**
 * 【完全汎用: バイオーム表面修飾マスターマップ】
 * このマップは、バージョンアップ（1.22, 1.23...）やMOD、将来のカスタムデータパックで
 * どんな新しいバイオームが登場しようとも、コードのロジックを変更することなく
 * 「バイオームID」と「露出面に配置するブロック」を追加・変更するだけで
 * 無限かつ永続的に対応できるように設計されたデータ駆動型の辞書です。
 */
const GLOBAL_BIOME_SURFACE_CONFIG: Record<string, string> = {
  // --- 1. 洞窟バイオーム系 ---
  'minecraft:lush_caves': 'minecraft:moss_block',
  'minecraft:dripstone_caves': 'minecraft:dripstone_block',
  'minecraft:deep_dark': 'minecraft:sculk',

  // --- 2. 砂漠・乾燥・荒野系 ---
  'minecraft:desert': 'minecraft:sand',
  'minecraft:badlands': 'minecraft:red_sand',
  'minecraft:wooded_badlands': 'minecraft:coarse_dirt',
  'minecraft:eroded_badlands': 'minecraft:red_sand',

  // --- 3. 特殊・キノコ系 ---
  'minecraft:mushroom_fields': 'minecraft:mycelium',

  // --- 4. 凍結・雪原・高山系 ---
  'minecraft:snowy_plains': 'minecraft:snow_block',
  'minecraft:ice_spikes': 'minecraft:snow_block',
  'minecraft:snowy_taiga': 'minecraft:snow_block',
  'minecraft:snowy_slopes': 'minecraft:snow_block',
  'minecraft:frozen_peaks': 'minecraft:packed_ice',
  'minecraft:jagged_peaks': 'minecraft:snow_block',
};

// パフォーマンス最適化のため、文字列IDから BlockState へのインスタンスを事前キャッシュ
const SURFACE_STATE_CACHE = new Map<string, BlockState>();

function getSurfaceState(blockId: string): BlockState {
  let cached = SURFACE_STATE_CACHE.get(blockId);
  if (!cached) {
    cached = new BlockState(Identifier.parse(blockId));
    SURFACE_STATE_CACHE.set(blockId, cached);
  }
  return cached;
}

/**
 * Z=0〜15 の 16×16 全面に、3Dバイオームを反映して
 * 地表ルール (Surface Rule) を完全に適用する関数
 */
export function applySurfaceRule16x16(
  chunk: Chunk,
  noiseChunk: NoiseChunk,
  settings: NoiseGeneratorSettings,
  randomState: RandomState,
  biomeSource: MultiNoiseBiomeSource
): void {
  const minX = ChunkPos.minBlockX(chunk.pos);
  const minZ = ChunkPos.minBlockZ(chunk.pos);

  // ブロックの実際の3D座標からリアルタイムにバイオームを解決する関数
  const biomeGetter = (pos: BlockPos): Identifier => {
    return biomeSource.getBiome(pos[0] >> 2, pos[1] >> 2, pos[2] >> 2, randomState.sampler);
  };

  // WorldgenContext (minY, height, seaLevel) を構築
  const worldgenContext = {
    minY: settings.noise.minY,
    height: settings.noise.height,
    seaLevel: settings.seaLevel,
  };

  const context = new MaterialRuleContext(
    randomState.surfaceSystem,
    randomState,
    chunk,
    noiseChunk,
    worldgenContext,
    biomeGetter
  );

  const ruleWithContext = settings.materialRule.compile(context);

  // X: 0〜15, Z: 0〜15 の 256 本すべての列を確実に走査
  for (let x = 0; x < 16; x += 1) {
    const blockX = minX + x;
    for (let z = 0; z < 16; z += 1) {
      const blockZ = minZ + z;
      context.updateXZ(blockX, blockZ);

      let stoneAboveDepth = 0;
      let waterHeight = Number.MIN_SAFE_INTEGER;
      let nextCeilingStoneY = Number.MAX_SAFE_INTEGER;

      for (let y = chunk.maxY; y >= chunk.minY; y -= 1) {
        const blockPos = BlockPos.create(blockX, y, blockZ);
        const old = chunk.getBlockState(blockPos);

        if (old.equals(BlockState.AIR)) {
          stoneAboveDepth = 0;
          waterHeight = Number.MIN_SAFE_INTEGER;
          continue;
        }

        if (old.isFluid()) {
          if (waterHeight === Number.MIN_SAFE_INTEGER) {
            waterHeight = y + 1;
          }
          continue;
        }

        if (nextCeilingStoneY >= y) {
          nextCeilingStoneY = Number.MIN_SAFE_INTEGER;
          for (let lookaheadY = y - 1; lookaheadY >= chunk.minY; lookaheadY -= 1) {
            const nextState = chunk.getBlockState(BlockPos.create(blockX, lookaheadY, blockZ));
            if (nextState.equals(BlockState.AIR) || nextState.isFluid()) {
              nextCeilingStoneY = lookaheadY + 1;
              break;
            }
          }
        }

        stoneAboveDepth += 1;
        const stoneBelowDepth = y - nextCeilingStoneY + 1;
        context.updateY(stoneAboveDepth, stoneBelowDepth, waterHeight, y);

        // 1. 公式の地表ルールの適用
        const state = ruleWithContext(blockX, y, blockZ);
        if (state) {
          chunk.setBlockState(blockPos, state);
        }

        // 2. 将来のバージョンや全バイオームに完全対応する汎用データ駆動型修飾システム
        const currentState = chunk.getBlockState(blockPos);
        const name = getBlockStateName(currentState);
        
        // 基本の地表・地下を構成する代表的ブロックの露出面に対して適用
        if (
          name === 'minecraft:stone' ||
          name === 'minecraft:deepslate' ||
          name === 'minecraft:tuff' ||
          name === 'minecraft:dirt' ||
          name === 'minecraft:coarse_dirt'
        ) {
          const biomeId = biomeGetter(blockPos).toString();
          const targetBlockId = GLOBAL_BIOME_SURFACE_CONFIG[biomeId];

          if (targetBlockId) {
            // 上か下が空気に面している（表面・露出部・洞窟の壁など）場合のみ置換
            const above = chunk.getBlockState(BlockPos.create(blockX, Math.min(chunk.maxY, y + 1), blockZ));
            const below = chunk.getBlockState(BlockPos.create(blockX, Math.max(chunk.minY, y - 1), blockZ));
            if (above.equals(BlockState.AIR) || below.equals(BlockState.AIR)) {
              chunk.setBlockState(blockPos, getSurfaceState(targetBlockId));
            }
          }
        }
      }
    }
  }
}
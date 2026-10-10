import {
  Chunk,
  BlockPos,
  BlockState,
  ChunkPos,
  Identifier,
  NoiseGeneratorSettings,
  RandomState,
  MultiNoiseBiomeSource,
  DensityVolume,
  NoiseChunk,
  MaterialRuleContext,
} from 'deepslate';

/**
 * Z=0〜15 の 16×16 全面に、3Dバイオームと公式溶岩海面 (Y < -54) を反映して
 * 地表ルール (Surface Rule) を完全に適用する関数
 */
export function applySurfaceRule16x16(
  chunk: Chunk,
  settings: NoiseGeneratorSettings,
  randomState: RandomState,
  biomeSource: MultiNoiseBiomeSource,
  globalFluidPicker?: any
): void {
  const minX = ChunkPos.minBlockX(chunk.pos);
  const minZ = ChunkPos.minBlockZ(chunk.pos);

  // 16×384×16 の完全なボリュームを作成
  const volume = new DensityVolume(
    16,
    settings.noise.height,
    16,
    minX,
    settings.noise.minY,
    minZ
  );

  // 公式の流体ピッカー、またはバニラ準拠の流体判定 (Y < -54 は溶岩、それ以上は水)
  const defaultFluidPicker = (x: number, y: number, z: number) => {
    const isLava = y < Math.min(-54, settings.seaLevel);
    return {
      at: (blockY: number) => {
        if (isLava) {
          return blockY < -54 ? BlockState.LAVA : BlockState.AIR;
        }
        return blockY < settings.seaLevel ? settings.defaultFluid : BlockState.AIR;
      },
    };
  };

  const activeFluidPicker = globalFluidPicker ?? defaultFluidPicker;
  const noiseChunk = new NoiseChunk(randomState, settings, activeFluidPicker, volume);

  // ブロックの実際の3D座標からリアルタイムにバイオームを解決する関数
  const biomeGetter = (pos: BlockPos): Identifier => {
    return biomeSource.getBiome(pos[0] >> 2, pos[1] >> 2, pos[2] >> 2, randomState.sampler);
  };

  const context = new MaterialRuleContext(
    randomState.surfaceSystem,
    randomState,
    chunk,
    noiseChunk,
    settings.noise,
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

        const state = ruleWithContext(blockX, y, blockZ);
        if (state) {
          chunk.setBlockState(blockPos, state);
        }
      }
    }
  }
}
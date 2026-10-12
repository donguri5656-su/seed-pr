import { Identifier, WorldgenRegistries, DensityFunction, NormalNoise } from 'deepslate';

// Viteのモジュールから生のJSONデータを安全に取り出すヘルパー
export function unwrapJson(moduleObj: unknown): any {
  if (moduleObj && typeof moduleObj === 'object' && 'default' in moduleObj) {
    return (moduleObj as { default: unknown }).default;
  }
  return moduleObj;
}

/**
 * バニラ公式ノイズJSON (firstOctave, amplitudes) から NormalNoise を正確に初期化する関数
 * (第4引数を 'legacy' にすることで、Java版バニラのパリティ正規化係数を適用する)
 */
export function parseVanillaNoise(rawJson: any): NormalNoise {
  const firstOctave = typeof rawJson?.firstOctave === 'number' ? rawJson.firstOctave : 0;
  const amplitudes = Array.isArray(rawJson?.amplitudes) ? rawJson.amplitudes : [1];
  return new NormalNoise(1, firstOctave, amplitudes.length, 'legacy', amplitudes);
}

/**
 * バニラ 1.21 の密度関数JSONを deepslate の正規クラスが認識できる形式に再帰変換する関数
 */
export function normalizeDensityFunctionJson(obj: unknown): any {
  if (!obj || typeof obj !== 'object') {
    return obj;
  }
  if (Array.isArray(obj)) {
    return obj.map(normalizeDensityFunctionJson);
  }

  const raw = { ...(obj as Record<string, unknown>) };
  const rawType = typeof raw.type === 'string' ? raw.type.replace(/^minecraft:/, '') : undefined;

  // 1. 各種キャッシュ (flat_cache, cache_2d, cache_once) -> deepslate の "cache"
  if (rawType === 'flat_cache' || rawType === 'cache_2d' || rawType === 'cache_once') {
    return {
      type: 'minecraft:cache',
      argument: normalizeDensityFunctionJson(raw.argument ?? raw.input),
    };
  }

  // 2. shifted_noise -> deepslate の "noise" (NoiseFunction)
  if (rawType === 'shifted_noise') {
    return {
      type: 'minecraft:noise',
      noise: raw.noise,
      xz_scale: raw.xz_scale ?? 1,
      y_scale: raw.y_scale ?? 1,
      shift_x: normalizeDensityFunctionJson(raw.shift_x),
      shift_y: normalizeDensityFunctionJson(raw.shift_y),
      shift_z: normalizeDensityFunctionJson(raw.shift_z),
    };
  }

  // 3. y_clamped_gradient -> deepslate の "gradient" (Gradient)
  if (rawType === 'y_clamped_gradient') {
    return {
      type: 'minecraft:gradient',
      axis: 'y',
      tiling: 'clamp_to_edge',
      from_coordinate: raw.from_y,
      to_coordinate: raw.to_y,
      from_value: raw.from_value,
      to_value: raw.to_value,
    };
  }

  // 4. weird_scaled_sampler -> Mojang公式等価ツリー (interval_select + abs + mul + noise)
  if (rawType === 'weird_scaled_sampler') {
    const isType2 = raw.rarity_value_mapper === 'type_2';
    const thresholds = isType2 ? [-0.5, 0.0, 0.5, 1000000.0] : [-0.75, -0.5, 0.5, 0.75, 1000000.0];
    const rarities = isType2 ? [0.75, 1.0, 1.5, 2.0] : [0.5, 0.75, 1.0, 2.0, 3.0];
    const noiseId = raw.noise;

    const functions = rarities.map((rarity) => ({
      type: 'minecraft:abs',
      argument: {
        type: 'minecraft:mul',
        argument1: rarity,
        argument2: {
          type: 'minecraft:noise',
          noise: noiseId,
          xz_scale: 1.0 / rarity,
          y_scale: 1.0 / rarity,
        },
      },
    }));

    return {
      type: 'minecraft:interval_select',
      input: normalizeDensityFunctionJson(raw.input),
      thresholds,
      functions: functions.map(normalizeDensityFunctionJson),
    };
  }

  // それ以外のプロパティも再帰的に正規化
  const normalized: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(raw)) {
    normalized[key] = normalizeDensityFunctionJson(value);
  }
  return normalized;
}

export interface RegistryCounts {
  noiseRegistered: number;
  densityFunctionRegistered: number;
  biomesRegistered: number;
}

/**
 * バニラJSONを WorldgenRegistries に一括登録する関数
 */
export function registerAllVanillaWorldgen(
  noiseFiles: Record<string, unknown>,
  densityFunctionFiles: Record<string, unknown>,
  dimensionFiles: Record<string, unknown>
): RegistryCounts {
  let noiseRegistered = 0;
  let densityFunctionRegistered = 0;
  let biomesRegistered = 0;

  // 1. ノイズ定義の登録
  for (const [path, fileModule] of Object.entries(noiseFiles)) {
    const rawJson = unwrapJson(fileModule);
    const nameMatch = path.match(/\/worldgen\/noise\/(.+)\.json$/);
    if (!nameMatch) continue;
    const name = nameMatch[1];
    const id = Identifier.parse(`minecraft:${name}`);

    WorldgenRegistries.NOISE.register(id, parseVanillaNoise(rawJson));
    noiseRegistered++;
  }

  // 2. 密度関数の登録
  for (const [path, fileModule] of Object.entries(densityFunctionFiles)) {
    const rawJson = unwrapJson(fileModule);
    const nameMatch = path.match(/\/worldgen\/density_function\/(.+)\.json$/);
    if (!nameMatch) continue;
    const name = nameMatch[1];
    const id = Identifier.parse(`minecraft:${name}`);

    WorldgenRegistries.DENSITY_FUNCTION.register(id, () => {
      const normalizedJson = normalizeDensityFunctionJson(rawJson);
      return DensityFunction.fromJson(normalizedJson);
    });
    densityFunctionRegistered++;
  }

  // 3. Surface Rule で参照される全バイオームIDの登録
  const overworldDimension = unwrapJson(dimensionFiles['/src/data/minecraft/dimension/overworld.json']);
  const biomeEntries = overworldDimension?.generator?.biome_source?.biomes;
  if (Array.isArray(biomeEntries)) {
    for (const entry of biomeEntries) {
      const biomeName = entry?.biome;
      if (typeof biomeName === 'string') {
        const id = Identifier.parse(biomeName);
        if (!WorldgenRegistries.BIOME.has(id)) {
          WorldgenRegistries.BIOME.register(id, {});
          biomesRegistered++;
        }
      }
    }
  }

  return {
    noiseRegistered,
    densityFunctionRegistered,
    biomesRegistered,
  };
}
import {
  NoiseGeneratorSettings,
  RandomState,
  NoiseChunkGenerator,
  MultiNoiseBiomeSource,
  DensityFunction,
  Identifier,
  WorldgenRegistries,
} from 'deepslate';
import { unwrapJson, normalizeDensityFunctionJson } from './worldgen-registries.js';

export interface ClimateValues {
  temperature: number;
  vegetation: number;
  continentalness: number;
  erosion: number;
  depth: number;
  weirdness: number;
  peaksAndValleys: number;
}

export interface SampleResult extends ClimateValues {
  x: number;
  y: number;
  z: number;
  biome: string;
  surfaceBiome: string;
  surfaceHeight: number;
  oceanFloorHeight: number;
}

export interface GridSearchItem {
  dx: number;
  dy: number;
  dz: number;
  values: ClimateValues;
}

export interface MultiModeSampleResult {
  standard: ClimateValues;
  quartTruncated: ClimateValues;
  gridSearch: GridSearchItem[];
}

export interface HeightDensityProfile {
  y: number;
  finalDensity: number;
}

export interface Diagnostics {
  continentsDirect: number;
  temperatureDirect: number;
  erosionDirect: number;
  finalDensityDirect: number;
  densityAtY48: number;
  noodleAtY48: number;
  slopedCheeseAtY48: number;
  yFunctionAtY48: number;
  densityProfile: HeightDensityProfile[];
}

export interface InitializedGenerator {
  generator: NoiseChunkGenerator;
  randomState: RandomState;
  biomeSource: MultiNoiseBiomeSource;
  sampleCoordinate: (x: number, z: number, customY?: number) => SampleResult;
  sampleMultiMode: (x: number, y: number, z: number) => MultiModeSampleResult;
  diagnostics: Diagnostics;
  settings: NoiseGeneratorSettings;
}

/**
 * 指定シード値でワールド生成器を初期化し、内部診断情報を取得する関数
 */
export function initializeOverworldGenerator(
  seed: bigint,
  noiseSettingsModule: unknown,
  dimensionModule: unknown
): InitializedGenerator {
  const noiseSettingsRaw = unwrapJson(noiseSettingsModule);
  const dimensionJson = unwrapJson(dimensionModule);

  if (!noiseSettingsRaw) {
    throw new Error('noise_settings/overworld.json の読み込みに失敗しました。');
  }
  if (!dimensionJson?.generator?.biome_source) {
    throw new Error('dimension/overworld.json から biome_source の取得に失敗しました。');
  }

  // 1. overworld.json の surface_rule を material_rule に接続
  const preparedSettings = { ...noiseSettingsRaw };
  if (!preparedSettings.material_rule && preparedSettings.surface_rule) {
    preparedSettings.material_rule = preparedSettings.surface_rule;
  }

  // 2. 密度関数などを正規化してノイズ設定を作成
  const normalizedNoiseSettings = normalizeDensityFunctionJson(preparedSettings);
  const settings = NoiseGeneratorSettings.fromJson(normalizedNoiseSettings);

  // 3. シード値を用いた RandomState の初期化
  const randomState = new RandomState(settings, seed);

  // 4. バニラ1.21オーバーワールドの BiomeSource の初期化
  const biomeSource = MultiNoiseBiomeSource.fromJson(dimensionJson.generator.biome_source);

  // 5. 地形生成器の作成
  const generator = new NoiseChunkGenerator(biomeSource, settings);

  // 6. 原点列 (X=0, Z=0) における垂直密度プロファイルの測定
  const finalDensityFn = randomState.router.finalDensity;
  const testYLevels = [-60, -50, -40, -20, 0, 20, 40, 48, 60, 64];
  const densityProfile: HeightDensityProfile[] = testYLevels.map((y) => {
    const ctx = DensityFunction.context(0, y, 0);
    return {
      y,
      finalDensity: finalDensityFn.compute(ctx),
    };
  });

  // 7. Y=48 における詳細切り分け測定
  const ctxY48 = DensityFunction.context(0, 48, 0);
  const densityAtY48 = finalDensityFn.compute(ctxY48);

  let noodleAtY48 = NaN;
  let slopedCheeseAtY48 = NaN;
  let yFunctionAtY48 = NaN;

  try {
    const noodleId = Identifier.parse('minecraft:overworld/caves/noodle');
    const slopedCheeseId = Identifier.parse('minecraft:overworld/sloped_cheese');
    const yFnId = Identifier.parse('minecraft:y');

    const noodleFn = WorldgenRegistries.DENSITY_FUNCTION.get(noodleId);
    const slopedCheeseFn = WorldgenRegistries.DENSITY_FUNCTION.get(slopedCheeseId);
    const yFn = WorldgenRegistries.DENSITY_FUNCTION.get(yFnId);

    if (noodleFn) noodleAtY48 = noodleFn.compute(ctxY48);
    if (slopedCheeseFn) slopedCheeseAtY48 = slopedCheeseFn.compute(ctxY48);
    if (yFn) yFunctionAtY48 = yFn.compute(ctxY48);
  } catch (e) {
    console.warn('分離測定中にエラー:', e);
  }

  const testContext = DensityFunction.context(0, 64, 0);
  const diagnostics: Diagnostics = {
    continentsDirect: randomState.router.continents.compute(testContext),
    temperatureDirect: randomState.router.temperature.compute(testContext),
    erosionDirect: randomState.router.erosion.compute(testContext),
    finalDensityDirect: finalDensityFn.compute(testContext),
    densityAtY48,
    noodleAtY48,
    slopedCheeseAtY48,
    yFunctionAtY48,
    densityProfile,
  };

  // 内部ヘルパー: 指定座標(x, y, z)での気候値を計算する
  const evaluateClimateAt = (x: number, y: number, z: number): ClimateValues => {
    const quartX = x >> 2;
    const quartY = y >> 2;
    const quartZ = z >> 2;

    const climateSampler = randomState.sampler;
    const climate = climateSampler.sample(quartX, quartY, quartZ);
    const pv = -Math.abs(Math.abs(climate.weirdness) - 0.666667) * 3.0 + 1.0;

    return {
      temperature: climate.temperature,
      vegetation: climate.humidity,
      continentalness: climate.continentalness,
      erosion: climate.erosion,
      depth: climate.depth,
      weirdness: climate.weirdness,
      peaksAndValleys: pv,
    };
  };

  // 8. 座標サンプリング用関数（標準）
  const sampleCoordinate = (x: number, z: number, customY?: number): SampleResult => {
    const surfaceHeight = generator.getBaseHeight(x, z, 'WORLD_SURFACE_WG', randomState);
    const oceanFloorHeight = generator.getBaseHeight(x, z, 'OCEAN_FLOOR_WG', randomState);
    const targetY = customY !== undefined ? customY : surfaceHeight;

    const climateVals = evaluateClimateAt(x, targetY, z);
    const quartX = x >> 2;
    const quartZ = z >> 2;
    const surfaceQuartY = surfaceHeight >> 2;

    const climateSampler = randomState.sampler;
    const biomeId = biomeSource.getBiome(quartX, targetY >> 2, quartZ, climateSampler);
    const surfaceBiomeId = biomeSource.getBiome(quartX, surfaceQuartY, quartZ, climateSampler);

    return {
      x,
      y: targetY,
      z,
      biome: biomeId.toString(),
      surfaceBiome: surfaceBiomeId.toString(),
      surfaceHeight,
      oceanFloorHeight,
      ...climateVals,
    };
  };

  // 機能B: 多重モード測定
  const sampleMultiMode = (x: number, y: number, z: number): MultiModeSampleResult => {
    const standard = evaluateClimateAt(x, y, z);

    const qx = (x >> 2) << 2;
    const qy = (y >> 2) << 2;
    const qz = (z >> 2) << 2;
    const quartTruncated = evaluateClimateAt(qx, qy, qz);

    const gridSearch: GridSearchItem[] = [];
    const offsets = [-4, -3, -2, -1, 0, 1, 2, 3, 4];
    for (const dx of offsets) {
      for (const dy of [-2, 0, 2]) {
        for (const dz of offsets) {
          if (dx === 0 && dy === 0 && dz === 0) continue;
          gridSearch.push({
            dx,
            dy,
            dz,
            values: evaluateClimateAt(x + dx, y + dy, z + dz),
          });
        }
      }
    }

    return {
      standard,
      quartTruncated,
      gridSearch,
    };
  };

  return {
    generator,
    randomState,
    biomeSource,
    sampleCoordinate,
    sampleMultiMode,
    diagnostics,
    settings,
  };
}
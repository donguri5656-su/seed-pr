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

export interface SampleResult {
  x: number;
  z: number;
  biome: string;
  surfaceHeight: number;
  oceanFloorHeight: number;
  temperature: number;
  vegetation: number;
  continentalness: number;
  erosion: number;
  depth: number;
  weirdness: number;
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
  slopedCheeseAtY48: number;
  yFunctionAtY48: number;
  densityProfile: HeightDensityProfile[];
}

export interface InitializedGenerator {
  generator: NoiseChunkGenerator;
  randomState: RandomState;
  biomeSource: MultiNoiseBiomeSource;
  sampleCoordinate: (x: number, z: number) => SampleResult;
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

  // 8. 座標サンプリング用関数
  const sampleCoordinate = (x: number, z: number): SampleResult => {
    const surfaceHeight = generator.getBaseHeight(x, z, 'WORLD_SURFACE_WG', randomState);
    const oceanFloorHeight = generator.getBaseHeight(x, z, 'OCEAN_FLOOR_WG', randomState);

    const climateSampler = randomState.sampler;
    const climate = climateSampler.sample(x >> 2, 64 >> 2, z >> 2);
    const biomeId = biomeSource.getBiome(x >> 2, 64 >> 2, z >> 2, climateSampler);

    return {
      x,
      z,
      biome: biomeId.toString(),
      surfaceHeight,
      oceanFloorHeight,
      temperature: climate.temperature,
      vegetation: climate.humidity,
      continentalness: climate.continentalness,
      erosion: climate.erosion,
      depth: climate.depth,
      weirdness: climate.weirdness,
    };
  };

  return {
    generator,
    randomState,
    biomeSource,
    sampleCoordinate,
    diagnostics,
    settings,
  };
}
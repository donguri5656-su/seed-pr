import { registerAllVanillaWorldgen } from './worldgen-registries.js';
import { initializeOverworldGenerator, SampleResult, Diagnostics } from './terrain-sampler.js';
import { ChunkManager, ChunkDataMessage } from './chunk-manager.js';
import { initWideArea3DViewer, Viewer3DInstance } from './renderer3d.js';
import { Chunk, ChunkPos } from 'deepslate';

// バニラJSONファイルを一括インポート
const noiseFiles = import.meta.glob('/src/data/minecraft/worldgen/noise/**/*.json', { eager: true });
const densityFunctionFiles = import.meta.glob('/src/data/minecraft/worldgen/density_function/**/*.json', { eager: true });
const noiseSettingsFiles = import.meta.glob('/src/data/minecraft/worldgen/noise_settings/**/*.json', { eager: true });
const dimensionFiles = import.meta.glob('/src/data/minecraft/dimension/**/*.json', { eager: true });

// バージョン情報
const DEEPSLATE_VERSION = '0.27.2';
const VITE_VERSION = '5.x';

interface AppState {
  deepslateVersion: string;
  viteVersion: string;
  seed: string;
  centerBlockX: number;
  centerBlockZ: number;
  renderRadius: number;
  noiseCount: number;
  densityFunctionCount: number;
  noiseSettingsCount: number;
  dimensionCount: number;
  noiseRegistered: number;
  densityFunctionRegistered: number;
  biomesRegistered: number;
  currentSample: SampleResult | null;
  loadedChunksCount: number;
  totalChunksCount: number;
  totalVoxelBlocks: number;
  loadedChunkList: Array<{ chunkX: number; chunkZ: number; biome: string; timeMs: number }>;
  aggregatedBlockCounts: Record<string, number>;
  isXRayActive: boolean;
  cameraMode: 'orbit' | 'spectator';
  currentYCutoff: number;
  errors: string[];
}

const state: AppState = {
  deepslateVersion: DEEPSLATE_VERSION,
  viteVersion: VITE_VERSION,
  seed: '12345',
  centerBlockX: 100,
  centerBlockZ: -200,
  renderRadius: 1,
  noiseCount: Object.keys(noiseFiles).length,
  densityFunctionCount: Object.keys(densityFunctionFiles).length,
  noiseSettingsCount: Object.keys(noiseSettingsFiles).length,
  dimensionCount: Object.keys(dimensionFiles).length,
  noiseRegistered: 0,
  densityFunctionRegistered: 0,
  biomesRegistered: 0,
  currentSample: null,
  loadedChunksCount: 0,
  totalChunksCount: 9,
  totalVoxelBlocks: 0,
  loadedChunkList: [],
  aggregatedBlockCounts: {},
  isXRayActive: false,
  cameraMode: 'orbit',
  currentYCutoff: 320,
  errors: [],
};

// 画面要素の取得
const statusOutput = document.getElementById('status-output');
const errorBox = document.getElementById('error-box');
const copyReportBtn = document.getElementById('copy-report-btn');
const copyStatus = document.getElementById('copy-status');
const samplesTableBody = document.getElementById('samples-table-body');
const chunkMetaOutput = document.getElementById('chunk-meta-output');
const viewportContainer = document.getElementById('viewport-container');
const chunksProgressFill = document.getElementById('chunks-progress-fill');
const chunksStatusText = document.getElementById('chunks-status-text');

// 操作要素
const seedInput = document.getElementById('seed-input') as HTMLInputElement | null;
const coordXInput = document.getElementById('coord-x-input') as HTMLInputElement | null;
const coordZInput = document.getElementById('coord-z-input') as HTMLInputElement | null;
const teleportBtn = document.getElementById('teleport-btn');
const presetOceanBtn = document.getElementById('preset-ocean-btn');
const presetMountainBtn = document.getElementById('preset-mountain-btn');
const presetPlainsBtn = document.getElementById('preset-plains-btn');
const renderRadiusSelect = document.getElementById('render-radius-select') as HTMLSelectElement | null;
const xrayToggle = document.getElementById('xray-toggle') as HTMLInputElement | null;
const yCutoffSlider = document.getElementById('y-cutoff-slider') as HTMLInputElement | null;
const yCutoffValueText = document.getElementById('y-cutoff-val');
const cameraModeSelect = document.getElementById('camera-mode-select') as HTMLSelectElement | null;

// グローバルエラー監視
window.addEventListener('error', (event) => {
  const errorMsg = `[Global Error] ${event.message} at ${event.filename}:${event.lineno}:${event.colno}`;
  console.error(errorMsg, event.error);
  state.errors.push(errorMsg);
  render();
});

window.addEventListener('unhandledrejection', (event) => {
  const errorMsg = `[Unhandled Promise Rejection] ${String(event.reason)}`;
  console.error(errorMsg, event.reason);
  state.errors.push(errorMsg);
  render();
});

let viewer: Viewer3DInstance | null = null;
let chunkManager: ChunkManager | null = null;
let currentGeneratorHelper: InitializedGenerator | null = null;

function setupMainGenerator(seedString: string): InitializedGenerator {
  const seedBigInt = BigInt(seedString);
  const overworldNoiseSettingsModule = noiseSettingsFiles['/src/data/minecraft/worldgen/noise_settings/overworld.json'];
  const overworldDimensionModule = dimensionFiles['/src/data/minecraft/dimension/overworld.json'];

  return initializeOverworldGenerator(
    seedBigInt,
    overworldNoiseSettingsModule,
    overworldDimensionModule
  );
}

function navigateToCoordinates(blockX: number, blockZ: number, seedString: string, radius: number = state.renderRadius): void {
  try {
    state.centerBlockX = blockX;
    state.centerBlockZ = blockZ;
    state.renderRadius = radius;

    if (!currentGeneratorHelper || state.seed !== seedString) {
      state.seed = seedString;
      currentGeneratorHelper = setupMainGenerator(seedString);
    }

    const sample = currentGeneratorHelper.sampleCoordinate(blockX, blockZ);
    state.currentSample = sample;

    if (viewer) {
      viewer.clear();
      state.totalVoxelBlocks = 0;
      state.loadedChunksCount = 0;
      state.loadedChunkList = [];
      state.aggregatedBlockCounts = {};
      viewer.focusOn(blockX, sample.surfaceHeight, blockZ);
    }

    const centerChunkX = Math.floor(blockX / 16);
    const centerChunkZ = Math.floor(blockZ / 16);

    if (chunkManager) {
      chunkManager.loadAreaAround(centerChunkX, centerChunkZ, radius, seedString);
    }

    render();
  } catch (err: any) {
    const errorDetails = err?.stack ? String(err.stack) : String(err);
    console.error('テレポート生成中に例外が発生しました:', err);
    state.errors.push(errorDetails);
    render();
  }
}

// アプリ初期化
function initApp(): void {
  try {
    const regCounts = registerAllVanillaWorldgen(noiseFiles, densityFunctionFiles, dimensionFiles);
    state.noiseRegistered = regCounts.noiseRegistered;
    state.densityFunctionRegistered = regCounts.densityFunctionRegistered;
    state.biomesRegistered = regCounts.biomesRegistered;

    if (viewportContainer) {
      viewer = initWideArea3DViewer(viewportContainer);
    }

    chunkManager = new ChunkManager(state.seed, (chunkData: ChunkDataMessage, completed: number, total: number) => {
      state.loadedChunksCount = completed;
      state.totalChunksCount = total;

      if (viewer) {
        const counts = viewer.addChunk(
          chunkData.chunkX,
          chunkData.chunkZ,
          chunkData.opaqueBuffer,
          chunkData.waterBuffer,
          chunkData.lavaBuffer
        );
        state.totalVoxelBlocks += counts.opaqueCount + counts.waterCount + counts.lavaCount;
      }

      for (const [blockName, count] of Object.entries(chunkData.blockCounts)) {
        state.aggregatedBlockCounts[blockName] = (state.aggregatedBlockCounts[blockName] ?? 0) + count;
      }

      state.loadedChunkList.push({
        chunkX: chunkData.chunkX,
        chunkZ: chunkData.chunkZ,
        biome: chunkData.biome,
        timeMs: chunkData.generationTimeMs,
      });

      render();
    });

    // 初期位置: 山岳 (100, -200)
    navigateToCoordinates(100, -200, state.seed);

    if (teleportBtn && seedInput && coordXInput && coordZInput) {
      teleportBtn.addEventListener('click', () => {
        const x = parseInt(coordXInput.value, 10) || 0;
        const z = parseInt(coordZInput.value, 10) || 0;
        const s = seedInput.value.trim() || '12345';
        navigateToCoordinates(x, z, s);
      });
    }

    if (presetOceanBtn && coordXInput && coordZInput) {
      presetOceanBtn.addEventListener('click', () => {
        coordXInput.value = '0';
        coordZInput.value = '0';
        navigateToCoordinates(0, 0, seedInput?.value.trim() || '12345');
      });
    }

    if (presetMountainBtn && coordXInput && coordZInput) {
      presetMountainBtn.addEventListener('click', () => {
        coordXInput.value = '100';
        coordZInput.value = '-200';
        navigateToCoordinates(100, -200, seedInput?.value.trim() || '12345');
      });
    }

    if (presetPlainsBtn && coordXInput && coordZInput) {
      presetPlainsBtn.addEventListener('click', () => {
        coordXInput.value = '412';
        coordZInput.value = '-772';
        navigateToCoordinates(412, -772, seedInput?.value.trim() || '12345');
      });
    }

    if (renderRadiusSelect) {
      renderRadiusSelect.addEventListener('change', () => {
        const rad = parseInt(renderRadiusSelect.value, 10) || 1;
        state.renderRadius = rad;
        const x = parseInt(coordXInput?.value || '0', 10) || 0;
        const z = parseInt(coordZInput?.value || '0', 10) || 0;
        navigateToCoordinates(x, z, state.seed, rad);
      });
    }

    if (xrayToggle) {
      xrayToggle.addEventListener('change', () => {
        state.isXRayActive = xrayToggle.checked;
        if (viewer) {
          viewer.setXRayMode(state.isXRayActive);
        }
      });
    }

    if (yCutoffSlider && yCutoffValueText) {
      yCutoffSlider.addEventListener('input', () => {
        const val = parseInt(yCutoffSlider.value, 10);
        state.currentYCutoff = val;
        yCutoffValueText.textContent = `Y=${val}`;
        if (viewer) {
          viewer.setYCutoff(val);
        }
      });
    }

    if (cameraModeSelect) {
      cameraModeSelect.addEventListener('change', () => {
        state.cameraMode = cameraModeSelect.value as 'orbit' | 'spectator';
        if (viewer) {
          viewer.setCameraMode(state.cameraMode);
        }
      });
    }
  } catch (err: any) {
    const errorDetails = err?.stack ? String(err.stack) : String(err);
    console.error('初期化中に例外が発生しました:', err);
    state.errors.push(errorDetails);
    render();
  }
}

// デバッグレポート文字列の生成
function generateReport(): string {
  const s = state.currentSample;
  const sampleReport = s ? [
    `  [中心座標 (${s.x}, ${s.z})]`,
    `    バイオーム: ${s.biome}`,
    `    地表ベース高さ (WORLD_SURFACE_WG): Y=${s.surfaceHeight}`,
    `    海底ベース高さ (OCEAN_FLOOR_WG): Y=${s.oceanFloorHeight}`,
    `    Continentalness (大陸度 C): ${s.continentalness.toFixed(6)}`,
    `    Erosion (侵食度 E): ${s.erosion.toFixed(6)}`,
    `    Temperature (温度 T): ${s.temperature.toFixed(6)}`,
    `    Vegetation (湿度/植生 V): ${s.vegetation.toFixed(6)}`,
    `    Weirdness (尾根度 W): ${s.weirdness.toFixed(6)}`,
    `    Depth (深さ D): ${s.depth.toFixed(6)}`,
  ].join('\n') : '  (サンプリング未実行)';

  const chunkListReport = state.loadedChunkList
    .map((c) => `    チャンク (${c.chunkX}, ${c.chunkZ}): ${c.biome} (${c.timeMs.toFixed(1)} ms)`)
    .join('\n');

  const blockSummaryReport = Object.entries(state.aggregatedBlockCounts)
    .sort((a, b) => b[1] - a[1])
    .map(([name, count]) => `    ${name}: ${count.toLocaleString()} 個`)
    .join('\n');

  const radText = state.renderRadius === 1 ? '3×3 チャンク (48m×48m)' : '5×5 チャンク (80m×80m パノラマ)';

  return [
    '=== Minecraft 1.21 地形生成デバッグレポート (本家スペクテイター視界) ===',
    `Deepslate バージョン: ${state.deepslateVersion}`,
    `Vite バージョン: ${state.viteVersion}`,
    `シード値: ${state.seed}`,
    `中心ブロック座標: (${state.centerBlockX}, ${state.centerBlockZ})`,
    `中心チャンク座標: (${Math.floor(state.centerBlockX / 16)}, ${Math.floor(state.centerBlockZ / 16)})`,
    `描画範囲設定: ${radText}`,
    `カメラモード: ${state.cameraMode === 'spectator' ? 'スペクテイター飛行 (本家仕様・近接クリップ透過)' : 'オービット鳥瞰'}`,
    `常時X線透視モード: ${state.isXRayActive ? 'ON' : 'OFF'}`,
    `高さスライサー: Y=${state.currentYCutoff}`,
    '',
    '--- 3D 動的読み込み進捗 (Web Worker) ---',
    `  読み込み済みチャンク数: ${state.loadedChunksCount} / ${state.totalChunksCount}`,
    `  3D空間描画ボクセル数 (カリング後): ${state.totalVoxelBlocks.toLocaleString()} 個`,
    '  全チャンク合算ブロック内訳 (生成総数):',
    blockSummaryReport || '    (集計中...)',
    '  生成済みチャンク一覧:',
    chunkListReport || '    (読み込み中...)',
    '',
    '--- 中心座標サンプリング結果 ---',
    sampleReport,
    '',
    `エラー件数: ${state.errors.length}`,
    ...(state.errors.length > 0 ? ['直近のエラー詳細:', ...state.errors] : ['エラーなし']),
    '=========================================================================',
  ].join('\n');
}

// 画面描画
function render(): void {
  const reportText = generateReport();
  if (statusOutput) {
    statusOutput.textContent = reportText;
  }

  if (chunksProgressFill && chunksStatusText) {
    const percent = Math.min(100, Math.round((state.loadedChunksCount / state.totalChunksCount) * 100));
    chunksProgressFill.style.width = `${percent}%`;
    chunksStatusText.textContent = `${state.loadedChunksCount} / ${state.totalChunksCount} チャンク読み込み完了 (${state.totalVoxelBlocks.toLocaleString()} ボクセル描画中)`;
  }

  if (chunkMetaOutput) {
    const centerChunkX = Math.floor(state.centerBlockX / 16);
    const centerChunkZ = Math.floor(state.centerBlockZ / 16);
    const radText = state.renderRadius === 1 ? '3×3 (48m×48m)' : '5×5 (80m×80m)';
    chunkMetaOutput.textContent = `中心座標 (${state.centerBlockX}, ${state.centerBlockZ}) [チャンク: ${centerChunkX}, ${centerChunkZ}] | 範囲: ${radText} | 生成状況: ${state.loadedChunksCount} / ${state.totalChunksCount} | 表示ボクセル: ${state.totalVoxelBlocks.toLocaleString()} 個`;
  }

  if (samplesTableBody && state.currentSample) {
    const s = state.currentSample;
    samplesTableBody.innerHTML = `
      <tr>
        <td style="padding: 6px 12px; border: 1px solid #444;">(${s.x}, ${s.z})</td>
        <td style="padding: 6px 12px; border: 1px solid #444;"><strong>${s.biome}</strong></td>
        <td style="padding: 6px 12px; border: 1px solid #444;">${s.surfaceHeight}</td>
        <td style="padding: 6px 12px; border: 1px solid #444;">${s.oceanFloorHeight}</td>
        <td style="padding: 6px 12px; border: 1px solid #444;">${s.continentalness.toFixed(4)}</td>
        <td style="padding: 6px 12px; border: 1px solid #444;">${s.erosion.toFixed(4)}</td>
        <td style="padding: 6px 12px; border: 1px solid #444;">${s.temperature.toFixed(4)}</td>
        <td style="padding: 6px 12px; border: 1px solid #444;">${s.vegetation.toFixed(4)}</td>
      </tr>
    `;
  }

  if (errorBox) {
    if (state.errors.length > 0) {
      errorBox.style.display = 'block';
      errorBox.textContent = `エラーが発生しています (${state.errors.length}件):\n` + state.errors.join('\n');
    } else {
      errorBox.style.display = 'none';
      errorBox.textContent = '';
    }
  }
}

if (copyReportBtn) {
  copyReportBtn.addEventListener('click', async () => {
    try {
      const text = generateReport();
      await navigator.clipboard.writeText(text);
      if (copyStatus) {
        copyStatus.textContent = 'コピーしました！';
        setTimeout(() => {
          if (copyStatus) copyStatus.textContent = '';
        }, 2000);
      }
    } catch (err) {
      console.error('クリップボードのコピーに失敗しました', err);
      if (copyStatus) {
        copyStatus.textContent = 'コピー失敗（ブラウザの権限を確認してください）';
      }
    }
  });
}

initApp();
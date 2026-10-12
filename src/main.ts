import { registerAllVanillaWorldgen } from './worldgen-registries.js';
import { initializeOverworldGenerator, SampleResult, InitializedGenerator, MultiModeSampleResult } from './terrain-sampler.js';
import { ChunkManager, ChunkDataMessage } from './chunk-manager.js';
import { initWideArea3DViewer, Viewer3DInstance } from './renderer3d.js';

// バニラJSONファイルを一括インポート
const noiseFiles = import.meta.glob('/src/data/minecraft/worldgen/noise/**/*.json', { eager: true });
const densityFunctionFiles = import.meta.glob('/src/data/minecraft/worldgen/density_function/**/*.json', { eager: true });
const noiseSettingsFiles = import.meta.glob('/src/data/minecraft/worldgen/noise_settings/**/*.json', { eager: true });
const dimensionFiles = import.meta.glob('/src/data/minecraft/dimension/**/*.json', { eager: true });

// バージョン情報
const DEEPSLATE_VERSION = '0.27.2';
const VITE_VERSION = '5.x';

interface F3InputValues {
  t: number;
  v: number;
  c: number;
  e: number;
  d: number;
  w: number;
  pv: number;
}

interface AppState {
  deepslateVersion: string;
  viteVersion: string;
  seed: string;
  centerBlockX: number;
  centerBlockY: number;
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
  multiModeResult: MultiModeSampleResult | null;
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
  centerBlockX: -2423,
  centerBlockY: 149,
  centerBlockZ: 885,
  renderRadius: 1,
  noiseCount: Object.keys(noiseFiles).length,
  densityFunctionCount: Object.keys(densityFunctionFiles).length,
  noiseSettingsCount: Object.keys(noiseSettingsFiles).length,
  dimensionCount: Object.keys(dimensionFiles).length,
  noiseRegistered: 0,
  densityFunctionRegistered: 0,
  biomesRegistered: 0,
  currentSample: null,
  multiModeResult: null,
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
const diffTableBody = document.getElementById('diff-table-body');
const modesTableBody = document.getElementById('modes-table-body');
const gridTableBody = document.getElementById('grid-table-body');
const chunkMetaOutput = document.getElementById('chunk-meta-output');
const viewportContainer = document.getElementById('viewport-container');
const chunksProgressFill = document.getElementById('chunks-progress-fill');
const chunksStatusText = document.getElementById('chunks-status-text');

// 操作要素
const seedInput = document.getElementById('seed-input') as HTMLInputElement | null;
const coordXInput = document.getElementById('coord-x-input') as HTMLInputElement | null;
const coordYInput = document.getElementById('coord-y-input') as HTMLInputElement | null;
const coordZInput = document.getElementById('coord-z-input') as HTMLInputElement | null;
const teleportBtn = document.getElementById('teleport-btn');
const calcDiffBtn = document.getElementById('calc-diff-btn');
const renderRadiusSelect = document.getElementById('render-radius-select') as HTMLSelectElement | null;
const xrayToggle = document.getElementById('xray-toggle') as HTMLInputElement | null;
const yCutoffSlider = document.getElementById('y-cutoff-slider') as HTMLInputElement | null;
const yCutoffValueText = document.getElementById('y-cutoff-val');
const cameraModeSelect = document.getElementById('camera-mode-select') as HTMLSelectElement | null;

// F3入力要素
const f3Inputs = {
  t: document.getElementById('f3-t-input') as HTMLInputElement | null,
  v: document.getElementById('f3-v-input') as HTMLInputElement | null,
  c: document.getElementById('f3-c-input') as HTMLInputElement | null,
  e: document.getElementById('f3-e-input') as HTMLInputElement | null,
  d: document.getElementById('f3-d-input') as HTMLInputElement | null,
  w: document.getElementById('f3-w-input') as HTMLInputElement | null,
  pv: document.getElementById('f3-pv-input') as HTMLInputElement | null,
};

function getF3InputValues(): F3InputValues {
  return {
    t: parseFloat(f3Inputs.t?.value ?? '0') || 0,
    v: parseFloat(f3Inputs.v?.value ?? '0') || 0,
    c: parseFloat(f3Inputs.c?.value ?? '0') || 0,
    e: parseFloat(f3Inputs.e?.value ?? '0') || 0,
    d: parseFloat(f3Inputs.d?.value ?? '0') || 0,
    w: parseFloat(f3Inputs.w?.value ?? '0') || 0,
    pv: parseFloat(f3Inputs.pv?.value ?? '0') || 0,
  };
}

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

function navigateToCoordinates(blockX: number, blockZ: number, seedString: string, blockY: number = 149, radius: number = state.renderRadius): void {
  try {
    state.centerBlockX = blockX;
    state.centerBlockY = blockY;
    state.centerBlockZ = blockZ;
    state.renderRadius = radius;

    if (!currentGeneratorHelper || state.seed !== seedString) {
      state.seed = seedString;
      currentGeneratorHelper = setupMainGenerator(seedString);
    }

    const sample = currentGeneratorHelper.sampleCoordinate(blockX, blockZ, blockY);
    state.currentSample = sample;
    state.multiModeResult = currentGeneratorHelper.sampleMultiMode(blockX, blockY, blockZ);

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

    // 初期位置: 地点1 (-2423, Y=149, 885)
    navigateToCoordinates(-2423, 885, state.seed, 149);

    if (teleportBtn && seedInput && coordXInput && coordYInput && coordZInput) {
      teleportBtn.addEventListener('click', () => {
        const x = parseInt(coordXInput.value, 10) || 0;
        const y = parseInt(coordYInput.value, 10) || 149;
        const z = parseInt(coordZInput.value, 10) || 0;
        const s = seedInput.value.trim() || '12345';
        navigateToCoordinates(x, z, s, y);
      });
    }

    if (calcDiffBtn) {
      calcDiffBtn.addEventListener('click', () => {
        render();
      });
    }

    if (renderRadiusSelect) {
      renderRadiusSelect.addEventListener('change', () => {
        const rad = parseInt(renderRadiusSelect.value, 10) || 1;
        state.renderRadius = rad;
        navigateToCoordinates(state.centerBlockX, state.centerBlockZ, state.seed, state.centerBlockY, rad);
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
  const f3 = getF3InputValues();

  const sampleReport = s ? [
    `  [サンプリング座標 (${s.x}, Y=${s.y}, ${s.z})]`,
    `    高度Y=${s.y} でのバイオーム: ${s.biome}`,
    `    地表(Y=${s.surfaceHeight})でのバイオーム: ${s.surfaceBiome}`,
    `    地表ベース高さ (WORLD_SURFACE_WG): Y=${s.surfaceHeight}`,
    `    海底ベース高さ (OCEAN_FLOOR_WG): Y=${s.oceanFloorHeight}`,
    '',
    `    --- 【本家F3 NoiseRouter 値との自動差分 (アプリ値 − F3)】 ---`,
    `    Temperature (T):  アプリ=${s.temperature.toFixed(4)}  F3=${f3.t.toFixed(4)}  差分=${(s.temperature - f3.t).toFixed(4)}`,
    `    Vegetation (V):   アプリ=${s.vegetation.toFixed(4)}  F3=${f3.v.toFixed(4)}  差分=${(s.vegetation - f3.v).toFixed(4)}`,
    `    Continentalness(C):アプリ=${s.continentalness.toFixed(4)} F3=${f3.c.toFixed(4)}  差分=${(s.continentalness - f3.c).toFixed(4)}`,
    `    Erosion (E):      アプリ=${s.erosion.toFixed(4)}  F3=${f3.e.toFixed(4)}  差分=${(s.erosion - f3.e).toFixed(4)}`,
    `    Depth (D):        アプリ=${s.depth.toFixed(4)}  F3=${f3.d.toFixed(4)}  差分=${(s.depth - f3.d).toFixed(4)}`,
    `    Weirdness (W):    アプリ=${s.weirdness.toFixed(4)}  F3=${f3.w.toFixed(4)}  差分=${(s.weirdness - f3.w).toFixed(4)}`,
    `    Peaks&Valleys(PV):アプリ=${s.peaksAndValleys.toFixed(4)} F3=${f3.pv.toFixed(4)} 差分=${(s.peaksAndValleys - f3.pv).toFixed(4)}`,
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
    '=== Minecraft 1.21 地形生成デバッグレポート (F3 検証モード) ===',
    `Deepslate バージョン: ${state.deepslateVersion}`,
    `Vite バージョン: ${state.viteVersion}`,
    `シード値: ${state.seed}`,
    `中心ブロック座標: (${state.centerBlockX}, Y=${state.centerBlockY}, ${state.centerBlockZ})`,
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
    '--- サンプリング点 気候・バイオーム診断 ---',
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
    chunkMetaOutput.textContent = `中心座標 (${state.centerBlockX}, Y=${state.centerBlockY}, ${state.centerBlockZ}) [チャンク: ${centerChunkX}, ${centerChunkZ}] | 範囲: ${radText} | 生成状況: ${state.loadedChunksCount} / ${state.totalChunksCount} | 表示ボクセル: ${state.totalVoxelBlocks.toLocaleString()} 個`;
  }

  const f3 = getF3InputValues();

  // 機能A: 自動差分表の描画
  if (diffTableBody && state.currentSample) {
    const s = state.currentSample;
    const diffs = [
      { name: 'Temperature (T)', f3: f3.t, app: s.temperature },
      { name: 'Vegetation (V)', f3: f3.v, app: s.vegetation },
      { name: 'Continentalness (C)', f3: f3.c, app: s.continentalness },
      { name: 'Erosion (E)', f3: f3.e, app: s.erosion },
      { name: 'Depth (D)', f3: f3.d, app: s.depth },
      { name: 'Weirdness (W)', f3: f3.w, app: s.weirdness },
      { name: 'Peaks & Valleys (PV)', f3: f3.pv, app: s.peaksAndValleys },
    ];

    diffTableBody.innerHTML = diffs.map((row) => {
      const diff = row.app - row.f3;
      return `
        <tr>
          <td><strong>${row.name}</strong></td>
          <td>${row.f3.toFixed(4)}</td>
          <td>${row.app.toFixed(4)}</td>
          <td style="color: ${Math.abs(diff) < 0.005 ? '#4ec9b0' : '#ce9178'};">${diff >= 0 ? '+' : ''}${diff.toFixed(4)}</td>
        </tr>
      `;
    }).join('');
  }

  // 機能B: 3通りの計算方式の並列比較描画
  if (modesTableBody && state.multiModeResult) {
    const m = state.multiModeResult;
    const modes = [
      { label: '1) 標準 (ブロック座標そのまま)', val: m.standard },
      { label: '2) Quart切り捨て ((x>>2)<<2)', val: m.quartTruncated },
    ];

    modesTableBody.innerHTML = modes.map((mode) => `
      <tr>
        <td><strong>${mode.label}</strong></td>
        <td>${mode.val.temperature.toFixed(4)}</td>
        <td>${mode.val.vegetation.toFixed(4)}</td>
        <td>${mode.val.continentalness.toFixed(4)}</td>
        <td>${mode.val.erosion.toFixed(4)}</td>
        <td>${mode.val.depth.toFixed(4)}</td>
        <td>${mode.val.weirdness.toFixed(4)}</td>
      </tr>
    `).join('');
  }

  // 機能B-2: 周辺グリッド探索描画
  if (gridTableBody && state.multiModeResult) {
    const items = state.multiModeResult.gridSearch;
    gridTableBody.innerHTML = items.map((item) => {
      const v = item.values;
      const score = Math.pow(v.temperature - f3.t, 2) + Math.pow(v.continentalness - f3.c, 2);
      const isClose = score < 0.0005;
      return `
        <tr style="background-color: ${isClose ? 'rgba(78, 201, 176, 0.2)' : 'transparent'};">
          <td>dx:${item.dx}, dy:${item.dy}, dz:${item.dz}</td>
          <td>${v.temperature.toFixed(4)}</td>
          <td>${v.vegetation.toFixed(4)}</td>
          <td>${v.continentalness.toFixed(4)}</td>
          <td>${v.erosion.toFixed(4)}</td>
          <td>${v.depth.toFixed(4)}</td>
        </tr>
      `;
    }).join('');
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
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';

export interface Viewer3DInstance {
  addChunk: (
    chunkX: number,
    chunkZ: number,
    opaqueBuffer: Float32Array,
    waterBuffer: Float32Array,
    lavaBuffer: Float32Array
  ) => { opaqueCount: number; waterCount: number; lavaCount: number };
  clear: () => void;
  focusOn: (targetBlockX: number, targetBlockY: number, targetBlockZ: number) => void;
  setXRayMode: (enabled: boolean) => void;
  setYCutoff: (cutoffY: number) => void;
  setCameraMode: (mode: 'orbit' | 'spectator') => void;
  dispose: () => void;
}

/**
 * Three.js 3D広域ビューア (スペースキー・スクロール防止＆水の描画順序最適化)
 */
export function initWideArea3DViewer(container: HTMLElement): Viewer3DInstance {
  container.innerHTML = '';

  const width = container.clientWidth || 800;
  const height = container.clientHeight || 560;

  // 1. シーンと距離フォグの作成
  const scene = new THREE.Scene();
  const bgColor = 0x141419;
  scene.background = new THREE.Color(bgColor);
  scene.fog = new THREE.Fog(bgColor, 90, 320);

  // 2. カメラの作成
  const camera = new THREE.PerspectiveCamera(55, width / height, 0.1, 3000);
  camera.position.set(65, 120, 85);

  // 3. レンダラーの作成
  const renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setSize(width, height);
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.localClippingEnabled = true;
  container.appendChild(renderer.domElement);

  // 4. オービットカメラ操作 (鳥瞰モード)
  const orbitControls = new OrbitControls(camera, renderer.domElement);
  orbitControls.target.set(8, 35, 8);
  orbitControls.enableDamping = true;
  orbitControls.dampingFactor = 0.05;
  orbitControls.maxDistance = 800;
  orbitControls.minDistance = 2;

  // 5. ランタン照明・太陽光
  const lanternLight = new THREE.PointLight(0xffdf90, 2.5, 70, 1.2);
  scene.add(lanternLight);

  const ambientLight = new THREE.AmbientLight(0xffffff, 0.65);
  scene.add(ambientLight);

  const sunLight = new THREE.DirectionalLight(0xffffff, 0.9);
  sunLight.position.set(100, 180, 80);
  scene.add(sunLight);

  const fillLight = new THREE.DirectionalLight(0xaaccff, 0.3);
  fillLight.position.set(-80, -60, -60);
  scene.add(fillLight);

  // 6. 水平断面クリッピングプレーン
  let currentCutoffY = 320;
  const clippingPlane = new THREE.Plane(new THREE.Vector3(0, -1, 0), currentCutoffY);

  // 7. チャンク群を保持する親グループ
  const chunksGroup = new THREE.Group();
  scene.add(chunksGroup);

  const boxGeometry = new THREE.BoxGeometry(1, 1, 1);
  const dummy = new THREE.Object3D();

  const opaqueMaterials: THREE.MeshLambertMaterial[] = [];
  let isManualXRay = false;
  let currentRenderTransparent = false;
  let currentCameraMode: 'orbit' | 'spectator' = 'orbit';

  const keysDown: Record<string, boolean> = {
    KeyW: false,
    KeyS: false,
    KeyA: false,
    KeyD: false,
    Space: false,
    ShiftLeft: false,
    ShiftRight: false,
  };

  let euler = new THREE.Euler(0, 0, 0, 'YXZ');
  let isMouseDown = false;
  let previousMouseX = 0;
  let previousMouseY = 0;

  renderer.domElement.addEventListener('mousedown', (e) => {
    isMouseDown = true;
    previousMouseX = e.clientX;
    previousMouseY = e.clientY;
  });

  window.addEventListener('mouseup', () => {
    isMouseDown = false;
  });

  window.addEventListener('mousemove', (e) => {
    if (currentCameraMode !== 'spectator' || !isMouseDown) return;

    const deltaX = e.clientX - previousMouseX;
    const deltaY = e.clientY - previousMouseY;
    previousMouseX = e.clientX;
    previousMouseY = e.clientY;

    euler.setFromQuaternion(camera.quaternion);
    euler.y -= deltaX * 0.003;
    euler.x -= deltaY * 0.003;
    euler.x = Math.max(-Math.PI / 2 + 0.02, Math.min(Math.PI / 2 - 0.02, euler.x));
    camera.quaternion.setFromEuler(euler);
  });

  // キーボードイベント (Spaceキーのブラウザスクロールを完全ブロック)
  window.addEventListener('keydown', (e) => {
    if (e.code === 'Space' || e.code.startsWith('Key') || e.code.includes('Shift')) {
      if (e.code === 'Space') {
        e.preventDefault(); // ページが下にスクロールするのを防ぐ
      }
      keysDown[e.code] = true;
    }
  });

  window.addEventListener('keyup', (e) => {
    if (e.code in keysDown) {
      keysDown[e.code] = false;
    }
  });

  function applyTransparency(transparent: boolean): void {
    if (currentRenderTransparent === transparent) return;
    currentRenderTransparent = transparent;

    for (const mat of opaqueMaterials) {
      mat.transparent = transparent;
      mat.opacity = transparent ? 0.20 : 1.0;
      mat.depthWrite = !transparent;
      mat.needsUpdate = true;
    }
  }

  function addChunk(
    chunkX: number,
    chunkZ: number,
    opaqueBuffer: Float32Array,
    waterBuffer: Float32Array,
    lavaBuffer: Float32Array
  ): { opaqueCount: number; waterCount: number; lavaCount: number } {
    const chunkGroup = new THREE.Group();

    // (A) 不透明ブロック
    const opaqueCount = opaqueBuffer.length / 4;
    if (opaqueCount > 0) {
      const opaqueMaterial = new THREE.MeshLambertMaterial({
        clippingPlanes: [clippingPlane],
        clipShadows: true,
        transparent: currentRenderTransparent,
        opacity: currentRenderTransparent ? 0.22 : 1.0,
        depthWrite: !currentRenderTransparent,
        side: THREE.FrontSide,
      });
      opaqueMaterials.push(opaqueMaterial);

      const opaqueMesh = new THREE.InstancedMesh(boxGeometry, opaqueMaterial, opaqueCount);
      opaqueMesh.renderOrder = 1;

      for (let i = 0; i < opaqueCount; i++) {
        const x = opaqueBuffer[i * 4];
        const y = opaqueBuffer[i * 4 + 1];
        const z = opaqueBuffer[i * 4 + 2];
        const color = opaqueBuffer[i * 4 + 3];

        dummy.position.set(x, y, z);
        dummy.updateMatrix();
        opaqueMesh.setMatrixAt(i, dummy.matrix);
        opaqueMesh.setColorAt(i, new THREE.Color(color));
      }
      opaqueMesh.instanceMatrix.needsUpdate = true;
      if (opaqueMesh.instanceColor) opaqueMesh.instanceColor.needsUpdate = true;
      chunkGroup.add(opaqueMesh);
    }

    // (B) 半透明水ブロック (描画順序と深度書き込みを安定化し、消えたり濃くなったりする現象を防止)
    const waterCount = waterBuffer.length / 3;
    if (waterCount > 0) {
      const waterMaterial = new THREE.MeshLambertMaterial({
        color: 0x2979ff,
        transparent: true,
        opacity: 0.60,
        depthWrite: true, // 水の前後関係を正確に計算させる
        clippingPlanes: [clippingPlane],
        side: THREE.FrontSide,
      });
      const waterMesh = new THREE.InstancedMesh(boxGeometry, waterMaterial, waterCount);
      waterMesh.renderOrder = 2; // 不透明のあとに確実に描画

      for (let i = 0; i < waterCount; i++) {
        const x = waterBuffer[i * 3];
        const y = waterBuffer[i * 3 + 1];
        const z = waterBuffer[i * 3 + 2];

        dummy.position.set(x, y, z);
        dummy.updateMatrix();
        waterMesh.setMatrixAt(i, dummy.matrix);
      }
      waterMesh.instanceMatrix.needsUpdate = true;
      chunkGroup.add(waterMesh);
    }

    // (C) 発光溶岩ブロック
    const lavaCount = lavaBuffer.length / 3;
    if (lavaCount > 0) {
      const lavaMaterial = new THREE.MeshLambertMaterial({
        color: 0xff5500,
        emissive: 0xff3300,
        emissiveIntensity: 0.95,
        clippingPlanes: [clippingPlane],
        side: THREE.FrontSide,
      });
      const lavaMesh = new THREE.InstancedMesh(boxGeometry, lavaMaterial, lavaCount);
      lavaMesh.renderOrder = 1;

      for (let i = 0; i < lavaCount; i++) {
        const x = lavaBuffer[i * 3];
        const y = lavaBuffer[i * 3 + 1];
        const z = lavaBuffer[i * 3 + 2];

        dummy.position.set(x, y, z);
        dummy.updateMatrix();
        lavaMesh.setMatrixAt(i, dummy.matrix);
      }
      lavaMesh.instanceMatrix.needsUpdate = true;
      chunkGroup.add(lavaMesh);
    }

    // (D) ワイヤーフレーム
    const chunkBoxGeo = new THREE.BoxGeometry(16.02, 384.02, 16.02);
    const wireMat = new THREE.LineBasicMaterial({
      color: 0x555566,
      transparent: true,
      opacity: 0.22,
      depthWrite: false,
      clippingPlanes: [clippingPlane],
    });
    const wireframe = new THREE.LineSegments(new THREE.EdgesGeometry(chunkBoxGeo), wireMat);
    wireframe.position.set(chunkX * 16 + 8, -64 + 192, chunkZ * 16 + 8);
    chunkGroup.add(wireframe);

    chunksGroup.add(chunkGroup);

    return { opaqueCount, waterCount, lavaCount };
  }

  function clear(): void {
    opaqueMaterials.length = 0;
    while (chunksGroup.children.length > 0) {
      const child = chunksGroup.children[0];
      chunksGroup.remove(child);
    }
  }

  function focusOn(targetBlockX: number, targetBlockY: number, targetBlockZ: number): void {
    orbitControls.target.set(targetBlockX, targetBlockY, targetBlockZ);
    camera.position.set(targetBlockX + 65, targetBlockY + 80, targetBlockZ + 75);
    orbitControls.update();
  }

  function setXRayMode(enabled: boolean): void {
    isManualXRay = enabled;
    applyTransparency(enabled || currentCameraMode === 'spectator');
  }

  function setYCutoff(cutoffY: number): void {
    currentCutoffY = cutoffY;
    clippingPlane.constant = cutoffY;
  }

  function setCameraMode(mode: 'orbit' | 'spectator'): void {
    currentCameraMode = mode;
    if (mode === 'orbit') {
      orbitControls.enabled = true;
      camera.near = 0.1;
      camera.updateProjectionMatrix();
      applyTransparency(isManualXRay);
    } else {
      orbitControls.enabled = false;
      camera.near = 1.0;
      camera.updateProjectionMatrix();
      euler.setFromQuaternion(camera.quaternion);
      applyTransparency(true);
    }
  }

  let animId: number;
  let lastTime = performance.now();

  function animate(): void {
    animId = requestAnimationFrame(animate);
    const now = performance.now();
    const dt = Math.min((now - lastTime) / 1000, 0.1);
    lastTime = now;

    if (currentCameraMode === 'orbit') {
      orbitControls.update();
    } else {
      const flySpeed = 45.0 * dt;
      const moveVector = new THREE.Vector3();

      if (keysDown.KeyW) moveVector.z -= 1;
      if (keysDown.KeyS) moveVector.z += 1;
      if (keysDown.KeyA) moveVector.x -= 1;
      if (keysDown.KeyD) moveVector.x += 1;

      moveVector.normalize();
      moveVector.applyQuaternion(camera.quaternion);

      if (keysDown.Space) moveVector.y += 1;
      if (keysDown.ShiftLeft || keysDown.ShiftRight) moveVector.y -= 1;

      camera.position.addScaledVector(moveVector, flySpeed);
    }

    lanternLight.position.copy(camera.position);
    renderer.render(scene, camera);
  }
  animate();

  const onResize = (): void => {
    const newWidth = container.clientWidth;
    const newHeight = container.clientHeight;
    camera.aspect = newWidth / newHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(newWidth, newHeight);
  };
  window.addEventListener('resize', onResize);

  function dispose(): void {
    cancelAnimationFrame(animId);
    window.removeEventListener('resize', onResize);
    renderer.dispose();
  }

  return {
    addChunk,
    clear,
    focusOn,
    setXRayMode,
    setYCutoff,
    setCameraMode,
    dispose,
  };
}
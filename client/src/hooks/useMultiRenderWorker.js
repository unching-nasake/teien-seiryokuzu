import { useCallback, useEffect, useRef, useState } from "react";
import RenderWorker from "../workers/renderWorker.js?worker";

/**
 * Multi-Threaded Render Worker Hook with True Double Buffering
 * Each worker has TWO canvases (front/back) and alternates between them.
 */
export const useMultiRenderWorker = (
  tileData,
  factions,
  alliances,
  playerColors,
  theme,
) => {
  const workerRefs = useRef([]); // Array of Worker instances
  const [workerReady, setWorkerReady] = useState(false);

  // [NEW] Unified Rendering: 共有のフロント/バックキャンバス
  const frontCanvasRef = useRef(null);
  const backCanvasRef = useRef(null);
  const containerRef = useRef(null);
  const pendingBitmapsRef = useRef([]); // 現在のRenderIdで収集したビットマップ
  const activeBufferRef = useRef(0); // 0 = front visible, 1 = back visible
  const renderIdRef = useRef(0); // 各レンダリング要求のID
  const currentDimensionsRef = useRef({ width: 0, height: 0 });

  // Determine number of workers
  const concurrency =
    typeof navigator !== "undefined" ? navigator.hardwareConcurrency || 4 : 4;
  // [OPTIMIZED] vCPU数が4未満の場合は全コア、4以上の場合はUIスレッド用に1コア空ける
  const WORKER_COUNT = concurrency < 4 ? concurrency : concurrency - 1;

  // [NEW] バッファスワップ関数 - visibility切り替え
  const swapBuffers = useCallback((renderId) => {
    if (renderId !== renderIdRef.current) return;

    if (activeBufferRef.current === 0) {
      frontCanvasRef.current.style.visibility = "hidden";
      backCanvasRef.current.style.visibility = "visible";
      activeBufferRef.current = 1;
    } else {
      backCanvasRef.current.style.visibility = "hidden";
      frontCanvasRef.current.style.visibility = "visible";
      activeBufferRef.current = 0;
    }
  }, []);

  // Initialize Workers and Shared Canvases
  const initWorkers = useCallback(
    (container) => {
      if (workerRefs.current.length > 0) return;

      console.log(
        `[useMultiRenderWorker] Initializing ${WORKER_COUNT} workers with Unified BitMap Rendering.`,
      );

      containerRef.current = container;
      container.innerHTML = "";

      // 共有フロントキャンバス
      const frontCanvas = document.createElement("canvas");
      frontCanvas.style.position = "absolute";
      frontCanvas.style.top = "0";
      frontCanvas.style.left = "0";
      frontCanvas.style.width = "100%";
      frontCanvas.style.height = "100%";
      frontCanvas.style.pointerEvents = "none";
      frontCanvas.style.visibility = "visible";
      container.appendChild(frontCanvas);
      frontCanvasRef.current = frontCanvas;

      // 共有バックキャンバス
      const backCanvas = document.createElement("canvas");
      backCanvas.style.position = "absolute";
      backCanvas.style.top = "0";
      backCanvas.style.left = "0";
      backCanvas.style.width = "100%";
      backCanvas.style.height = "100%";
      backCanvas.style.pointerEvents = "none";
      backCanvas.style.visibility = "hidden";
      container.appendChild(backCanvas);
      backCanvasRef.current = backCanvas;

      const newWorkers = [];
      for (let i = 0; i < WORKER_COUNT; i++) {
        const worker = new RenderWorker();

        // Setup worker index
        worker.postMessage({
          type: "SETUP_WORKER",
          data: { workerIndex: i, totalWorkers: WORKER_COUNT },
        });

        // 描画完了メッセージのリスナー
        worker.onmessage = (e) => {
          const {
            type,
            renderId: workerRenderId,
            bitmap,
            workerIndex,
          } = e.data;

          if (type === "RENDER_BITMAP_COMPLETE") {
            // ステイルなリクエストを無視
            if (workerRenderId !== renderIdRef.current) {
              if (bitmap) bitmap.close(); // 不要なリソースを解放
              return;
            }

            // ビットマップを蓄積
            pendingBitmapsRef.current.push({ bitmap, workerIndex });

            // 全てのワーカーからパーツが揃ったら合成
            if (pendingBitmapsRef.current.length === WORKER_COUNT) {
              compositeAndSwap(workerRenderId);
            }
          }
        };

        newWorkers.push(worker);
      }

      workerRefs.current = newWorkers;
      setWorkerReady(true);
    },
    [WORKER_COUNT],
  );

  // [NEW] ビットマップを合成して表示を切り替える
  const compositeAndSwap = useCallback(
    (renderId) => {
      const bitmaps = pendingBitmapsRef.current;
      if (bitmaps.length !== WORKER_COUNT) return;

      // 現在のバックバッファを取得
      const targetCanvas =
        activeBufferRef.current === 0
          ? backCanvasRef.current
          : frontCanvasRef.current;
      if (!targetCanvas) return;
      const ctx = targetCanvas.getContext("2d");
      const { width, height } = currentDimensionsRef.current;

      // クリア & 背景塗りつぶし (ここで一括で行うことでワーカー間の隙間を防ぐ)
      ctx.imageSmoothingEnabled = false;
      ctx.fillStyle = "#000000"; // マップ外は黒にする
      ctx.fillRect(0, 0, width, height);

      // 全パーツを合成 (背景色の描画はワーカー側で行われている前提)
      // 順序は関係ない（インターリーブされているため）
      bitmaps.forEach(({ bitmap }) => {
        ctx.drawImage(bitmap, 0, 0);
        bitmap.close(); // 合成後に解放
      });

      pendingBitmapsRef.current = [];
      swapBuffers(renderId);
    },
    [WORKER_COUNT, swapBuffers],
  );

  // Terminate on unmount
  useEffect(() => {
    return () => {
      workerRefs.current.forEach((w) => w.terminate());
      workerRefs.current = [];
    };
  }, []);

  // Broadcast helpers
  const broadcast = useCallback((msg, transfer = []) => {
    workerRefs.current.forEach((w) => w.postMessage(msg, transfer));
  }, []);

  // Sync Data when changed
  useEffect(() => {
    if (!workerReady) return;

    broadcast({
      type: "UPDATE_DATA",
      data: { theme },
    });
  }, [workerReady, broadcast, theme]);

  useEffect(() => {
    if (!workerReady) return;

    broadcast({
      type: "UPDATE_DATA",
      data: {
        factions,
        alliances,
        playerColors,
      },
    });
  }, [workerReady, broadcast, factions, alliances, playerColors]);

  // Separate Effect for Tiles (Heavy)
  const updateTiles = useCallback(
    (tiles, replace = false) => {
      if (workerRefs.current.length === 0) return;

      broadcast({
        type: "UPDATE_TILES",
        data: {
          tiles,
          replace,
          sab: tileData?.sab,
          zocSab: tileData?.zocSab,
          statsSab: tileData?.statsSab,
          factionsList: tileData?.factionsList,
          playersList: tileData?.playersList,
          mapSize: tileData?.mapSize,
          mapVersion: theme.mapVersion,
        },
      });
    },
    [broadcast, tileData, theme.mapVersion],
  );

  // Resizer
  const resize = useCallback((width, height) => {
    currentDimensionsRef.current = { width, height };
    if (frontCanvasRef.current) {
      frontCanvasRef.current.width = width;
      frontCanvasRef.current.height = height;
    }
    if (backCanvasRef.current) {
      backCanvasRef.current.width = width;
      backCanvasRef.current.height = height;
    }
    // Workers don't need explicit resize dual anymore if we use initInternal/renderInternal
  }, []);

  // [NEW] スロットリング用 - 最小レンダリング間隔 (ms)
  const MIN_RENDER_INTERVAL = 16; // ~60fps
  const lastRenderTimeRef = useRef(0);

  // Render Trigger
  const render = useCallback(
    (viewport, width, height) => {
      const now = performance.now();
      const elapsed = now - lastRenderTimeRef.current;

      if (
        elapsed < MIN_RENDER_INTERVAL &&
        pendingBitmapsRef.current.length > 0
      ) {
        return;
      }

      lastRenderTimeRef.current = now;
      renderIdRef.current++;
      const renderId = renderIdRef.current;

      // 不要な古いビットマップがあれば破棄
      pendingBitmapsRef.current.forEach(({ bitmap }) => bitmap.close());
      pendingBitmapsRef.current = [];

      broadcast({
        type: "RENDER_IMAGE_BITMAP",
        data: { viewport, width, height, renderId },
      });
    },
    [broadcast],
  );

  const renderChunks = useCallback((data) => {
    // Not implemented for unified mode yet, but could be similar
  }, []);

  return {
    initWorkers,
    updateTiles,
    resize,
    render,
    renderChunks,
    workerReady,
    workerCount: WORKER_COUNT,
  };
};

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

  // [NEW] True Double Buffering: 各ワーカーに2つのキャンバス
  const frontCanvasesRef = useRef([]); // フロントバッファキャンバス配列
  const backCanvasesRef = useRef([]); // バックバッファキャンバス配列
  const containerRef = useRef(null);
  const pendingRendersRef = useRef(0);
  const activeBufferRef = useRef(0); // 0 = front visible, 1 = back visible
  const renderIdRef = useRef(0); // 各レンダリング要求のID

  // Determine number of workers
  const concurrency =
    typeof navigator !== "undefined" ? navigator.hardwareConcurrency || 4 : 4;
  const WORKER_COUNT = Math.max(1, concurrency);

  // [NEW] バッファスワップ関数 - visibility切り替え
  const swapBuffers = useCallback((renderId) => {
    // 古いレンダリング要求は無視
    if (renderId !== renderIdRef.current) return;

    const frontCanvases = frontCanvasesRef.current;
    const backCanvases = backCanvasesRef.current;

    if (activeBufferRef.current === 0) {
      // フロントが表示中 -> バックを表示
      frontCanvases.forEach((c) => (c.style.visibility = "hidden"));
      backCanvases.forEach((c) => (c.style.visibility = "visible"));
      activeBufferRef.current = 1;
    } else {
      // バックが表示中 -> フロントを表示
      backCanvases.forEach((c) => (c.style.visibility = "hidden"));
      frontCanvases.forEach((c) => (c.style.visibility = "visible"));
      activeBufferRef.current = 0;
    }
  }, []);

  // Initialize Workers with dual canvas sets
  const initWorkers = useCallback(
    (container) => {
      if (workerRefs.current.length > 0) return; // Already initialized

      console.log(
        `[useMultiRenderWorker] Initializing ${WORKER_COUNT} workers with true double buffering.`,
      );

      containerRef.current = container;
      container.innerHTML = "";

      const newWorkers = [];
      const frontCanvases = [];
      const backCanvases = [];

      for (let i = 0; i < WORKER_COUNT; i++) {
        const worker = new RenderWorker();

        // フロントバッファキャンバス
        const frontCanvas = document.createElement("canvas");
        frontCanvas.style.position = "absolute";
        frontCanvas.style.top = "0";
        frontCanvas.style.left = "0";
        frontCanvas.style.width = "100%";
        frontCanvas.style.height = "100%";
        frontCanvas.style.pointerEvents = "none";
        frontCanvas.style.visibility = "visible"; // 初期表示
        frontCanvas.id = `map-layer-front-${i}`;
        container.appendChild(frontCanvas);
        frontCanvases.push(frontCanvas);

        // バックバッファキャンバス
        const backCanvas = document.createElement("canvas");
        backCanvas.style.position = "absolute";
        backCanvas.style.top = "0";
        backCanvas.style.left = "0";
        backCanvas.style.width = "100%";
        backCanvas.style.height = "100%";
        backCanvas.style.pointerEvents = "none";
        backCanvas.style.visibility = "hidden"; // 初期非表示
        backCanvas.id = `map-layer-back-${i}`;
        container.appendChild(backCanvas);
        backCanvases.push(backCanvas);

        // 両方のキャンバスをOffscreenCanvasに変換してワーカーに送信
        try {
          const frontOffscreen = frontCanvas.transferControlToOffscreen();
          const backOffscreen = backCanvas.transferControlToOffscreen();
          worker.postMessage(
            {
              type: "INIT_DUAL",
              data: { frontCanvas: frontOffscreen, backCanvas: backOffscreen },
            },
            [frontOffscreen, backOffscreen],
          );
        } catch (e) {
          console.error(`[MultiWorker] Failed to transfer canvas ${i}:`, e);
        }

        // Setup parallel index
        worker.postMessage({
          type: "SETUP_WORKER",
          data: { workerIndex: i, totalWorkers: WORKER_COUNT },
        });

        // 描画完了メッセージのリスナー
        // [FIX] 現在のレンダリングIDと一致する場合のみカウント
        worker.onmessage = (e) => {
          const { type, error, renderId: workerRenderId } = e.data;
          if (type === "RENDER_COMPLETE") {
            // 古いレンダリング要求の完了は無視
            if (workerRenderId !== renderIdRef.current) {
              return; // ステイル（古い）な完了メッセージを無視
            }
            pendingRendersRef.current--;
            if (pendingRendersRef.current <= 0) {
              pendingRendersRef.current = 0;
              swapBuffers(workerRenderId);
            }
          }
          if (type === "ERROR") console.error(`[Worker ${i}] Error:`, error);
        };

        newWorkers.push(worker);
      }

      frontCanvasesRef.current = frontCanvases;
      backCanvasesRef.current = backCanvases;
      workerRefs.current = newWorkers;
      setWorkerReady(true);
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
        data: { tiles, replace },
      });
    },
    [broadcast],
  );

  // Resizer - resize both buffers
  const resize = useCallback(
    (width, height) => {
      broadcast({
        type: "RESIZE_DUAL",
        data: { width, height },
      });
    },
    [broadcast],
  );

  // Render Trigger - render to inactive buffer
  const render = useCallback(
    (viewport, width, height) => {
      renderIdRef.current++;
      const renderId = renderIdRef.current;
      pendingRendersRef.current = WORKER_COUNT;

      // 現在表示中でない方のバッファに描画を指示
      const targetBuffer = activeBufferRef.current === 0 ? "back" : "front";

      broadcast({
        type: "RENDER_TILES_DUAL",
        data: { viewport, width, height, targetBuffer, renderId },
      });
    },
    [broadcast, WORKER_COUNT],
  );

  const renderChunks = useCallback(
    (data) => {
      renderIdRef.current++;
      const renderId = renderIdRef.current;
      pendingRendersRef.current = WORKER_COUNT;
      const targetBuffer = activeBufferRef.current === 0 ? "back" : "front";

      broadcast({
        type: "RENDER_CHUNKS_DUAL",
        data: { ...data, targetBuffer, renderId },
      });
    },
    [broadcast, WORKER_COUNT],
  );

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

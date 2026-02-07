import { useCallback, useEffect, useRef, useState } from "react";
import RenderWorker from "../workers/renderWorker.js?worker";

/**
 * Multi-Threaded Render Worker Hook
 * Manages multiple RenderWorker instances to utilize CPU cores.
 */
export const useMultiRenderWorker = (
  tileData,
  factions,
  alliances,
  playerColors,
  theme,
) => {
  const workerRefs = useRef([]); // Array of Worker instances
  const canvasRefs = useRef([]); // Array of Canvas elements
  const [workerReady, setWorkerReady] = useState(false);

  // Determine number of workers
  // Use hardwareConcurrency, but ensure at least 1
  const concurrency =
    typeof navigator !== "undefined" ? navigator.hardwareConcurrency || 4 : 4;
  // Cap at reasonable number if needed, but user requested FULL POWER.
  // However, creating 128 workers for 128 cores might overload browser context limit.
  // Browsers usually limit contexts. Chrome ~16-32 accel contexts.
  // We'll trust the user but maybe add a sanity cap of 16 if things crash.
  // For now, let's use Concurrency directly.
  const WORKER_COUNT = Math.max(1, concurrency);

  // Initialize Workers
  const initWorkers = useCallback(
    (canvases) => {
      if (workerRefs.current.length > 0) return; // Already initialized

      console.log(
        `[useMultiRenderWorker] Initializing ${WORKER_COUNT} workers.`,
      );

      const newWorkers = [];

      for (let i = 0; i < WORKER_COUNT; i++) {
        const worker = new RenderWorker();
        const canvas = canvases[i];

        // Transfer control of canvas
        try {
          const offscreen = canvas.transferControlToOffscreen();
          worker.postMessage({ type: "INIT", data: { canvas: offscreen } }, [
            offscreen,
          ]);
        } catch (e) {
          console.error(`[MultiWorker] Failed to transfer canvas ${i}:`, e);
          // Fallback or error handling
        }

        // Setup parallel index
        worker.postMessage({
          type: "SETUP_WORKER",
          data: { workerIndex: i, totalWorkers: WORKER_COUNT },
        });

        // Initial Data Sync
        // We'll sync data in useEffect, but we can setup listeners here
        worker.onmessage = (e) => {
          const { type, success, error } = e.data;
          // if (type === "RENDER_COMPLETE") { ... }
          if (type === "ERROR") console.error(`[Worker ${i}] Error:`, error);
        };

        newWorkers.push(worker);
      }

      workerRefs.current = newWorkers;
      setWorkerReady(true);
    },
    [WORKER_COUNT],
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

    // Update Theme
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

      // This is the heavy part. We are SENDING copies of tiles to N workers.
      // Structure clone overhead is N times.
      // But render is faster.
      broadcast({
        type: "UPDATE_TILES",
        data: { tiles, replace },
      });
    },
    [broadcast],
  );

  // Resizer
  const resize = useCallback(
    (width, height) => {
      broadcast({
        type: "RESIZE",
        data: { width, height },
      });
    },
    [broadcast],
  );

  // Render Trigger
  const render = useCallback(
    (viewport, width, height) => {
      console.log(
        `[useMultiRenderWorker] render called: viewport.zoom=${viewport.zoom}, ${width}x${height}, workers=${workerRefs.current.length}`,
      );
      broadcast({
        type: "RENDER_TILES",
        data: { viewport, width, height },
      });
    },
    [broadcast],
  );

  const renderChunks = useCallback(
    (data) => {
      broadcast({
        type: "RENDER_CHUNKS",
        data,
      });
    },
    [broadcast],
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

/**
 * Map Worker フック
 * Web Workerを使って重い計算をオフスレッドで実行
 */
import { useCallback, useEffect, useRef } from "react";

export function useMapWorker() {
  const workerRef = useRef(null);
  const callbacksRef = useRef(new Map());
  const idCounterRef = useRef(0);

  useEffect(() => {
    // Viteでのworkerインポート
    workerRef.current = new Worker(
      new URL("../workers/mapWorker.js", import.meta.url),
      { type: "module" },
    );

    workerRef.current.onmessage = (e) => {
      const { id, success, result, error } = e.data;
      const callback = callbacksRef.current.get(id);

      if (callback) {
        callbacksRef.current.delete(id);
        if (success) {
          callback.resolve(result);
        } else {
          callback.reject(new Error(error));
        }
      }
    };

    workerRef.current.onerror = (e) => {
      console.error("[MapWorker] Error:", e);
    };

    return () => {
      if (workerRef.current) {
        workerRef.current.terminate();
      }
    };
  }, []);

  const runTask = useCallback((type, data) => {
    return new Promise((resolve, reject) => {
      if (!workerRef.current) {
        reject(new Error("Worker not initialized"));
        return;
      }

      const id = idCounterRef.current++;
      callbacksRef.current.set(id, { resolve, reject });

      workerRef.current.postMessage({ type, data, id });
    });
  }, []);

  // ユーティリティ関数
  const aggregateFactions = useCallback(
    (tiles) => {
      return runTask("AGGREGATE_FACTIONS", { tiles });
    },
    [runTask],
  );

  const getNeighbors = useCallback(
    (x, y, tiles) => {
      return runTask("GET_NEIGHBORS", { x, y, tiles });
    },
    [runTask],
  );

  const calculateLabels = useCallback(
    (tiles, factions) => {
      return runTask("CALCULATE_LABELS", { tiles, factions });
    },
    [runTask],
  );

  const getViewportTiles = useCallback(
    (tiles, viewport) => {
      return runTask("GET_VIEWPORT_TILES", { tiles, viewport });
    },
    [runTask],
  );

  const findBorders = useCallback(
    (tiles, factionId) => {
      return runTask("FIND_BORDERS", { tiles, factionId });
    },
    [runTask],
  );

  const calculateClusters = useCallback(
    (tiles) => {
      return runTask("CALCULATE_CLUSTERS", { tiles });
    },
    [runTask],
  );

  const calculateEdges = useCallback(
    (tiles, factionId) => {
      return runTask("CALCULATE_EDGES", { tiles, factionId });
    },
    [runTask],
  );

  return {
    runTask,
    aggregateFactions,
    getNeighbors,
    calculateLabels,
    getViewportTiles,
    findBorders,
    calculateClusters,
    calculateEdges,
  };
}

export default useMapWorker;

/**
 * Worker Pool フック
 * 複数のWorkerインスタンスを並列実行してCPUコアを活用
 */
import { useCallback, useEffect, useRef } from "react";

// Workerプールのサイズ（論理コア数、最小2）
const getPoolSize = () => {
  const cores = navigator.hardwareConcurrency || 4;
  // [OPTIMIZATION] UIスレッド（メインスレッド）の反応性を保つため、1コア分を空ける
  return cores >= 2 ? cores - 1 : 1;
};

export function useMapWorkerPool() {
  const workersRef = useRef([]);
  const callbacksRef = useRef(new Map());
  const idCounterRef = useRef(0);
  const currentWorkerIndexRef = useRef(0);
  const poolSize = useRef(getPoolSize());

  useEffect(() => {
    // Worker Pool初期化
    const size = poolSize.current;
    console.log(`[WorkerPool] Initializing ${size} workers`);

    for (let i = 0; i < size; i++) {
      const worker = new Worker(
        new URL("../workers/mapWorker.js", import.meta.url),
        { type: "module" },
      );

      worker.onmessage = (e) => {
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

      worker.onerror = (e) => {
        console.error(`[WorkerPool] Worker ${i} error:`, e);
      };

      workersRef.current.push(worker);
    }

    return () => {
      workersRef.current.forEach((w) => w.terminate());
      workersRef.current = [];
    };
  }, []);

  // ラウンドロビンでWorkerを選択
  const getNextWorker = useCallback(() => {
    const index = currentWorkerIndexRef.current;
    currentWorkerIndexRef.current = (index + 1) % poolSize.current;
    return workersRef.current[index];
  }, []);

  // タスクをWorkerに送信
  const sendTask = useCallback(
    (type, data) => {
      return new Promise((resolve, reject) => {
        const attemptSend = (attempts = 0) => {
          if (workersRef.current.length === 0) {
            if (attempts < 20) {
              // Worker初期化待ち: 100ms待機して再試行 (最大2秒)
              setTimeout(() => attemptSend(attempts + 1), 100);
              return;
            }
            reject(new Error("No worker available after retries (Pool empty)"));
            return;
          }

          const worker = getNextWorker();
          if (!worker) {
            // Should not happen if length > 0, but safety check
            if (attempts < 5) {
              setTimeout(() => attemptSend(attempts + 1), 100);
              return;
            }
            reject(new Error("No worker available (Worker undefined)"));
            return;
          }

          const id = idCounterRef.current++;
          callbacksRef.current.set(id, { resolve, reject });
          worker.postMessage({ type, data, id });
        };
        attemptSend();
      });
    },
    [getNextWorker],
  );

  // 複数タスクを並列実行
  const sendParallelTasks = useCallback(
    (tasks) => {
      // tasksは [{type, data}, ...] の配列
      return Promise.all(tasks.map((task) => sendTask(task.type, task.data)));
    },
    [sendTask],
  );

  // 既存API互換のメソッド
  const calculateClusters = useCallback(
    (tiles) => {
      return sendTask("CALCULATE_CLUSTERS", { tiles });
    },
    [sendTask],
  );

  const calculateEdges = useCallback(
    (tiles, factionId) => {
      return sendTask("CALCULATE_EDGES", { tiles, factionId });
    },
    [sendTask],
  );

  const aggregateFactions = useCallback(
    (tiles) => {
      return sendTask("AGGREGATE_FACTIONS", { tiles });
    },
    [sendTask],
  );

  const getNeighbors = useCallback(
    (x, y, tiles) => {
      return sendTask("GET_NEIGHBORS", { x, y, tiles });
    },
    [sendTask],
  );

  const calculateLabels = useCallback(
    (tiles, factions) => {
      return sendTask("CALCULATE_LABELS", { tiles, factions });
    },
    [sendTask],
  );

  const getViewportTiles = useCallback(
    (tiles, viewport) => {
      return sendTask("GET_VIEWPORT_TILES", { tiles, viewport });
    },
    [sendTask],
  );

  const findBorders = useCallback(
    (tiles, factionId) => {
      return sendTask("FIND_BORDERS", { tiles, factionId });
    },
    [sendTask],
  );

  return {
    // Pool管理
    poolSize: poolSize.current,
    sendTask,
    sendParallelTasks,
    // 既存API互換
    calculateClusters,
    calculateEdges,
    aggregateFactions,
    getNeighbors,
    calculateLabels,
    getViewportTiles,
    findBorders,
  };
}

export default useMapWorkerPool;

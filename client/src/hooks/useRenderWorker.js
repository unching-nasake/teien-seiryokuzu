/**
 * Render Worker フック
 * OffscreenCanvasを使用したオフスレッド描画を管理
 */
import { useCallback, useEffect, useRef, useState } from "react";

export function useRenderWorker() {
  const workerRef = useRef(null);
  const canvasTransferredRef = useRef(false);
  const [isReady, setIsReady] = useState(false);
  const pendingMessagesRef = useRef([]);

  useEffect(() => {
    // Worker初期化
    workerRef.current = new Worker(
      new URL("../workers/renderWorker.js", import.meta.url),
      { type: "module" },
    );

    workerRef.current.onmessage = (e) => {
      const { type, success, error } = e.data;

      if (type === "INIT_COMPLETE" && success) {
        console.log("[useRenderWorker] Worker initialized");
        setIsReady(true);

        // 待機中のメッセージを処理
        pendingMessagesRef.current.forEach((msg) => {
          workerRef.current.postMessage(msg);
        });
        pendingMessagesRef.current = [];
      } else if (type === "ERROR") {
        console.error("[useRenderWorker] Worker error:", error);
      }
    };

    workerRef.current.onerror = (e) => {
      console.error("[useRenderWorker] Worker error:", e);
    };

    return () => {
      if (workerRef.current) {
        workerRef.current.terminate();
      }
    };
  }, []);

  /**
   * OffscreenCanvasを転送してWorkerを初期化
   */
  const initCanvas = useCallback((canvas) => {
    if (!workerRef.current || canvasTransferredRef.current) return false;

    try {
      const offscreen = canvas.transferControlToOffscreen();
      workerRef.current.postMessage(
        { type: "INIT", data: { canvas: offscreen } },
        [offscreen],
      );
      canvasTransferredRef.current = true;
      return true;
    } catch (e) {
      console.error("[useRenderWorker] Failed to transfer canvas:", e);
      return false;
    }
  }, []);

  /**
   * キャンバスサイズを更新
   */
  const resize = useCallback(
    (width, height) => {
      if (!workerRef.current) return;

      const msg = { type: "RESIZE", data: { width, height } };

      if (isReady) {
        workerRef.current.postMessage(msg);
      } else {
        pendingMessagesRef.current.push(msg);
      }
    },
    [isReady],
  );

  /**
   * チャンク描画をリクエスト (LODモード)
   */
  const renderChunks = useCallback(
    (data) => {
      if (!workerRef.current) return;

      const msg = { type: "RENDER_CHUNKS", data };

      if (isReady) {
        workerRef.current.postMessage(msg);
      } else {
        pendingMessagesRef.current.push(msg);
      }
    },
    [isReady],
  );

  /**
   * タイルデータを更新 (描画はしない)
   */
  const updateTiles = useCallback(
    (tiles, replace = false) => {
      if (!workerRef.current) return;
      const msg = { type: "UPDATE_TILES", data: { tiles, replace } };
      if (isReady) workerRef.current.postMessage(msg);
      else pendingMessagesRef.current.push(msg);
    },
    [isReady],
  );

  /**
   * その他データを更新 (描画はしない)
   */
  const updateData = useCallback(
    (data) => {
      if (!workerRef.current) return;
      const msg = { type: "UPDATE_DATA", data };
      if (isReady) workerRef.current.postMessage(msg);
      else pendingMessagesRef.current.push(msg);
    },
    [isReady],
  );

  /**
   * タイル描画をリクエスト (通常モード)
   * データはキャッシュ済みのものを使用
   */
  const renderTiles = useCallback(
    (data) => {
      if (!workerRef.current) return;

      // dataにtilesなどが含まれていれば分離して送るべきだが、
      // ここでは純粋な描画リクエストとして扱う。
      // ただし、GameMap側で分離しきれていない場合のために、
      // dataに含まれる情報をそのまま送るとWorker側で処理される(renderWorker改修済み)

      const msg = { type: "RENDER_TILES", data };

      if (isReady) {
        workerRef.current.postMessage(msg);
      } else {
        pendingMessagesRef.current.push(msg);
      }
    },
    [isReady],
  );

  /**
   * OffscreenCanvas対応チェック
   */
  const isSupported = useCallback(() => {
    return (
      typeof OffscreenCanvas !== "undefined" &&
      typeof HTMLCanvasElement.prototype.transferControlToOffscreen ===
        "function"
    );
  }, []);

  return {
    initCanvas,
    resize,
    updateTiles, // [New]
    updateData, // [New]
    renderChunks,
    renderTiles,
    isReady,
    isSupported,
    canvasTransferred: canvasTransferredRef.current,
  };
}

export default useRenderWorker;

import { useCallback, useState } from "react";

const useNotifications = () => {
  const [notifications, setNotifications] = useState([]);
  const [apUpdated, setApUpdated] = useState(false);

  // 通知削除
  const removeNotification = useCallback((id) => {
    setNotifications((prev) =>
      prev.map((n) => (n.id === id ? { ...n, removing: true } : n)),
    );
    setTimeout(() => {
      setNotifications((prev) => prev.filter((n) => n.id !== id));
    }, 300); // アニメーション時間
  }, []);

  // 通知追加
  const addNotification = useCallback(
    (message, title = null) => {
      const id = Date.now() + Math.random();
      setNotifications((prev) => [
        ...prev,
        { id, title, message, removing: false },
      ]);

      // 5秒後に自動消去
      setTimeout(() => {
        removeNotification(id);
      }, 5000);
    },
    [removeNotification],
  );

  // AP更新エフェクト発火
  const triggerApEffect = useCallback(() => {
    setApUpdated(true);
    setTimeout(() => setApUpdated(false), 1000);
  }, []);

  return {
    notifications,
    apUpdated,
    addNotification,
    removeNotification,
    triggerApEffect,
  };
};

export default useNotifications;

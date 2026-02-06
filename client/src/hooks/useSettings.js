import { useEffect, useState } from "react";

const useSettings = () => {
  // マップ操作の確認をスキップ
  const [skipConfirmation, setSkipConfirmation] = useState(() => {
    try {
      const saved = localStorage.getItem("teien_map_skip_confirm");
      return saved === "true";
    } catch {
      return false;
    }
  });

  useEffect(() => {
    localStorage.setItem("teien_map_skip_confirm", skipConfirmation);
  }, [skipConfirmation]);

  // サイドバーの開閉状態
  const [isSidebarOpen, setIsSidebarOpen] = useState(() => {
    try {
      const saved = localStorage.getItem("teien_sidebar_open");
      if (saved !== null) return saved === "true";
      return window.innerWidth > 768;
    } catch {
      return true;
    }
  });

  useEffect(() => {
    localStorage.setItem("teien_sidebar_open", isSidebarOpen);
    const timer = setTimeout(() => {
      window.dispatchEvent(new Event("resize"));
    }, 350);
    return () => clearTimeout(timer);
  }, [isSidebarOpen]);

  // リーダーボードの表示
  const [showLeaderboard, setShowLeaderboard] = useState(() => {
    try {
      const saved = localStorage.getItem("teien_show_leaderboard");
      return saved !== null ? JSON.parse(saved) : true;
    } catch {
      return true;
    }
  });

  useEffect(() => {
    localStorage.setItem(
      "teien_show_leaderboard",
      JSON.stringify(showLeaderboard),
    );
  }, [showLeaderboard]);

  // 空白マスの色
  const [blankTileColor, setBlankTileColor] = useState(() => {
    try {
      const saved = localStorage.getItem("teien_blank_tile_color");
      return saved || "#ffffff";
    } catch {
      return "#ffffff";
    }
  });

  useEffect(() => {
    localStorage.setItem("teien_blank_tile_color", blankTileColor);
  }, [blankTileColor]);

  // ネームドマスの名前表示
  const [showNamedTileNames, setShowNamedTileNames] = useState(() => {
    try {
      const saved = localStorage.getItem("teien_show_named_tile_names");
      return saved !== null ? JSON.parse(saved) : true;
    } catch {
      return true;
    }
  });

  useEffect(() => {
    localStorage.setItem(
      "teien_show_named_tile_names",
      JSON.stringify(showNamedTileNames),
    );
  }, [showNamedTileNames]);

  // 中核マスのみハイライト
  const [highlightCoreOnly, setHighlightCoreOnly] = useState(() => {
    try {
      const saved = localStorage.getItem("teien_highlight_core_only");
      return saved !== null ? JSON.parse(saved) : false;
    } catch {
      return false;
    }
  });

  useEffect(() => {
    localStorage.setItem(
      "teien_highlight_core_only",
      JSON.stringify(highlightCoreOnly),
    );
  }, [highlightCoreOnly]);

  // 勢力名表示
  const [showFactionNames, setShowFactionNames] = useState(() => {
    try {
      const saved = localStorage.getItem("teien_show_faction_names");
      return saved !== null ? JSON.parse(saved) : true;
    } catch {
      return true;
    }
  });

  useEffect(() => {
    localStorage.setItem(
      "teien_show_faction_names",
      JSON.stringify(showFactionNames),
    );
  }, [showFactionNames]);

  // マップ色分けモード (faction / alliance / player)
  const [mapColorMode, setMapColorMode] = useState(() => {
    try {
      const saved = localStorage.getItem("teien_map_color_mode");
      return saved || "faction";
    } catch {
      return "faction";
    }
  });

  useEffect(() => {
    localStorage.setItem("teien_map_color_mode", mapColorMode);
  }, [mapColorMode]);

  // 特殊境界線
  const [showSpecialBorder, setShowSpecialBorder] = useState(() => {
    try {
      const saved = localStorage.getItem("teien_show_special_border");
      return saved !== null ? JSON.parse(saved) : true;
    } catch {
      return true;
    }
  });

  useEffect(() => {
    localStorage.setItem(
      "teien_show_special_border",
      JSON.stringify(showSpecialBorder),
    );
  }, [showSpecialBorder]);

  return {
    skipConfirmation,
    setSkipConfirmation,
    isSidebarOpen,
    setIsSidebarOpen,
    showLeaderboard,
    setShowLeaderboard,
    blankTileColor,
    setBlankTileColor,
    showNamedTileNames,
    setShowNamedTileNames,
    highlightCoreOnly,
    setHighlightCoreOnly,
    showFactionNames,
    setShowFactionNames,

    mapColorMode,
    setMapColorMode,

    showSpecialBorder,
    setShowSpecialBorder,
  };
};

export default useSettings;

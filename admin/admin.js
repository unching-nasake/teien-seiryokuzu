let isGameStopped = false;

// Admin認証チェック
async function checkAdminAuth() {
  try {
    const res = await fetch("/api/admin/check-auth", {
      credentials: "include",
    });
    if (res.ok) {
      // 認証済み - Admin画面を表示
      document.getElementById("adminPanel").style.display = "block";
      document.getElementById("loginModal").style.display = "none";
      await fetchSettings();
    } else {
      // 未認証 - ログインモーダルを表示
      document.getElementById("loginModal").style.display = "flex";
      document.getElementById("adminPanel").style.display = "none";
    }
  } catch (e) {
    document.getElementById("loginModal").style.display = "flex";
    document.getElementById("adminPanel").style.display = "none";
  }
}

// Adminログイン
async function adminLogin() {
  const password = document.getElementById("loginPassword").value;
  const errorEl = document.getElementById("loginError");

  if (!password) {
    errorEl.textContent = "パスワードを入力してください";
    return;
  }

  try {
    const res = await fetch("/api/admin/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "include",
      body: JSON.stringify({ password }),
    });

    const data = await res.json();

    if (data.success) {
      document.getElementById("loginPassword").value = "";
      errorEl.textContent = "";
      await checkAdminAuth();
    } else {
      errorEl.textContent = data.error || "ログインに失敗しました";
    }
  } catch (e) {
    errorEl.textContent = "通信エラーが発生しました";
  }
}

// ページ読み込み時に認証チェック
window.addEventListener("DOMContentLoaded", checkAdminAuth);

// タブ切り替え
function switchTab(tabName) {
  document
    .querySelectorAll(".tab-btn")
    .forEach((btn) => btn.classList.remove("active"));
  document
    .querySelectorAll(".tab-content")
    .forEach((content) => content.classList.remove("active"));

  if (tabName === "settings") {
    document.querySelector(".tab-btn:nth-child(1)").classList.add("active");
    document.getElementById("settingsTab").classList.add("active");
  } else if (tabName === "notices") {
    document.querySelector(".tab-btn:nth-child(2)").classList.add("active");
    document.getElementById("noticesTab").classList.add("active");
    fetchNotices(); // タブ切り替え時に最新のお知らせを取得
  } else if (tabName === "security") {
    document.querySelector(".tab-btn:nth-child(3)").classList.add("active");
    document.getElementById("securityTab").classList.add("active");
  } else if (tabName === "data") {
    document.querySelector(".tab-btn:nth-child(4)").classList.add("active");
    document.getElementById("dataTab").classList.add("active");
  }
}

function updateUI(data) {
  isGameStopped = data.isGameStopped;
  const gardenMode = data.gardenMode;
  const ap = data.apSettings || {};
  const mapSettings = data.mapImageSettings || {};

  // ステータスカードの更新
  const statusIcon = document.getElementById("statusIcon");
  const statusText = document.getElementById("statusText");
  const toggleBtn = document.getElementById("toggleBtn");

  if (isGameStopped) {
    statusIcon.textContent = "🔴";
    statusText.textContent = "現在: 停止中";
    toggleBtn.textContent = "ゲームを再開する";
  } else {
    statusIcon.textContent = "🟢";
    statusText.textContent = "現在: 稼働中";
    toggleBtn.textContent = "ゲームを停止する";
  }

  // 各項目の更新
  document.getElementById("gardenMode").checked = !!gardenMode;
  document.getElementById("initialAp").value = ap.initialAp ?? 10;
  document.getElementById("apPerPost").value = ap.apPerPost ?? 10;
  document.getElementById("maxApFromPosts").value = ap.maxApFromPosts ?? 10;
  document.getElementById("randomMin").value = ap.random?.min ?? 0;
  document.getElementById("randomMax").value = ap.random?.max ?? 10;
  document.getElementById("bonusMin").value = ap.smallFactionBonus?.min ?? 0;
  document.getElementById("bonusMax").value = ap.smallFactionBonus?.max ?? 10;
  document.getElementById("indLimit").value = ap.limits?.individual ?? 50;
  document.getElementById("sharedBase").value = ap.limits?.sharedBase ?? 50;
  document.getElementById("gardenRefillCost").value = ap.gardenRefillCost ?? 30;
  document.getElementById("gardenRefillAmount").value =
    ap.gardenRefillAmount ?? 50;
  document.getElementById("tulipRefillIntervalHours").value =
    ap.tulipRefillIntervalHours ?? 3;
  document.getElementById("messagesEnabled").checked =
    data.messagesEnabled ?? true;
  document.getElementById("messageCost").value = ap.messageCost ?? 5;
  document.getElementById("mapImageInterval").value =
    mapSettings.intervalMinutes ?? 1;

  const ntSettings = data.namedTileSettings || {
    cost: 100,
    intervalHours: 0,
    fallApBonusMin: 10,
    fallApBonusMax: 50,
    zocMultiplier: 2.0,
    zocReducedMultiplier: 1.5,
  };
  document.getElementById("namedTileCost").value = ntSettings.cost;
  document.getElementById("namedTileIntervalHours").value =
    ntSettings.intervalHours;
  document.getElementById("fallApBonusMin").value =
    ntSettings.fallApBonusMin ?? 10;
  document.getElementById("fallApBonusMax").value =
    ntSettings.fallApBonusMax ?? 50;
  document.getElementById("zocMultiplier").value =
    ntSettings.zocMultiplier ?? 2.0;
  document.getElementById("zocReducedMultiplier").value =
    ntSettings.zocReducedMultiplier ?? 1.5;
  document.getElementById("maxNamedTiles").value =
    ntSettings.maxNamedTiles ?? 50;

  // Core Tile Settings
  const ctSettings = data.coreTileSettings || {
    attackCostMultiplier: 1.5,
    instantCoreThreshold: 400,
    maxCoreTiles: 2500,
  };
  document.getElementById("coreAttackMultiplier").value =
    ctSettings.attackCostMultiplier ?? 1.5;
  document.getElementById("instantCoreThreshold").value =
    ctSettings.instantCoreThreshold ?? 400;
  document.getElementById("maxCoreTiles").value =
    ctSettings.maxCoreTiles ?? 2500;

  document.getElementById("maxCoreTiles").value =
    ctSettings.maxCoreTiles ?? 2500;

  // Enclave Settings
  const enclaveSettings = data.enclaveSettings || {
    distanceLimit: 25,
    penaltyUnit: 1,
  };
  document.getElementById("enclaveDistanceLimit").value =
    enclaveSettings.distanceLimit ?? 25;
  document.getElementById("enclavePenaltyUnit").value =
    enclaveSettings.penaltyUnit ?? 1;

  // Merger Settings
  const mergerSettings = data.mergerSettings || { prohibitedRank: 0 };
  const mergerRankEl = document.getElementById("mergerProhibitedRank");
  if (mergerRankEl) {
    mergerRankEl.value = mergerSettings.prohibitedRank ?? 0;
  }

  document.getElementById("adminId").value = data.adminId || "";

  const accounts = data.accountSettings || {};
  document.getElementById("maxAccountsPerIp").value =
    accounts.maxAccountsPerIp ?? 2;
  document.getElementById("excludedIps").value = accounts.excludedIps || "";

  // 休憩時間設定の更新
  const breakTime = data.breakTime || {
    enabled: false,
    startTime: "01:00",
    endTime: "06:00",
  };
  document.getElementById("breakTimeEnabled").checked = !!breakTime.enabled;
  document.getElementById("breakStartTime").value =
    breakTime.startTime || "01:00";
  document.getElementById("breakEndTime").value = breakTime.endTime || "06:00";

  // スケジュールUIの更新
  updateScheduleUI(data.scheduledAction);

  toggleApPostSettings();
}

function updateScheduleUI(action) {
  const statusEl = document.getElementById("scheduleStatus");
  const cancelBtn = document.getElementById("cancelScheduleBtn");
  const scheduleBtn = document.getElementById("scheduleBtn");
  const scheduleTimeInput = document.getElementById("scheduleTime");

  if (action && action.time) {
    const date = new Date(action.time);
    const dateStr = date.toLocaleString("ja-JP", {
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
    });
    statusEl.innerHTML = `<b style="color: #2c3e50;">${action.type === "stop" ? "🛑 停止" : "🚀 開始"}</b> (${dateStr})`;
    cancelBtn.style.display = "block";
    scheduleBtn.style.display = "none";
    scheduleTimeInput.disabled = true;
    scheduleTimeInput.value = action.time.slice(0, 16); // YYYY-MM-DDTHH:mm
  } else {
    statusEl.textContent = "未設定";
    cancelBtn.style.display = "none";
    scheduleBtn.style.display = "block";
    scheduleTimeInput.disabled = false;
    scheduleBtn.textContent = isGameStopped ? "開始予約" : "停止予約";
  }
}

async function setSchedule() {
  const timeValue = document.getElementById("scheduleTime").value;

  if (!timeValue) {
    showNotify("予約時間を選択してください", true);
    return;
  }

  const scheduledTime = new Date(timeValue).getTime();
  if (scheduledTime <= Date.now()) {
    showNotify("未来の時間を指定してください", true);
    return;
  }

  const type = isGameStopped ? "start" : "stop";
  if (
    !confirm(
      `ゲームを ${new Date(timeValue).toLocaleString()} に${type === "stop" ? "自動停止" : "自動開始"}するように予約しますか？`,
    )
  )
    return;

  try {
    const res = await fetch("/api/admin/settings", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "include",
      body: JSON.stringify({
        scheduledAction: {
          type: type,
          time: new Date(timeValue).toISOString(),
        },
      }),
    });
    const data = await res.json();
    if (data.error) {
      showNotify(data.error, true);
    } else {
      showNotify("スケジュールを予約しました");
      updateUI(data);
    }
  } catch (e) {
    showNotify("予約に失敗しました", true);
  }
}

async function cancelSchedule() {
  if (!confirm("現在の予約スケジュールを取り消しますか？")) return;

  try {
    const res = await fetch("/api/admin/settings", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "include",
      body: JSON.stringify({
        scheduledAction: { type: "cancel" },
      }),
    });
    const data = await res.json();
    if (data.error) {
      showNotify(data.error, true);
    } else {
      showNotify("予約を取り消しました");
      updateUI(data);
    }
  } catch (e) {
    showNotify("取り消しに失敗しました", true);
  }
}

function toggleApPostSettings() {
  const gardenMode = document.getElementById("gardenMode").checked;
  document.getElementById("gardenApSettings").style.display = gardenMode
    ? "block"
    : "none";
}

async function fetchSettings() {
  try {
    const res = await fetch("/api/admin/settings");
    const data = await res.json();
    if (data.error) {
      showNotify(data.error, true);
      return;
    }
    updateUI(data);
  } catch (e) {
    showNotify("設定の取得に失敗しました", true);
  }
}

async function updateSettings() {
  const settings = {
    gardenMode: document.getElementById("gardenMode").checked,
    messagesEnabled: document.getElementById("messagesEnabled").checked,
    apSettings: {
      initialAp: parseInt(document.getElementById("initialAp").value, 10),
      apPerPost: parseInt(document.getElementById("apPerPost").value, 10),
      maxApFromPosts: parseInt(
        document.getElementById("maxApFromPosts").value,
        10,
      ),
      random: {
        min: parseInt(document.getElementById("randomMin").value, 10),
        max: parseInt(document.getElementById("randomMax").value, 10),
      },
      smallFactionBonus: {
        min: parseInt(document.getElementById("bonusMin").value, 10),
        max: parseInt(document.getElementById("bonusMax").value, 10),
      },
      limits: {
        individual: parseInt(document.getElementById("indLimit").value, 10),
        sharedBase: parseInt(document.getElementById("sharedBase").value, 10),
      },
      gardenRefillCost: parseInt(
        document.getElementById("gardenRefillCost").value,
        10,
      ),
      gardenRefillAmount: parseInt(
        document.getElementById("gardenRefillAmount").value,
        10,
      ),
      tulipRefillIntervalHours: parseFloat(
        document.getElementById("tulipRefillIntervalHours").value,
      ),
      messageCost: parseInt(document.getElementById("messageCost").value, 10),
    },
    namedTileSettings: {
      cost: parseInt(document.getElementById("namedTileCost").value, 10),
      intervalHours: parseFloat(
        document.getElementById("namedTileIntervalHours").value,
      ),
      fallApBonusMin: parseInt(
        document.getElementById("fallApBonusMin").value,
        10,
      ),
      fallApBonusMax: parseInt(
        document.getElementById("fallApBonusMax").value,
        10,
      ),
      zocMultiplier: parseFloat(document.getElementById("zocMultiplier").value),
      zocReducedMultiplier: parseFloat(
        document.getElementById("zocReducedMultiplier").value,
      ),
      maxNamedTiles: parseInt(
        document.getElementById("maxNamedTiles").value,
        10,
      ),
    },
    coreTileSettings: {
      attackCostMultiplier: parseFloat(
        document.getElementById("coreAttackMultiplier").value,
      ),
      instantCoreThreshold: parseInt(
        document.getElementById("instantCoreThreshold").value,
        10,
      ),
      maxCoreTiles: parseInt(document.getElementById("maxCoreTiles").value, 10),
    },
    enclaveSettings: {
      distanceLimit: parseInt(
        document.getElementById("enclaveDistanceLimit").value,
        10,
      ),
      penaltyUnit: parseInt(
        document.getElementById("enclavePenaltyUnit").value,
        10,
      ),
      penaltyUnit: parseInt(
        document.getElementById("enclavePenaltyUnit").value,
        10,
      ),
    },
    mergerSettings: {
      prohibitedRank: parseInt(
        document.getElementById("mergerProhibitedRank").value,
        10,
      ),
    },
    mapImageSettings: {
      intervalMinutes:
        parseInt(document.getElementById("mapImageInterval").value, 10) || 1,
    },
    accountSettings: {
      maxAccountsPerIp: parseInt(
        document.getElementById("maxAccountsPerIp").value,
        10,
      ),
      excludedIps: document.getElementById("excludedIps").value.trim(),
    },
    breakTime: {
      enabled: document.getElementById("breakTimeEnabled").checked,
      startTime: document.getElementById("breakStartTime").value,
      endTime: document.getElementById("breakEndTime").value,
    },
    adminId: document.getElementById("adminId").value.trim(),
  };

  try {
    const res = await fetch("/api/admin/settings", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "include",
      body: JSON.stringify(settings),
    });
    const data = await res.json();
    if (data.error) {
      showNotify(data.error, true);
    } else {
      showNotify("設定を保存しました");
      updateUI(data);
    }
  } catch (e) {
    showNotify("保存に失敗しました", true);
  }
}

async function toggleStatus() {
  const nextState = !isGameStopped;
  const msg = nextState ? "ゲームを停止しますか？" : "ゲームを再開しますか？";
  if (!confirm(msg)) return;

  try {
    const res = await fetch("/api/admin/settings", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "include",
      body: JSON.stringify({ isGameStopped: nextState }),
    });
    const data = await res.json();
    if (data.error) {
      showNotify(data.error, true);
    } else {
      showNotify("状態を更新しました");
      updateUI(data);
    }
  } catch (e) {
    showNotify("更新に失敗しました", true);
  }
}

async function resetData() {
  if (
    !confirm("本当に全データをリセットしますか？\nこの操作は取り消せません。")
  )
    return;
  if (!confirm("最終確認です。本当によろしいですか？")) return;

  try {
    const res = await fetch("/api/admin/reset-data", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "include",
      body: JSON.stringify({}),
    });
    const data = await res.json();
    if (data.error) {
      showNotify(data.error, true);
    } else {
      alert(data.message);
      location.reload();
    }
  } catch (e) {
    showNotify("リセットに失敗しました", true);
  }
}

// お知らせ管理
async function fetchNotices() {
  try {
    const res = await fetch("/api/notices");
    const data = await res.json();
    const listEl = document.getElementById("noticeList");

    if (!data.notices || data.notices.length === 0) {
      listEl.innerHTML =
        '<p style="text-align: center; color: #999;">お知らせはありません</p>';
      return;
    }

    listEl.innerHTML = data.notices
      .filter((n) => n.id && n.id.startsWith("sys-"))
      .map(
        (n) => `
        <div class="notice-item">
          <div class="notice-info">
            <h4>${escapeHtml(n.title)}</h4>
            <div style="font-size: 0.9rem;">${escapeHtml(n.content)}</div>
            <div class="notice-date">${new Date(n.date).toLocaleString()}</div>
          </div>
          <button class="del-notice-btn" onclick="deleteNotice('${n.id}')">削除</button>
        </div>
      `,
      )
      .join("");
  } catch (e) {
    console.error(e);
  }
}

async function addNotice() {
  const title = document.getElementById("noticeTitle").value.trim();
  const content = document.getElementById("noticeContent").value.trim();

  if (!title || !content) {
    showNotify("タイトルと内容を入力してください", true);
    return;
  }

  try {
    const res = await fetch("/api/admin/notices", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "include",
      body: JSON.stringify({ title, content }),
    });
    const data = await res.json();
    if (data.error) {
      showNotify(data.error, true);
    } else {
      showNotify("お知らせを投稿しました");
      document.getElementById("noticeTitle").value = "";
      document.getElementById("noticeContent").value = "";
      fetchNotices();
    }
  } catch (e) {
    showNotify("投稿に失敗しました", true);
  }
}

async function deleteNotice(id) {
  if (!confirm("削除しますか？")) return;

  try {
    const res = await fetch("/api/admin/notices/delete", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "include",
      body: JSON.stringify({ id }),
    });
    const data = await res.json();
    if (data.error) {
      showNotify(data.error, true);
    } else {
      showNotify("削除しました");
      fetchNotices();
    }
  } catch (e) {
    showNotify("削除に失敗しました", true);
  }
}

async function changePassword() {
  const currentPassword = document.getElementById("currentPassword").value;
  const newPassword = document.getElementById("newPassword").value;
  const confirmPassword = document.getElementById("confirmPassword").value;

  if (!currentPassword || !newPassword || !confirmPassword) {
    showNotify("全ての項目を入力してください", true);
    return;
  }
  if (newPassword !== confirmPassword) {
    showNotify("新しいパスワードが一致しません", true);
    return;
  }
  if (newPassword.length < 4) {
    showNotify("パスワードは4文字以上で設定してください", true);
    return;
  }

  try {
    const res = await fetch("/api/admin/change-password", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ currentPassword, newPassword }),
    });
    const data = await res.json();
    if (data.error) {
      showNotify(data.error, true);
    } else {
      showNotify(
        "パスワードを変更しました。新しいパスワードで操作してください",
      );
      document.getElementById("password").value = newPassword;
      document.getElementById("currentPassword").value = "";
      document.getElementById("newPassword").value = "";
      document.getElementById("confirmPassword").value = "";
      switchTab("settings");
    }
  } catch (e) {
    showNotify("通信に失敗しました", true);
  }
}

function showNotify(msg, isError = false) {
  const el = document.getElementById("feedback");
  el.textContent = msg;
  el.style.display = "block";
  el.className = isError ? "feedback-error" : "feedback-success";
  setTimeout(() => {
    el.style.display = "none";
  }, 3000);
}

function escapeHtml(text) {
  const div = document.createElement("div");
  div.textContent = text;
  return div.innerHTML;
}

// 初期読み込み
fetchSettings();

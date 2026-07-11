/**
 * script.js
 * ------------------------------------------------------------------
 * Daily Side Quest — 遊戲邏輯
 *
 * 本檔案只負責「行為」，不負責樣式（style.css）與資料（quests.js）。
 * 執行順序（見 index.html）：quests.js -> script.js（都是 defer 的一般
 * script，不使用 ES module，確保直接用瀏覽器開啟 index.html 也能執行）。
 *
 * 為了避免污染全域環境，整份邏輯包在單一 IIFE 內；只有 quests.js 提供的
 * `QUESTS` 常數會被讀取，此外不會建立、也不會依賴任何其他全域變數。
 *
 * 章節目錄：
 *   1. Config          — 所有「魔法數字 / 字串」集中管理，方便未來調整
 *   2. DOM Cache        — 一次性查詢所有需要的 DOM 節點
 *   3. State            — 玩家狀態的讀取 / 寫入（LocalStorage）
 *   4. Utilities         — 日期、等級、任務資料正規化等共用函式
 *   5. Sound             — 音效模組
 *   6. Render             — 畫面更新（HUD / 週紀錄 / 模式切換）
 *   7. Quest Actions       — 抽任務 / 完成任務
 *   8. Toast & Feedback     — 提示訊息與升級動畫
 *   9. Event Bindings        — 所有事件監聽器集中綁定
 *  10. Init                   — 啟動流程
 * ------------------------------------------------------------------
 */
(function () {
  "use strict";

  /* ================================================================
     1. Config
     ----------------------------------------------------------------
     未來新增功能時（每週任務、成就、商城…）優先考慮：
       - 是否只需要在這裡新增設定值即可，不需要動到邏輯本身？
     ================================================================ */
  const CONFIG = {
    // LocalStorage 使用的 key，全部集中在這裡，避免散落各處難以維護
    storageKeys: {
      done: "dsq_done",
      xp: "dsq_xp",
      streak: "dsq_streak",
      lastDone: "dsq_last_done",
      recent: "dsq_recent",
      dates: "dsq_dates",
      sound: "dsq_sound",
    },
    // 相容舊版資料（v1 曾使用過的 key 名稱），只在初次讀取時當作備援
    legacyStorageKeys: {
      done: "sideQuestDone",
      recent: "sideQuestRecent",
    },
    xp: {
      perQuest: 25,       // 完成一個任務預設可得的 EXP
      perLevel: 100,        // 升一級所需的 EXP
    },
    // 避免短時間內重複抽到同樣的任務：只要任務池夠大（> 此門檻）才會啟用去重
    repeatGuard: {
      historyLength: 80,     // recent 陣列最多保留幾筆
      blockedWindow: 35,       // 检查最近幾筆來避免重複
      minPoolSizeToDedupe: 36,   // 任務池小於這個數字時，不強制去重（避免無限迴圈）
    },
    week: {
      days: 7,                     // 「本週紀錄」要顯示幾天
      maxStoredDates: 45,            // dates 陣列最多保留幾筆，避免無限增長
    },
    toast: {
      durationMs: 1350,
    },
    completeToLevelUpDelayMs: 1050,
    // 冒險者稱號：依照等級區間對應，未來想加更多稱號只需擴充這個陣列
    ranks: [
      "新手旅人", "街角探索者", "日常冒險家", "勇氣收集者",
      "支線獵人", "生活開拓者", "傳說旅人",
    ],
    ranksPerTier: 3, // 每隔幾個等級換一個稱號
  };

  /* ================================================================
     2. DOM Cache
     ----------------------------------------------------------------
     所有 DOM 查詢只在這裡做一次，之後全部重複使用同一份參照，
     避免在函式內重複呼叫 document.getElementById。
     ================================================================ */
  const dom = {
    soundBtn: document.getElementById("soundBtn"),
    level: document.getElementById("level"),
    doneCount: document.getElementById("doneCount"),
    streak: document.getElementById("streak"),
    xpNow: document.getElementById("xpNow"),
    xpNeed: document.getElementById("xpNeed"),
    xpFill: document.getElementById("xpFill"),
    rankName: document.getElementById("rankName"),
    weekLog: document.getElementById("weekLog"),
    todayLabel: document.getElementById("todayLabel"),

    idleContent: document.getElementById("idleContent"),
    questContent: document.getElementById("questContent"),
    completeContent: document.getElementById("completeContent"),
    questText: document.getElementById("questText"),

    controls: document.getElementById("controls"),
    acceptBtn: document.getElementById("acceptBtn"),
    rerollBtn: document.getElementById("rerollBtn"),
    completeBtn: document.getElementById("completeBtn"),
    cancelBtn: document.getElementById("cancelBtn"),

    toast: document.getElementById("toast"),

    levelUp: document.getElementById("levelUp"),
    newLevel: document.getElementById("newLevel"),
    levelClose: document.getElementById("levelClose"),
  };

  /* ================================================================
     3. State
     ----------------------------------------------------------------
     玩家狀態的唯一真實來源（single source of truth）。
     讀取／寫入 LocalStorage 的邏輯全部集中在 loadState() / saveState()。
     ================================================================ */
  const keys = CONFIG.storageKeys;
  const legacy = CONFIG.legacyStorageKeys;

  /** 從 LocalStorage 讀取存檔，初始化玩家狀態物件 */
  function loadState() {
    return {
      done: Number(localStorage.getItem(keys.done) || localStorage.getItem(legacy.done) || 0),
      xp: Number(localStorage.getItem(keys.xp) || 0),
      streak: Number(localStorage.getItem(keys.streak) || 0),
      lastDone: localStorage.getItem(keys.lastDone) || "",
      recent: safeParseArray(localStorage.getItem(keys.recent) || localStorage.getItem(legacy.recent)),
      dates: safeParseArray(localStorage.getItem(keys.dates)),
      sound: localStorage.getItem(keys.sound) !== "off",
      current: -1, // 目前抽到、尚未完成的任務索引；-1 代表沒有進行中的任務
    };
  }

  /** 將目前狀態寫回 LocalStorage */
  function saveState(state) {
    localStorage.setItem(keys.done, state.done);
    localStorage.setItem(keys.xp, state.xp);
    localStorage.setItem(keys.streak, state.streak);
    localStorage.setItem(keys.lastDone, state.lastDone);
    localStorage.setItem(keys.recent, JSON.stringify(state.recent));
    localStorage.setItem(keys.dates, JSON.stringify(state.dates));
    localStorage.setItem(keys.sound, state.sound ? "on" : "off");
  }

  /** 安全解析 JSON 陣列字串；失敗或不存在時回傳空陣列 */
  function safeParseArray(raw) {
    if (!raw) return [];
    try {
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? parsed : [];
    } catch (err) {
      return [];
    }
  }

  const state = loadState();

  /* ================================================================
     4. Utilities
     ================================================================ */

  /**
   * 取得今天（或前後 offset 天）的日期字串，格式 YYYY-MM-DD。
   * @param {number} offset 天數偏移，0 代表今天，-1 代表昨天
   */
  function todayKey(offset = 0) {
    const d = new Date();
    d.setDate(d.getDate() + offset);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  }

  /** 計算兩個 YYYY-MM-DD 字串之間相差幾天（b - a） */
  function dateDiff(a, b) {
    const A = new Date(a + "T00:00:00");
    const B = new Date(b + "T00:00:00");
    return Math.round((B - A) / 86400000);
  }

  /** 依照目前總 EXP 計算等級 */
  function levelFromXp(xp) {
    return Math.floor(xp / CONFIG.xp.perLevel) + 1;
  }

  /** 依照等級計算冒險者稱號 */
  function rankFromLevel(level) {
    const { ranks, ranksPerTier } = CONFIG;
    const idx = Math.floor((level - 1) / ranksPerTier);
    return ranks[Math.min(ranks.length - 1, idx)];
  }

  /**
   * 將任務資料正規化成統一格式，同時支援：
   *   - 純字串： "任務描述"
   *   - 物件：   { text, category, difficulty, reward, icon }
   * 這樣未來若把 quests.js 換成物件格式，script.js 完全不需要修改。
   */
  function normalizeQuest(raw) {
    if (typeof raw === "string") {
      return { text: raw, category: null, difficulty: null, reward: null, icon: null };
    }
    return {
      text: raw.text || "",
      category: raw.category || null,
      difficulty: raw.difficulty || null,
      reward: typeof raw.reward === "number" ? raw.reward : null,
      icon: raw.icon || null,
    };
  }

  /** 取得指定任務可獲得的 EXP（若任務有自訂 reward 則優先使用） */
  function xpRewardFor(quest) {
    return typeof quest.reward === "number" ? quest.reward : CONFIG.xp.perQuest;
  }

  /* ================================================================
     5. Sound
     ----------------------------------------------------------------
     使用 Web Audio API 產生簡單的 8-bit 音效，不需要載入任何音檔，
     符合「載入速度快、不使用外部資源」的效能要求。
     ================================================================ */
  const SOUND_PRESETS = {
    pick: [392, 523],
    complete: [523, 659, 784],
    level: [523, 659, 784, 1047],
  };

  function playSound(type) {
    if (!state.sound) return;
    try {
      const ctx = new (window.AudioContext || window.webkitAudioContext)();
      const notes = SOUND_PRESETS[type] || SOUND_PRESETS.pick;
      notes.forEach((freq, i) => {
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.type = "square";
        osc.frequency.value = freq;
        gain.gain.setValueAtTime(0.035, ctx.currentTime + i * 0.08);
        gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + i * 0.08 + 0.12);
        osc.connect(gain);
        gain.connect(ctx.destination);
        osc.start(ctx.currentTime + i * 0.08);
        osc.stop(ctx.currentTime + i * 0.08 + 0.13);
      });
    } catch (err) {
      // 部分瀏覽器（如尚未與使用者互動過）可能會拋出例外，靜默忽略即可
    }
  }

  /* ================================================================
     6. Render
     ----------------------------------------------------------------
     所有「把 state 畫到畫面上」的邏輯集中在這裡，
     邏輯層（第 7 節）只需要修改 state 再呼叫 renderHud() 即可。
     ================================================================ */

  /** 更新 HUD（等級 / 完成數 / 連續天數 / EXP 條 / 稱號 / 音效圖示） */
  function renderHud() {
    const level = levelFromXp(state.xp);
    const xpNow = state.xp % CONFIG.xp.perLevel;

    dom.level.textContent = level;
    dom.doneCount.textContent = state.done;
    dom.streak.textContent = state.streak;
    dom.xpNow.textContent = xpNow;
    dom.xpNeed.textContent = CONFIG.xp.perLevel;
    dom.xpFill.style.width = xpNow + "%";
    dom.rankName.textContent = rankFromLevel(level);
    dom.soundBtn.textContent = state.sound ? "🔊" : "🔇";

    renderWeekLog();
  }

  /** 更新「本週冒險紀錄」的七個小圓點 */
  function renderWeekLog() {
    const wrap = dom.weekLog;
    wrap.innerHTML = "";
    const completedDates = new Set(state.dates);

    for (let i = -(CONFIG.week.days - 1); i <= 0; i++) {
      const dot = document.createElement("i");
      const key = todayKey(i);
      dot.className = "log-dot" + (completedDates.has(key) ? " done" : "");
      dot.title = key;
      wrap.appendChild(dot);
    }
  }

  /**
   * 切換任務舞台的顯示模式。
   * @param {"idle"|"quest"|"complete"} mode
   */
  function setMode(mode) {
    dom.idleContent.hidden = mode !== "idle";
    dom.questContent.hidden = mode !== "quest";
    dom.completeContent.hidden = mode !== "complete";

    dom.acceptBtn.hidden = mode !== "idle";
    dom.rerollBtn.hidden = mode !== "quest";
    dom.completeBtn.hidden = mode !== "quest";
    dom.cancelBtn.hidden = mode !== "quest";

    dom.controls.classList.toggle("active", mode === "quest");
  }

  /* ================================================================
     7. Quest Actions
     ================================================================ */

  /**
   * 從任務池中抽出一個任務（避免抽到目前這個，也避免抽到最近抽過的）。
   * 任務池太小時（<= minPoolSizeToDedupe）會放寬去重限制，避免無限迴圈。
   */
  function pickQuest() {
    const { blockedWindow, minPoolSizeToDedupe } = CONFIG.repeatGuard;
    const blocked = new Set(state.recent.slice(-blockedWindow));

    let idx;
    do {
      idx = Math.floor(Math.random() * QUESTS.length);
    } while ((idx === state.current || blocked.has(idx)) && QUESTS.length > minPoolSizeToDedupe);

    state.current = idx;
    state.recent.push(idx);
    if (state.recent.length > CONFIG.repeatGuard.historyLength) {
      state.recent = state.recent.slice(-CONFIG.repeatGuard.historyLength);
    }

    const quest = normalizeQuest(QUESTS[idx]);
    dom.questText.textContent = quest.text;

    setMode("quest");
    playSound("pick");
    saveState(state);
  }

  /** 玩家按下「完成任務」：結算 EXP、連續天數、每週紀錄，並觸發回饋動畫 */
  function completeQuest() {
    const previousLevel = levelFromXp(state.xp);
    const today = todayKey();
    const quest = state.current >= 0 ? normalizeQuest(QUESTS[state.current]) : { reward: null };

    // 連續天數：同一天完成第二次不會重複計算；跨日才判斷是否斷了連續紀錄
    if (state.lastDone !== today) {
      if (state.lastDone && dateDiff(state.lastDone, today) === 1) {
        state.streak++;
      } else {
        state.streak = 1;
      }
      state.lastDone = today;
    }

    state.done++;
    state.xp += xpRewardFor(quest);

    if (!state.dates.includes(today)) state.dates.push(today);
    state.dates = state.dates.slice(-CONFIG.week.maxStoredDates);

    saveState(state);
    renderHud();
    setMode("complete");
    playSound("complete");
    showToast();

    const nextLevel = levelFromXp(state.xp);
    setTimeout(() => {
      if (nextLevel > previousLevel) {
        showLevelUp(nextLevel);
      } else {
        setMode("idle");
      }
    }, CONFIG.completeToLevelUpDelayMs);
  }

  /* ================================================================
     8. Toast & Feedback
     ================================================================ */

  /** 顯示底部提示訊息，並於一段時間後自動淡出 */
  function showToast() {
    dom.toast.classList.add("show");
    setTimeout(() => dom.toast.classList.remove("show"), CONFIG.toast.durationMs);
  }

  /** 顯示升級彈窗 */
  function showLevelUp(newLevel) {
    dom.newLevel.textContent = newLevel;
    dom.levelUp.hidden = false;
    playSound("level");
  }

  /** 關閉升級彈窗，回到待機畫面 */
  function closeLevelUp() {
    dom.levelUp.hidden = true;
    setMode("idle");
  }

  /** 切換音效開關 */
  function toggleSound() {
    state.sound = !state.sound;
    saveState(state);
    renderHud();
    if (state.sound) playSound("pick");
  }

  /* ================================================================
     9. Event Bindings
     ================================================================ */
  function bindEvents() {
    dom.acceptBtn.addEventListener("click", pickQuest);
    dom.rerollBtn.addEventListener("click", pickQuest);
    dom.completeBtn.addEventListener("click", completeQuest);
    dom.cancelBtn.addEventListener("click", () => setMode("idle"));
    dom.soundBtn.addEventListener("click", toggleSound);
    dom.levelClose.addEventListener("click", closeLevelUp);
  }

  /* ================================================================
     10. Init
     ================================================================ */
  function renderTodayLabel() {
    const now = new Date();
    dom.todayLabel.textContent = new Intl.DateTimeFormat("zh-Hant", {
      year: "numeric",
      month: "long",
      day: "numeric",
      weekday: "short",
    }).format(now);
  }

  function init() {
    renderTodayLabel();
    renderHud();
    setMode("idle");
    bindEvents();
  }

  init();
})();

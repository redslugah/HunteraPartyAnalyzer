// ==UserScript==
// @name         Huntera Party Analyzer
// @namespace    huntera-party-analyzer
// @version      4.9
// @description  Analise de dano e experiencia de ate 4 personagens em uma party.
// @homepageURL  https://github.com/redslugah/HunteraPartyAnalyzer
// @updateURL    https://raw.githubusercontent.com/redslugah/HunteraPartyAnalyzer/main/Script.js
// @downloadURL  https://raw.githubusercontent.com/redslugah/HunteraPartyAnalyzer/main/Script.js
// @match        https://huntera.com.br/*
// @run-at       document-end
// @grant        GM_xmlhttpRequest
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_deleteValue
// @grant        GM_addValueChangeListener
// @connect      hunterapartyanalyzer.onrender.com
// ==/UserScript==

(function () {
  "use strict";

  if (!/^\/(?:characters|game)(?:\/|$)/.test(window.location.pathname)) {
    return;
  }

  // Substitua pelo endereco do seu Web Service no Render.
  var API = "https://hunterapartyanalyzer.onrender.com";
  var STALE_MS = 15000;
  var POLL_MS = 1000;
  var HEARTBEAT_MS = 5000;
  var HEALTH_CHECK_MS = 60000;
  var COMBAT_TIMEOUT = 15;
  var NAME_KEY = "hunta-dps-name-v2";
  var VOC_KEY = "hunta-dps-voc-v2";
  var TABID_KEY = "hunta-dps-tabid-v2";
  var POS_KEY = "hunta-dps-pos-v2";
  var BIG_KEY = "hunta-dps-big-v2";
  var VIEWER_KEY = "hunta-dps-viewer-v2";
  var PARTY_NAME_KEY = "hunta-dps-party-name-v3";
  var PARTY_TOKEN_KEY = "hunta-dps-party-token-v3";
  var PARTY_PASSWORD_KEY = "hunta-dps-party-password-v1";
  var PARTY_LEADER_KEY = "hunta-dps-party-leader-v1";

  var VOCATIONS = [
    { key: "EK", label: "Knight", color: "#e8544e" },
    { key: "ED", label: "Druid", color: "#4ea8e8" },
    { key: "MS", label: "Sorcerer", color: "#e84ea8" },
    { key: "RP", label: "Paladin", color: "#4ee87a" }
  ];

  var VOC_BY_KEY = {};
  VOCATIONS.forEach(function (v) {
    VOC_BY_KEY[v.key] = v;
  });

  function uuid() {
    return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, function (c) {
      var r = (Math.random() * 16) | 0;
      var v = c === "x" ? r : (r & 0x3) | 0x8;
      return v.toString(16);
    });
  }

  var tabId = sessionStorage.getItem(TABID_KEY);

  if (!tabId) {
    tabId = uuid();
    sessionStorage.setItem(TABID_KEY, tabId);
  }

  var myName = localStorage.getItem(NAME_KEY) || "";
  var myVoc = localStorage.getItem(VOC_KEY) || "";
  var partyName = localStorage.getItem(PARTY_NAME_KEY) || "";
  var partyPassword = GM_getValue(PARTY_PASSWORD_KEY, "") || "";
  var partyToken = GM_getValue(PARTY_TOKEN_KEY, "") || "";
  var leaderPartyName = GM_getValue(PARTY_LEADER_KEY, "") || "";
  var isPartyLeader = leaderPartyName === partyName;

  if (!partyToken) {
    partyToken = localStorage.getItem(PARTY_TOKEN_KEY) || "";
    if (partyToken) {
      GM_setValue(PARTY_TOKEN_KEY, partyToken);
      localStorage.removeItem(PARTY_TOKEN_KEY);
    }
  }

  var viewerOnly = localStorage.getItem(VIEWER_KEY) === "1";
  var bigMode = localStorage.getItem(BIG_KEY) === "1";

  var nameSetupOpen = false;
  var registered = false;
  // Registration is separate from party connectivity. A full party is a
  // stable condition, so polling must not retry /register every second.
  var registrationState = "unknown";
  var registrationBlockedState = null;
  var registrationInProgress = false;
  var latestState = null;
  var combatObserver = null;
  var seenNodes = new WeakSet();
  var selectedCharacterId = null;
  var latestStateRequestId = 0;
  var reconnectInProgress = false;
  var reconnectGeneration = 0;
  var serverHealth = "unknown";

  GM_addValueChangeListener(PARTY_TOKEN_KEY, function (key, oldValue, newValue, remote) {
    if (!newValue || newValue === partyToken) {
      return;
    }

    debugLog("Token da party atualizado por outra aba", { remote: remote });
    partyToken = newValue;
    registered = false;
    registrationState = "unknown";
    registrationBlockedState = null;
    registrationInProgress = false;
    reconnectInProgress = false;
    reconnectGeneration++;
    latestStateRequestId++;
    poll();
  });

  function debugLog(message, details) {
    if (details === undefined) {
      console.info("[Huntera Party Analyzer] " + message);
      return;
    }
    console.info("[Huntera Party Analyzer] " + message, details);
  }

  function partyStateSignature(state) {
    if (!state || !state.chars) {
      return "";
    }
    return Object.keys(state.chars).sort().map(function (id) {
      var character = state.chars[id];
      return id + ":" + character.name + ":" + character.voc;
    }).join("|");
  }

  function partyHasMyCharacterElsewhere(state) {
    if (!state || !state.chars || !myName) {
      return false;
    }
    var identity = myName.toLowerCase();
    return Object.keys(state.chars).some(function (id) {
      return id !== tabId &&
        String(state.chars[id].name || "").toLowerCase() === identity;
    });
  }

  function setServerHealth(status) {
    if (serverHealth === status) {
      return;
    }
    serverHealth = status;
    var indicator = panel && panel.querySelector(".server-health");
    if (indicator) {
      indicator.className = "server-health " + status;
      indicator.title = status === "online"
        ? "Servidor online"
        : status === "checking"
          ? "Verificando servidor"
          : "Servidor offline ou sem resposta";
    }
    debugLog("Saúde do servidor: " + status);
  }

  function request(method, path, body, callback) {
    var headers = {
      "Content-Type": "application/json"
    };

    if (partyToken) {
      headers["X-Party-Token"] = partyToken;
    }

    GM_xmlhttpRequest({
      method: method,
      url: API + path,
      headers: headers,
      data: body ? JSON.stringify(body) : undefined,
      // O plano gratuito do Render pode levar alguns segundos para acordar.
      timeout: 15000,

      onload: function (r) {
        var data = null;

        try {
          data = JSON.parse(r.responseText);
        } catch (e) {}

        if (r.status >= 400) {
          debugLog("Resposta HTTP " + r.status + " em " + path);
        }
        callback(null, r.status, data);
      },

      onerror: function (details) {
        var error = new Error("API offline");
        error.details = details;
        debugLog("Erro de rede em " + path, details);
        callback(error);
      },

      ontimeout: function () {
        debugLog("Timeout em " + path);
        callback(new Error("API timeout"));
      }
    });
  }

  function loadPos() {
    try {
      var raw = localStorage.getItem(POS_KEY);
      return raw ? JSON.parse(raw) : { top: 12, right: 12 };
    } catch (e) {
      return { top: 12, right: 12 };
    }
  }

  function savePos(pos) {
    try {
      localStorage.setItem(POS_KEY, JSON.stringify(pos));
    } catch (e) {}
  }

  function clampToViewport(save) {
    var rect = host.getBoundingClientRect();
    var margin = 8;
    var maxTop = Math.max(margin, window.innerHeight - rect.height - margin);
    var maxRight = Math.max(margin, window.innerWidth - rect.width - margin);
    var top = Math.min(Math.max(rect.top, margin), maxTop);
    var right = Math.min(Math.max(window.innerWidth - rect.right, margin), maxRight);

    host.style.top = top + "px";
    host.style.right = right + "px";

    if (save) {
      savePos({ top: Math.round(top), right: Math.round(right) });
    }
  }

  var pos = loadPos();

  var host = document.createElement("div");
  host.id = "hunta-dps-counter-host";
  host.style.position = "fixed";
  host.style.top = pos.top + "px";
  host.style.right = pos.right + "px";
  host.style.maxWidth = "calc(100vw - 16px)";
  host.style.zIndex = "2147483647";

  document.body.appendChild(host);

  var root = host.attachShadow({ mode: "open" });

  var style = document.createElement("style");

  style.textContent = [
    "*{box-sizing:border-box}",
    ":host{all:initial}",

    ".panel{font-family:Inter,system-ui,-apple-system,'Segoe UI',Arial,sans-serif;color:#eef2f6;width:310px;max-width:calc(100vw - 16px);background:rgba(16,20,28,.92);backdrop-filter:blur(6px);border:1px solid rgba(255,255,255,.09);border-radius:10px;box-shadow:0 8px 24px rgba(0,0,0,.45);overflow:hidden;font-variant-numeric:tabular-nums}",

    ".panel.big{width:520px;max-width:calc(100vw - 16px)}",

    ".head{display:flex;align-items:center;gap:6px;padding:7px 9px;cursor:move;user-select:none;background:rgba(0,0,0,.25);border-bottom:1px solid rgba(255,255,255,.08)}",

    ".title{font-weight:700;font-size:12.5px;color:#6fd8f0;letter-spacing:.03em;flex:1}",

    ".status{font-size:9px;font-weight:700;letter-spacing:.04em}",

    ".status.on{color:#4ee87a}.status.off{color:#e8a44e}.status.err{color:#e8544e}",

    ".server-health{width:7px;height:7px;flex:0 0 7px;border-radius:50%;background:#8b95a3;box-shadow:0 0 0 2px rgba(139,149,163,.15)}.server-health.online{background:#4ee87a;box-shadow:0 0 0 2px rgba(78,232,122,.16)}.server-health.checking{background:#e8a44e;box-shadow:0 0 0 2px rgba(232,164,78,.16)}.server-health.offline{background:#e8544e;box-shadow:0 0 0 2px rgba(232,84,78,.16)}",

    ".btn{appearance:none;border:none;background:transparent;color:#aeb8c4;cursor:pointer;font-size:13px;line-height:1;padding:3px 5px;border-radius:5px}.btn:hover{background:rgba(255,255,255,.08);color:#fff}",

    ".body{padding:8px 9px}",

    ".summary{font-size:9px;color:#9da8b5;margin:0 2px 6px;display:flex;justify-content:space-between;gap:12px}",

    ".summary-meta,.summary-totals{display:flex;flex-direction:column;gap:2px}.summary-totals{text-align:right;color:#eef2f6;font-weight:700}.summary-totals span{white-space:nowrap}",

    ".rows{display:flex;flex-direction:column;gap:5px}",

    ".row{position:relative;border-radius:6px;overflow:hidden;background:rgba(4,7,12,.5);border:1px solid rgba(255,255,255,.06);cursor:pointer}.row:focus-visible{outline:2px solid #6fd8f0;outline-offset:1px}",

    ".row.stale{opacity:.45}.fill{position:absolute;inset:0;height:100%;border-radius:6px;opacity:.75;transition:width .3s ease}",

    ".content{position:relative;display:flex;align-items:flex-start;padding:6px 8px;gap:6px;text-shadow:0 1px 2px rgba(0,0,0,.85)}",

    ".rank{opacity:.75;width:12px;flex:0 0 12px;font-size:11px;font-weight:600;line-height:1.2;margin-top:0}",

    ".main{flex:1;min-width:0;display:flex;flex-direction:column;gap:2px}",

    ".top{display:flex;align-items:flex-start;gap:6px}.name{flex:1;min-width:0;font-size:11px;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.value{font-size:11px;font-weight:700;white-space:nowrap}.value-xp{font-size:11px;font-weight:700;color:#d6e4ec;white-space:nowrap}",

    ".sub{display:flex;align-items:center;justify-content:space-between;gap:8px;font-size:9px;font-weight:500;opacity:.85;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.sub-metrics{min-width:0;overflow:hidden;text-overflow:ellipsis}",

    ".detail{display:flex;flex-direction:column;gap:10px}.detail-back{align-self:flex-start;border:1px solid rgba(255,255,255,.12);background:rgba(255,255,255,.06);color:#eef2f6;border-radius:6px;padding:5px 8px;cursor:pointer;font-size:10px;font-weight:600}.detail-heading{display:flex;align-items:center;justify-content:space-between;gap:8px}.detail-name{font-size:14px;font-weight:700;color:#eef2f6}.detail-voc{font-size:10px;color:#9da8b5}.detail-grid{display:grid;grid-template-columns:1fr 1fr;gap:6px}.detail-stat{padding:7px 8px;background:rgba(4,7,12,.5);border:1px solid rgba(255,255,255,.06);border-radius:6px}.detail-label{display:block;color:#9da8b5;font-size:9px}.detail-value{display:block;color:#eef2f6;font-size:12px;font-weight:700;margin-top:2px}",

    ".setup{display:flex;gap:6px;align-items:center}.setup input,.setup select,.party-setup input{min-width:0;background:rgba(4,7,12,.55);border:1px solid rgba(255,255,255,.12);border-radius:6px;color:#eef2f6;font-size:11px;padding:5px 6px;font-family:inherit}.setup input{flex:1}.setup button,.party-actions button{border:1px solid rgba(255,255,255,.12);background:#2f6aa3;color:#fff;border-radius:6px;padding:5px 8px;cursor:pointer;font-size:11px;font-weight:600}.party-setup{display:flex;flex-direction:column;gap:6px}.party-setup input{width:100%}.party-actions{display:flex;gap:6px}.party-actions button{flex:1}.viewer{font-size:10px;color:#8fb8d6;text-decoration:underline;cursor:pointer;margin-top:7px}.empty{text-align:center;color:#8b95a3;font-size:10px;padding:8px}.error{text-align:center;color:#e8a44e;font-size:10px;padding:8px;min-height:12px}",

    ".panel.big .title{font-size:18px}.panel.big .status{font-size:12px}.panel.big .btn{font-size:18px}.panel.big .body{padding:12px}.panel.big .row{border-radius:9px}.panel.big .content{padding:9px 14px}.panel.big .rank{font-size:16px;width:22px}.panel.big .name,.panel.big .value,.panel.big .value-xp{font-size:16px}.panel.big .sub{font-size:12px}.panel.big .summary{font-size:11px}"

  ].join("");

  root.appendChild(style);

  var panel = document.createElement("div");
  panel.className = "panel" + (bigMode ? " big" : "");

  root.appendChild(panel);

  clampToViewport(true);
  window.addEventListener("resize", function () {
    clampToViewport(true);
  });

  function fmt(n) {
    n = Number(n) || 0;

    if (n >= 1000000) {
      return (n / 1000000).toFixed(2) + "M";
    }

    if (n >= 1000) {
      return (n / 1000).toFixed(2) + "K";
    }

    return String(Math.round(n));
  }

  function fmtTime(sec) {
    sec = Math.max(0, Math.floor(sec || 0));

    var m = Math.floor(sec / 60);
    var s = sec % 60;

    return m + ":" + String(s).padStart(2, "0");
  }

  function esc(s) {
    return String(s).replace(/[&<>"']/g, function (m) {
      return ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        "\"": "&quot;",
        "'": "&#39;"
      })[m];
    });
  }

  function setStatus(text, cls) {
    var el = panel.querySelector(".status");

    if (el) {
      el.textContent = text;
      el.className = "status " + cls;
    }
  }

  function showPartySetup() {
    if (nameSetupOpen) {
      return;
    }

    nameSetupOpen = true;
    var body = panel.querySelector(".body");
    body.innerHTML =
      '<div class="party-setup">' +
        '<input data-party-name placeholder="Nome da PT" maxlength="40">' +
        '<input data-party-password type="password" placeholder="Senha (min. 4)" maxlength="100">' +
        '<div class="party-actions">' +
          '<button data-party-connect>Conectar à PT</button>' +
          '<button data-party-create>Criar nova PT</button>' +
        '</div>' +
        '<div class="error" data-party-error></div>' +
      '</div>';

    var nameInput = body.querySelector("[data-party-name]");
    var passwordInput = body.querySelector("[data-party-password]");
    var error = body.querySelector("[data-party-error]");

    nameInput.value = partyName;

    function submit(path) {
      var name = nameInput.value.trim();
      var password = passwordInput.value;
      if (
        path === "/party/create" &&
        partyName &&
        name.toLowerCase() === partyName.toLowerCase() &&
        !isPartyLeader
      ) {
        error.textContent = "Somente o líder pode recriar esta PT.";
        return;
      }
      error.textContent = "";
      setStatus("CONECTANDO", "off");

      request("POST", path, {
        party_name: name,
        password: password
      }, function (err, status, data) {
        if (err) {
          error.textContent = err.message === "API timeout"
            ? "Tempo esgotado. O Render pode estar acordando; tente novamente."
            : "Falha de acesso ao Render. Confira as permissões do Tampermonkey.";
          setStatus("ERRO API", "err");
          return;
        }
        if (status !== 200 && status !== 201) {
          error.textContent = status === 409
            ? "Já existe uma PT com esse nome."
            : "Nome ou senha inválidos.";
          return;
        }

        partyName = data.party_name;
        partyToken = data.party_token;
        partyPassword = password;
        localStorage.setItem(PARTY_NAME_KEY, partyName);
        GM_setValue(PARTY_PASSWORD_KEY, partyPassword);
        GM_setValue(PARTY_TOKEN_KEY, partyToken);
        isPartyLeader = status === 201 && path === "/party/create";
        if (isPartyLeader) {
          GM_setValue(PARTY_LEADER_KEY, partyName);
          leaderPartyName = partyName;
        }
        localStorage.removeItem(PARTY_TOKEN_KEY);
        nameSetupOpen = false;
        registered = false;
        registrationState = "unknown";
        registrationBlockedState = null;
        render(latestState || { chars: {}, activeSeconds: 0 });
        if (!myName && !viewerOnly) {
          showSetup();
        } else if (!viewerOnly) {
          register();
        }
      });
    }

    body.querySelector("[data-party-connect]").addEventListener("click", function () {
      submit("/party/connect");
    });
    body.querySelector("[data-party-create]").addEventListener("click", function () {
      submit("/party/create");
    });

    setTimeout(function () {
      nameInput.focus();
    }, 0);
  }

  function showSetup() {
    if (!partyToken) {
      showPartySetup();
      return;
    }

    if (nameSetupOpen) {
      return;
    }

    nameSetupOpen = true;

    var body = panel.querySelector(".body");

    body.innerHTML = "";

    var wrap = document.createElement("div");
    wrap.className = "setup";

    var input = document.createElement("input");
    input.placeholder = "Nome do personagem";
    input.value = myName;

    var select = document.createElement("select");

    select.innerHTML = VOCATIONS.map(function (v) {
      return '<option value="' +
        v.key +
        '">' +
        v.key +
        " - " +
        v.label +
        "</option>";
    }).join("");

    if (myVoc) {
      select.value = myVoc;
    }

    var save = document.createElement("button");
    save.textContent = "Salvar";

    wrap.appendChild(input);
    wrap.appendChild(select);
    wrap.appendChild(save);

    body.appendChild(wrap);

    var viewer = document.createElement("div");
    viewer.className = "viewer";
    viewer.textContent = "Só visualizar (esta aba não é personagem)";

    body.appendChild(viewer);

    function commit() {
      var name = input.value.trim();

      if (!name) {
        return;
      }

      myName = name;
      myVoc = select.value;
      viewerOnly = false;
      registrationState = "unknown";
      registrationBlockedState = null;

      localStorage.setItem(NAME_KEY, myName);
      localStorage.setItem(VOC_KEY, myVoc);
      localStorage.setItem(VIEWER_KEY, "0");

      nameSetupOpen = false;

      register();
    }

    save.addEventListener("click", commit);

    input.addEventListener("keydown", function (e) {
      if (e.key === "Enter") {
        commit();
      }
    });

    viewer.addEventListener("click", function () {
      viewerOnly = true;

      localStorage.setItem(VIEWER_KEY, "1");

      nameSetupOpen = false;

      render(
        latestState || {
          chars: {},
          combatActive: false,
          activeSeconds: 0
        }
      );
    });

    setTimeout(function () {
      input.focus();
    }, 0);
  }

  function header() {
    panel.innerHTML =
      '<div class="head">' +
        '<span class="title">⚔️ Huntera Party Analyzer</span>' +
        '<span class="status off">OFFLINE</span>' +
      '<span class="server-health checking" title="Verificando servidor"></span>' +
        '<button class="btn" data-a="party" title="Trocar ou criar PT">♟</button>' +
        '<button class="btn" data-a="big" title="Modo grande">⛶</button>' +
        '<button class="btn" data-a="export" title="Exportar dados da PT">⇩</button>' +
        '<button class="btn" data-a="reset" title="Resetar contagem">↺</button>' +
        '<button class="btn" data-a="rename" title="Renomear">✎</button>' +
      '</div>' +
      '<div class="body"></div>';

    panel.querySelector('[data-a="big"]').addEventListener("click", function () {
      bigMode = !bigMode;

      localStorage.setItem(
        BIG_KEY,
        bigMode ? "1" : "0"
      );

      panel.classList.toggle("big", bigMode);

      render(
        latestState || {
          chars: {},
          activeSeconds: 0
        }
      );
    });

    panel.querySelector('[data-a="party"]').addEventListener("click", function () {
      nameSetupOpen = false;
      showPartySetup();
    });

    panel.querySelector('[data-a="export"]').addEventListener(
      "click",
      exportPartyData
    );

    panel.querySelector('[data-a="reset"]').addEventListener(
      "click",
      resetFight
    );

    panel.querySelector('[data-a="rename"]').addEventListener(
      "click",
      function () {
        nameSetupOpen = false;
        showSetup();
      }
    );
  }

  header();

  function checkServerHealth() {
    setServerHealth("checking");
    request("GET", "/health", null, function (err, status, data) {
      if (!err && status === 200 && data && data.ok) {
        setServerHealth("online");
        return;
      }
      setServerHealth("offline");
      debugLog("Health check sem resposta válida", {
        status: status,
        error: err ? err.message : null
      });
    });
  }

  function exportPartyData() {
    if (!latestState) {
      setStatus("SEM DADOS", "off");
      return;
    }

    var exportData = {
      exportedAt: new Date().toISOString(),
      partyName: partyName,
      resetAt: latestState.resetAt || null,
      fightStartedAt: latestState.fightStartedAt || null,
      lastHitAt: latestState.lastHitAt || null,
      activeSeconds: latestState.activeSeconds || 0,
      xpActiveSeconds: latestState.xpActiveSeconds || 0,
      combatActive: Boolean(latestState.combatActive),
      characters: latestState.chars || {}
    };
    var json = JSON.stringify(exportData, null, 2);

    function copied() {
      setStatus("EXPORTADO", "on");
      setTimeout(function () {
        render(latestState);
      }, 1500);
    }

    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(json).then(copied).catch(function () {
        copyWithFallback(json, copied);
      });
      return;
    }

    copyWithFallback(json, copied);
  }

  function copyWithFallback(text, callback) {
    var textarea = document.createElement("textarea");
    textarea.value = text;
    textarea.style.position = "fixed";
    textarea.style.opacity = "0";
    document.body.appendChild(textarea);
    textarea.focus();
    textarea.select();

    var copied = false;
    try {
      copied = document.execCommand("copy");
    } catch (e) {}

    textarea.remove();
    setStatus(copied ? "EXPORTADO" : "ERRO COPIA", copied ? "on" : "err");
    if (copied) {
      callback();
    }
  }

  function render(data) {
    if (!data) {
      return;
    }

    var incomingChars = data.chars || {};
    var currentChars = latestState && latestState.chars || {};
    if (
      Object.keys(incomingChars).length === 0 &&
      Object.keys(currentChars).length > 0
    ) {
      return;
    }

    latestState = data;

    // IMPORTANTE:
    // Nunca destrói o formulário enquanto o usuário estiver digitando.
    if (nameSetupOpen) {
      return;
    }

    var body = panel.querySelector(".body");
    var chars = data.chars || {};

    var list = Object.keys(chars).map(function (id) {
      var c = chars[id];

      return {
        id: id,
        name: c.name || "Sem nome",
        voc: c.voc || "",
        damage: Number(c.damage) || 0,
        maxHit: Number(c.maxHit) || 0,
        xp: Number(c.xp) || 0,
        lastSeen: Number(c.lastSeen) || 0,
        rolling10sDps: Number(c.rolling10sDps) || 0
      };
    });

    // Ranking por dano total.
    list.sort(function (a, b) {
      return b.damage - a.damage;
    });

    if (selectedCharacterId && !chars[selectedCharacterId]) {
      selectedCharacterId = null;
    }

    if (!myName && !viewerOnly) {
      showSetup();
      return;
    }

    var now = Number(data.serverNow) || Date.now();

    var total = list.reduce(function (s, c) {
      return s + c.damage;
    }, 0);

    var max = Math.max.apply(
      null,
      list.map(function (c) {
        return c.damage;
      })
    ) || 1;

    var statusText = data.combatActive
      ? "● COMBAT"
      : (data.lastHitAt ? "○ PAUSADO" : "○ AGUARDANDO");

    setStatus(
      statusText,
      data.combatActive ? "on" : "off"
    );

    var summary =
      '<div class="summary">' +
        '<div class="summary-meta">' +
          '<span>Tempo da sessão: ' +
            fmtTime(data.fightDurationSeconds || data.activeSeconds || 0) +
          '</span>' +
        '</div>' +
      '</div>';

    if (!list.length) {
      body.innerHTML =
        summary +
        '<div class="empty">Aguardando dano...</div>';

      return;
    }

    if (selectedCharacterId) {
      var selected = list.find(function (character) {
        return character.id === selectedCharacterId;
      });

      if (selected) {
        var selectedVoc = VOC_BY_KEY[selected.voc];
        var selectedDps = (data.fightDurationSeconds || data.activeSeconds) > 0
          ? selected.damage / (data.fightDurationSeconds || data.activeSeconds)
          : 0;
        var selectedXph = data.xpActiveSeconds > 0
          ? selected.xp / data.xpActiveSeconds * 3600
          : 0;
        var selectedShare = total
          ? Math.round(selected.damage / total * 100)
          : 0;
        var detail = document.createElement("div");
        detail.className = "detail";
        detail.innerHTML =
          '<button class="detail-back" type="button">← Voltar para a PT</button>' +
          '<div class="detail-heading">' +
            '<span class="detail-name">' + esc(selected.name) + '</span>' +
            '<span class="detail-voc">' + esc(selectedVoc ? selectedVoc.label : selected.voc) + '</span>' +
          '</div>' +
          '<div class="detail-grid">' +
            '<div class="detail-stat"><span class="detail-label">Dano total</span><span class="detail-value">' + fmt(selected.damage) + '</span></div>' +
            '<div class="detail-stat"><span class="detail-label">Participacao</span><span class="detail-value">' + selectedShare + '%</span></div>' +
            '<div class="detail-stat"><span class="detail-label">DPS principal</span><span class="detail-value">' + fmt(selectedDps) + '/s</span></div>' +
            '<div class="detail-stat"><span class="detail-label">DPS ultimos 10s</span><span class="detail-value">' + fmt(selected.rolling10sDps) + '/s</span></div>' +
            '<div class="detail-stat"><span class="detail-label">Maior hit</span><span class="detail-value">' + fmt(selected.maxHit) + '</span></div>' +
            '<div class="detail-stat"><span class="detail-label">XP total</span><span class="detail-value">' + fmt(selected.xp) + '</span></div>' +
            '<div class="detail-stat"><span class="detail-label">XP por hora</span><span class="detail-value">' + fmt(selectedXph) + '</span></div>' +
          '</div>';
        body.innerHTML = summary;
        body.appendChild(detail);
        detail.querySelector(".detail-back").addEventListener("click", function () {
          selectedCharacterId = null;
          render(latestState);
        });
        return;
      }
    }

    var rows = document.createElement("div");
    rows.className = "rows";

    list.forEach(function (c, i) {
      var pct = Math.max(
        2,
        Math.round(c.damage / max * 100)
      );

      var stale = now - c.lastSeen > STALE_MS;

      var voc = VOC_BY_KEY[c.voc];

      var color = voc
        ? voc.color
        : "#8b95a3";

      var dps =
        (data.fightDurationSeconds || data.activeSeconds) > 0
          ? c.damage / (data.fightDurationSeconds || data.activeSeconds)
          : 0;

      var xph =
        data.xpActiveSeconds > 0
          ? c.xp / data.xpActiveSeconds * 3600
          : 0;

      var tag = voc
        ? " [" + voc.key + "]"
        : "";

      var row = document.createElement("div");

      row.className =
        "row" +
        (stale ? " stale" : "");
      row.tabIndex = 0;
      row.setAttribute("role", "button");
      row.setAttribute("aria-label", "Ver detalhes de " + c.name);

      row.innerHTML =
        '<div class="fill" style="width:' +
          pct +
          '%;background:' +
          color +
        '"></div>' +

        '<div class="content">' +

          '<span class="rank">' +
            (i + 1) +
            '.' +
          '</span>' +

          '<div class="main">' +

            '<div class="top">' +

              '<span class="name">' +
                esc(c.name) +
                esc(tag) +
              '</span>' +

              '<span class="value">Dano: ' +
                fmt(c.damage) +
              '</span>' +

            '</div>' +

            '<div class="sub">' +
              '<span class="sub-metrics">DPS: ' +
                fmt(dps) +
                ' · XP/h: ' +
                fmt(xph) +
              '</span>' +
              '<span class="value-xp">Exp: ' +
                fmt(c.xp) +
              '</span>' +
            '</div>' +

          '</div>' +

        '</div>';

      rows.appendChild(row);

      function openDetails() {
        selectedCharacterId = c.id;
        render(latestState);
      }

      row.addEventListener("click", openDetails);
      row.addEventListener("keydown", function (event) {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          openDetails();
        }
      });
    });

    body.innerHTML = summary;
    body.appendChild(rows);
  }

  function register() {
    if (
      viewerOnly ||
      !myName ||
      !partyToken ||
      registrationState !== "unknown" ||
      registrationInProgress
    ) {
      return;
    }

    registrationInProgress = true;
    var registrationToken = partyToken;

    setStatus(
      "CONECTANDO",
      "off"
    );

    request(
      "POST",
      "/register",
      {
        client_id: tabId,
        name: myName,
        voc: myVoc
      },
      function (err, status, data) {

        // The party may have been recreated while this request was in flight.
        if (registrationToken !== partyToken) {
          return;
        }

        registrationInProgress = false;

        if (err) {
          registered = false;
          setStatus("OFFLINE", "err");
          return;
        }

        if (status === 409) {
          registered = false;
          registrationState = "blocked";
          // /register errors do not contain a party snapshot. If polling has
          // not produced one yet, capture the first snapshot without treating
          // it as a change that warrants an immediate retry.
          registrationBlockedState = latestState
            ? partyStateSignature(latestState)
            : null;
          debugLog("Registro bloqueado por 409; aguardando mudanÃ§a da party");
          setStatus("4/4", "err");

          latestState =
            data || latestState;

          render(latestState);

          return;
        }

        if (status !== 200 || !data) {
          registered = false;
          registrationState = "unknown";
          setStatus("ERRO", "err");
          return;
        }

        registered = true;
        registrationState = "registered";
        registrationBlockedState = null;

        render(data);
      }
    );
  }

  function resetFight() {
    if (!partyToken) {
      showPartySetup();
      return;
    }

    if (!myName && !viewerOnly) {
      showSetup();
      return;
    }

    request(
      "POST",
      "/reset",
      {
        client_id: tabId
      },
      function (err, status, data) {

        if (!err && status === 200) {
          latestState = data;
          render(data);
        }

      }
    );
  }

  function sendHit(damage) {
    if (viewerOnly || !registered || !partyToken) {
      return;
    }

    request(
      "POST",
      "/hit",
      {
        client_id: tabId,
        damage: damage,
        ts: Date.now()
      },
      function (err, status, data) {

        if (status === 409) {
          registered = false;
          registrationState = "unknown";
        }

      }
    );
  }

  function sendXp(amount) {
    if (viewerOnly || !registered || !partyToken) {
      return;
    }

    request(
      "POST",
      "/xp",
      {
        client_id: tabId,
        amount: amount,
        ts: Date.now()
      },
      function (err, status) {
        if (status === 409) {
          registered = false;
          registrationState = "unknown";
        }
      }
    );
  }

  // =========================================================
  // COMBAT LOG
  // =========================================================
  //
  // Formatos aceitos:
  //
  // You hit <target> for 123.
  // Critical! You hit <target> for 123.
  // You hit <target> for 1.234.
  // You hit <target> for 12.345.
  // You hit <target> for 123.456.
  // Você acertou <target> causando 123.456.
  // Crítico! Você acertou <target> causando 123.456.
  //
  // O ponto é tratado como separador de milhares.
  //
  var DEALT_PATTERNS = [
    {
      language: "en",
      regex: /^(?:Critical!\s+)?You hit .+ for (\d{1,3}(?:[,.]\d{3})+|\d+)/i
    },
    {
      language: "pt",
      regex: /^(?:Crítico!\s+)?Você acertou .+ causando (\d{1,3}(?:[,.]\d{3})+|\d+)/i
    }
  ];

  var XP_PATTERNS = [
    /^Você ganhou (\d{1,3}(?:\.\d{3})*) de experiência\.?$/i,
    /^You gained (\d{1,3}(?:,\d{3})*) experience points\.?$/i
  ];

  var detectedCombatLanguage = null;

  function matchDamage(text) {
    var patterns = detectedCombatLanguage
      ? DEALT_PATTERNS.filter(function (pattern) {
          return pattern.language === detectedCombatLanguage;
        })
      : DEALT_PATTERNS;

    for (var i = 0; i < patterns.length; i++) {
      var match = patterns[i].regex.exec(text);

      if (match) {
        detectedCombatLanguage = patterns[i].language;
        return match;
      }
    }

    // Permite recuperar caso o idioma do jogo seja alterado durante a sessão.
    if (detectedCombatLanguage) {
      detectedCombatLanguage = null;
      return matchDamage(text);
    }

    return null;
  }

  function matchXp(text) {
    for (var i = 0; i < XP_PATTERNS.length; i++) {
      var match = XP_PATTERNS[i].exec(text);

      if (match) {
        return match;
      }
    }

    return null;
  }

  function handleLine(node) {
    if (
      !node ||
      node.nodeType !== 1 ||
      seenNodes.has(node)
    ) {
      return;
    }

    seenNodes.add(node);

    var span =
      node.querySelector(".combat-text");

    if (!span) {
      return;
    }

    var text =
      (span.textContent || "").trim();

    var xpMatch =
      matchXp(text);

    if (xpMatch) {
      var xp =
        parseInt(
          xpMatch[1].replace(/[.,]/g, ""),
          10
        ) || 0;

      if (xp > 0) {
        sendXp(xp);
      }

      return;
    }

    var m =
      matchDamage(text);

    if (!m) {
      return;
    }

    var hit =
      parseInt(
        m[1].replace(/[.,]/g, ""),
        10
      ) || 0;

    if (hit > 0) {
      sendHit(hit);
    }
  }

  function attachCombatLog(logEl) {
    if (combatObserver) {
      combatObserver.disconnect();
    }

    // IMPORTANTE:
    // Não processa as linhas antigas do log.
    //
    // Isso evita contar novamente o dano quando:
    // - recarrega a página;
    // - fecha/abre o navegador;
    // - reinicia o script.
    //
    // O servidor mantém o estado atual da hunt.
    var mo =
      new MutationObserver(
        function (mutations) {

          mutations.forEach(
            function (mut) {

              mut.addedNodes.forEach(
                function (node) {
                  handleLine(node);
                }
              );

            }
          );

        }
      );

    mo.observe(
      logEl,
      {
        childList: true
      }
    );

    combatObserver = mo;

    console.log(
      "[hunta-dps] Combat observer attached"
    );
  }

  function waitForCombatLog() {
    var el =
      document.querySelector(
        ".chat-combat-log"
      );

    if (el) {
      attachCombatLog(el);
      return;
    }

    var mo =
      new MutationObserver(
        function () {

          var found =
            document.querySelector(
              ".chat-combat-log"
            );

          if (found) {
            mo.disconnect();
            attachCombatLog(found);
          }

        }
      );

    mo.observe(
      document.body,
      {
        childList: true,
        subtree: true
      }
    );
  }

  // =========================================================
  // DRAGGING
  // =========================================================

  (function () {

    var head =
      panel.querySelector(".head");

    var dragging = false;
    var sx = 0;
    var sy = 0;
    var st = 0;
    var sr = 0;

    head.addEventListener(
      "mousedown",
      function (e) {

        if (
          e.target.closest(".btn")
        ) {
          return;
        }

        dragging = true;

        sx = e.clientX;
        sy = e.clientY;

        var r =
          host.getBoundingClientRect();

        st = r.top;
        sr =
          window.innerWidth -
          r.right;

        e.preventDefault();
      }
    );

    window.addEventListener(
      "mousemove",
      function (e) {

        if (!dragging) {
          return;
        }

        host.style.top =
          (st + e.clientY - sy) +
          "px";

        host.style.right =
          (sr - (e.clientX - sx)) +
          "px";

        clampToViewport(false);

      }
    );

    window.addEventListener(
      "mouseup",
      function () {

        if (!dragging) {
          return;
        }

        dragging = false;

        savePos({
          top: parseInt(
            host.style.top,
            10
          ),

          right: parseInt(
            host.style.right,
            10
          )
        });

      }
    );

  })();

  // =========================================================
  // POLLING DO SERVIDOR
  // =========================================================

  function poll() {
    var requestPartyToken = partyToken;
    var requestId = ++latestStateRequestId;

    request(
      "GET",
      "/state",
      null,
      function (err, status, data) {

        if (requestId !== latestStateRequestId) {
          return;
        }

        if (
          err ||
          status !== 200 ||
          !data
        ) {
          if (status === 401) {
            debugLog("Estado da party rejeitado (401)", {
              hasToken: Boolean(partyToken),
              partyName: partyName
            });
            if (requestPartyToken !== partyToken) {
              return;
            }

            if (partyName && partyPassword && !reconnectInProgress) {
              reconnectParty(0, reconnectGeneration);
              return;
            }

            partyToken = "";
            GM_deleteValue(PARTY_TOKEN_KEY);
            localStorage.removeItem(PARTY_TOKEN_KEY);
            registered = false;
            registrationState = "unknown";
            registrationBlockedState = null;
            registrationInProgress = false;
            showPartySetup();
            setStatus("PT NÃO CONECTADA", "off");
            return;
          }

          setStatus(
            "OFFLINE",
            "err"
          );

          return;
        }

        var currentPartyState = partyStateSignature(data);
        if (registrationState === "unknown" &&
            partyHasMyCharacterElsewhere(data)) {
          // This is the old tab after another session took over the same
          // character. Do not reclaim it on the next /hit or /xp 409.
          registered = false;
          registrationState = "claimed";
          registrationBlockedState = currentPartyState;
          debugLog("Personagem jÃ¡ estÃ¡ ativo em outra aba");
          setStatus("OUTRA ABA", "err");
        } else if (registrationState === "blocked") {
          if (registrationBlockedState === null) {
            registrationBlockedState = currentPartyState;
          } else if (currentPartyState !== registrationBlockedState) {
            debugLog("Estado da party mudou; liberando novo registro");
            registrationState = "unknown";
            registrationBlockedState = null;
          }
        }

        if (!viewerOnly && myName && registrationState === "unknown") {
          register();
        }

        render(data);
      }
    );
  }

  function reconnectParty(attempt) {
    attempt = attempt || 0;
    var generation = arguments.length > 1
      ? arguments[1]
      : reconnectGeneration;
    if (generation !== reconnectGeneration) {
      return;
    }
    reconnectInProgress = true;
    debugLog("Iniciando reconexão da party", {
      partyName: partyName,
      attempt: attempt + 1,
      leader: isPartyLeader
    });
    setStatus("RECONECTANDO", "off");

    request("POST", "/party/connect", {
      party_name: partyName,
      password: partyPassword
    }, function (err, status, data) {
      if (generation !== reconnectGeneration) {
        return;
      }

      if (!err && status === 200 && data && data.party_token) {
        debugLog("Party reconectada");
        partyToken = data.party_token;
        GM_setValue(PARTY_TOKEN_KEY, partyToken);
        reconnectGeneration++;
        latestStateRequestId++;
        isPartyLeader = leaderPartyName === partyName;
        registered = false;
        registrationState = "unknown";
        registrationBlockedState = null;
        registrationInProgress = false;
        reconnectInProgress = false;
        if (!viewerOnly && myName) {
          register();
        }
        return;
      }

      if (!err && status === 401 && isPartyLeader) {
        debugLog("Party não encontrada; tentando recriar");
        request("POST", "/party/create", {
          party_name: partyName,
          password: partyPassword
        }, function (createErr, createStatus, createData) {
          if (generation !== reconnectGeneration) {
            return;
          }

          if (!createErr && createStatus === 201 && createData && createData.party_token) {
            debugLog("Party recriada após perda do estado do servidor");
            partyToken = createData.party_token;
            partyName = createData.party_name;
            GM_setValue(PARTY_TOKEN_KEY, partyToken);
            reconnectGeneration++;
            latestStateRequestId++;
            localStorage.setItem(PARTY_NAME_KEY, partyName);
            registered = false;
            registrationState = "unknown";
            registrationBlockedState = null;
            registrationInProgress = false;
            reconnectInProgress = false;
            if (!viewerOnly && myName) {
              register();
            }
            return;
          }

          if (!createErr && createStatus === 409) {
            debugLog("Outra aba pode ter recriado a party; tentando conectar novamente");
            scheduleReconnect(attempt + 1, generation);
            return;
          }

          scheduleReconnect(attempt + 1, generation);
        });
        return;
      }

      if (!err && status === 401) {
        debugLog("Party ausente; aguardando recriação pelo líder");
        scheduleReconnect(attempt + 1, generation);
        return;
      }

      scheduleReconnect(attempt + 1, generation);
    });
  }

  function scheduleReconnect(attempt, generation) {
    if (generation !== reconnectGeneration) {
      return;
    }
    if (!isPartyLeader) {
      debugLog("Reconexão aguardando o líder", { partyName: partyName });
    }
    var delay = attempt >= 5
      ? 15000
      : Math.min(1000 * Math.pow(2, attempt), 8000);
    debugLog("Reconexão agendada", { attempt: attempt + 1, delayMs: delay });
    setStatus("RECONECTANDO", "off");
    setTimeout(function () {
      reconnectParty(attempt, generation);
    }, delay);
  }

  // =========================================================
  // HEARTBEAT
  // =========================================================
  //
  // Informa ao servidor que esse personagem
  // ainda está conectado.
  //

  function heartbeat() {

    if (
      !viewerOnly &&
      registered
    ) {

      request(
        "POST",
        "/heartbeat",
        {
          client_id: tabId
        },
        function () {}
      );

    }

  }

  // =========================================================
  // INICIALIZAÇÃO
  // =========================================================

  if (!partyToken) {
    showPartySetup();
  } else if (!myName && !viewerOnly) {
    showSetup();
  } else if (!viewerOnly) {
    register();
  } else {
    setStatus(
      "VISOR",
      "on"
    );
  }

  waitForCombatLog();

  checkServerHealth();
  setInterval(
    checkServerHealth,
    HEALTH_CHECK_MS
  );

  poll();

  setInterval(
    poll,
    POLL_MS
  );

  setInterval(
    heartbeat,
    HEARTBEAT_MS
  );

})();

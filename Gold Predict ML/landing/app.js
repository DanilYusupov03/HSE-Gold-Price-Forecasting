(function () {
  const isNode = typeof window === "undefined";

  if (isNode) {
    startServer();
  } else {
    window.addEventListener("DOMContentLoaded", startClient);
  }

  function startServer() {
    const http = require("http");
    const fs = require("fs");
    const path = require("path");

    const landingRoot = __dirname;
    const projectRoot = path.resolve(__dirname, "..");
    const port = Number(process.env.PORT || 8000);
    const host = process.env.HOST || "127.0.0.1";

    const mimeTypes = {
      ".html": "text/html; charset=utf-8",
      ".css": "text/css; charset=utf-8",
      ".js": "application/javascript; charset=utf-8",
      ".json": "application/json; charset=utf-8",
      ".csv": "text/csv; charset=utf-8",
      ".png": "image/png",
      ".jpg": "image/jpeg",
      ".jpeg": "image/jpeg",
      ".svg": "image/svg+xml",
    };

    const server = http.createServer(async (request, response) => {
      try {
        const url = new URL(request.url, `http://${request.headers.host || "localhost"}`);

        if (url.pathname === "/api/current-gold") {
          return sendJson(response, await getCurrentGold(projectRoot));
        }

        if (url.pathname === "/api/project-data") {
          return sendJson(response, readProjectData(projectRoot));
        }

        return serveStatic(url.pathname, response);
      } catch (error) {
        sendJson(response, { error: error.message }, 500);
      }
    });

    server.listen(port, host, () => {
      console.log(`Gold Forecast landing is running: http://localhost:${port}`);
      console.log("Press Ctrl+C to stop the local backend.");
    });

    function serveStatic(urlPath, response) {
      const cleanPath = decodeURIComponent(urlPath.split("?")[0]);
      let filePath;

      if (cleanPath === "/") {
        filePath = path.join(landingRoot, "index.html");
      } else if (cleanPath === "/style.css" || cleanPath === "/app.js") {
        filePath = path.join(landingRoot, cleanPath.slice(1));
      } else if (cleanPath.startsWith("/images/") || cleanPath.startsWith("/data/")) {
        filePath = path.join(projectRoot, cleanPath.slice(1));
      } else {
        filePath = path.join(landingRoot, cleanPath.slice(1));
      }

      const normalized = path.normalize(filePath);
      const allowed =
        normalized.startsWith(landingRoot) ||
        normalized.startsWith(path.join(projectRoot, "images")) ||
        normalized.startsWith(path.join(projectRoot, "data"));

      if (!allowed || !fs.existsSync(normalized) || fs.statSync(normalized).isDirectory()) {
        response.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
        response.end("Not found");
        return;
      }

      const ext = path.extname(normalized).toLowerCase();
      response.writeHead(200, {
        "Content-Type": mimeTypes[ext] || "application/octet-stream",
        "Cache-Control": "no-store",
      });
      fs.createReadStream(normalized).pipe(response);
    }

    function sendJson(response, payload, status = 200) {
      response.writeHead(status, {
        "Content-Type": "application/json; charset=utf-8",
        "Cache-Control": "no-store",
      });
      response.end(JSON.stringify(payload));
    }
  }

  async function getCurrentGold(projectRoot) {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 8000);
      const yahooUrl = "https://query1.finance.yahoo.com/v8/finance/chart/GC=F?range=1d&interval=1m";
      const response = await fetch(yahooUrl, {
        signal: controller.signal,
        headers: { "User-Agent": "gold-forecast-local-demo/1.0" },
      });
      clearTimeout(timeout);

      if (!response.ok) {
        throw new Error(`Yahoo Finance status ${response.status}`);
      }

      const payload = await response.json();
      const result = payload?.chart?.result?.[0];
      const meta = result?.meta || {};
      const quote = result?.indicators?.quote?.[0] || {};
      const closes = Array.isArray(quote.close) ? quote.close.filter(Number.isFinite) : [];
      const lastClose = closes.length ? closes[closes.length - 1] : null;
      const price = Number(meta.regularMarketPrice || lastClose);

      if (!Number.isFinite(price)) {
        throw new Error("Yahoo Finance returned empty price");
      }

      const previousClose = Number(meta.chartPreviousClose || meta.previousClose || closes[0] || price);
      const change = price - previousClose;
      const changePct = previousClose ? (change / previousClose) * 100 : null;

      return {
        ticker: "GC=F",
        price,
        previousClose,
        change,
        changePct,
        marketTime: meta.regularMarketTime ? new Date(meta.regularMarketTime * 1000).toISOString() : null,
        updatedAt: new Date().toISOString(),
        source: "Yahoo Finance live API",
      };
    } catch (error) {
      return getFallbackGold(projectRoot, error.message);
    }
  }

  function getFallbackGold(projectRoot, reason) {
    const path = require("path");
    const rows = csvToObjects(path.join(projectRoot, "data", "gold_market_data.csv"));
    const last = rows[rows.length - 1] || {};
    const price = toNumber(last.gold_close);

    return {
      ticker: "GC=F",
      price,
      previousClose: null,
      change: null,
      changePct: null,
      marketTime: last.date || null,
      updatedAt: new Date().toISOString(),
      source: "local CSV fallback",
      fallbackReason: reason,
    };
  }

  function readProjectData(projectRoot) {
    const path = require("path");

    const market = csvToObjects(path.join(projectRoot, "data", "gold_market_data.csv"));
    const modelResults = csvToObjects(path.join(projectRoot, "data", "model_results.csv"));
    const baselineResults = csvToObjects(path.join(projectRoot, "data", "baseline_results.csv"));
    const forecast = csvToObjects(path.join(projectRoot, "data", "forecast_30_days.csv"));
    const featureImportance = csvToObjects(path.join(projectRoot, "data", "feature_importance_top10.csv"));
    const testPredictions = csvToObjects(path.join(projectRoot, "data", "test_predictions.csv"));

    const first = market[0] || {};
    const last = market[market.length - 1] || {};
    const columns = Object.keys(first).filter((key) => key !== "date");
    const history = market.slice(-360).map((row) => ({
      date: row.date,
      price: toNumber(row.gold_close),
    }));

    return {
      summary: {
        rows: market.length,
        columns: columns.length,
        columnNames: columns,
        dateStart: first.date,
        dateEnd: last.date,
        lastGoldClose: toNumber(last.gold_close),
        featureCount: 38,
      },
      modelResults: modelResults.map(normalizeModelRow),
      baselineResults: baselineResults.map(normalizeBaselineRow),
      forecast: forecast.map((row) => ({
        date: row.date,
        predicted_gold_price: toNumber(row.predicted_gold_price),
      })),
      featureImportance: featureImportance.map((row) => ({
        feature: row.feature,
        importance: toNumber(row.importance),
      })),
      testPredictions: testPredictions.map((row) => ({
        date: row.date,
        actual: toNumber(row.actual),
        predicted: toNumber(row.predicted),
        error: toNumber(row.error),
        abs_error: toNumber(row.abs_error),
      })),
      history,
      generatedAt: new Date().toISOString(),
    };
  }

  function normalizeModelRow(row) {
    return {
      Model: row.Model,
      "MAE valid": toNumber(row["MAE valid"]),
      "RMSE valid": toNumber(row["RMSE valid"]),
      "MAPE valid": toNumber(row["MAPE valid"]),
      "MAE test": toNumber(row["MAE test"]),
      "RMSE test": toNumber(row["RMSE test"]),
      "MAPE test": toNumber(row["MAPE test"]),
      "Training time": toNumber(row["Training time"]),
      "Best params": row["Best params"] || "",
    };
  }

  function normalizeBaselineRow(row) {
    return {
      Model: row.Model,
      Split: row.Split,
      MAE: toNumber(row.MAE),
      RMSE: toNumber(row.RMSE),
      MAPE: toNumber(row.MAPE),
      R2: toNumber(row.R2),
    };
  }

  function csvToObjects(filePath) {
    const fs = require("fs");

    if (!fs.existsSync(filePath)) {
      return [];
    }

    const text = fs.readFileSync(filePath, "utf8").trim();
    if (!text) {
      return [];
    }

    const rows = parseCsv(text);
    const headers = rows.shift() || [];

    return rows
      .filter((row) => row.length && row.some((value) => value !== ""))
      .map((row) => {
        const object = {};
        headers.forEach((header, index) => {
          object[header] = row[index] ?? "";
        });
        return object;
      });
  }

  function parseCsv(text) {
    const rows = [];
    let row = [];
    let value = "";
    let inQuotes = false;

    for (let index = 0; index < text.length; index += 1) {
      const char = text[index];
      const next = text[index + 1];

      if (char === "\"") {
        if (inQuotes && next === "\"") {
          value += "\"";
          index += 1;
        } else {
          inQuotes = !inQuotes;
        }
      } else if (char === "," && !inQuotes) {
        row.push(value);
        value = "";
      } else if ((char === "\n" || char === "\r") && !inQuotes) {
        if (char === "\r" && next === "\n") {
          index += 1;
        }
        row.push(value);
        rows.push(row);
        row = [];
        value = "";
      } else {
        value += char;
      }
    }

    row.push(value);
    rows.push(row);
    return rows;
  }

  function toNumber(value) {
    const number = Number(value);
    return Number.isFinite(number) ? number : null;
  }

  function startClient() {
    const state = {
      projectData: null,
      currentGold: null,
    };

    const money = new Intl.NumberFormat("en-US", {
      style: "currency",
      currency: "USD",
      maximumFractionDigits: 2,
    });

    const number = new Intl.NumberFormat("en-US", {
      maximumFractionDigits: 2,
    });

    const compact = new Intl.NumberFormat("en-US", {
      maximumFractionDigits: 1,
    });

    loadProjectData();
    loadCurrentGold();
    setInterval(loadCurrentGold, 180000);
    setupScrollReveal();
    setupPressEffects();
    setupTeamInteractions();

    async function loadProjectData() {
      try {
        const data = await fetchJson("/api/project-data");
        state.projectData = data;
        renderSummary(data);
        renderMarketTables();
        renderModels(data);
        renderForecast(data);
        renderInterpretation(data);
      } catch (error) {
        console.error(error);
        setText("baselineNote", "API error");
      }
    }

    async function loadCurrentGold() {
      try {
        const data = await fetchJson("/api/current-gold");
        state.currentGold = data;
        renderCurrentGold(data);
      } catch (error) {
        console.error(error);
        setText("liveSource", "offline");
        setText("lastUpdated", "updated: API unavailable");
      }
    }

    async function fetchJson(url) {
      const response = await fetch(url, { cache: "no-store" });
      if (!response.ok) {
        throw new Error(`${url} returned ${response.status}`);
      }
      return response.json();
    }

    function setupScrollReveal() {
      const revealItems = Array.from(document.querySelectorAll(".reveal"));

      if (!("IntersectionObserver" in window)) {
        revealItems.forEach((item) => item.classList.add("is-visible"));
        return;
      }

      const observer = new IntersectionObserver(
        (entries) => {
          entries.forEach((entry) => {
            if (entry.isIntersecting) {
              entry.target.classList.add("is-visible");
              observer.unobserve(entry.target);
            }
          });
        },
        {
          threshold: 0.14,
          rootMargin: "0px 0px -8% 0px",
        }
      );

      revealItems.forEach((item) => observer.observe(item));
    }

    function setupPressEffects() {
      document.addEventListener("click", (event) => {
        const target = event.target.closest(".button, .team-chip, .feature-token");
        if (!target) {
          return;
        }

        const rect = target.getBoundingClientRect();
        const ripple = document.createElement("span");
        ripple.className = "ripple-effect";
        ripple.style.left = `${event.clientX - rect.left}px`;
        ripple.style.top = `${event.clientY - rect.top}px`;
        target.appendChild(ripple);

        window.setTimeout(() => ripple.remove(), 680);
      });
    }

    function setupTeamInteractions() {
      const teamMembers = {
        danil: {
          name: "Юсупов Данил",
          role: "ML Pipeline · Data",
          photo: "/assets/team-danil.svg",
          description: "Отвечает за структуру проекта, воспроизводимость пайплайна, подготовку данных и финальную сборку решения.",
        },
        pavel: {
          name: "Панчук Павел",
          role: "Modeling · Validation",
          photo: "/assets/team-pavel.svg",
          description: "Фокусируется на сравнении моделей, validation-подходе, метриках качества и аналитической интерпретации результатов.",
        },
        evgeniy: {
          name: "Маликов Евгений",
          role: "EDA · Presentation",
          photo: "/assets/team-evgeniy.svg",
          description: "Участвует в разведочном анализе, визуальном представлении результатов и формулировке выводов для защиты.",
        },
      };

      const chips = Array.from(document.querySelectorAll(".team-chip"));
      const preview = document.getElementById("teamPreview");
      const photo = document.getElementById("teamPhoto");
      const name = document.getElementById("teamName");
      const role = document.getElementById("teamRole");
      const description = document.getElementById("teamDescription");

      if (!chips.length || !preview || !photo || !name || !role || !description) {
        return;
      }

      const showMember = (memberKey) => {
        const member = teamMembers[memberKey];
        if (!member) {
          return;
        }

        chips.forEach((chip) => chip.classList.toggle("is-active", chip.dataset.member === memberKey));
        preview.classList.add("is-updating");
        window.setTimeout(() => preview.classList.remove("is-updating"), 220);

        photo.src = member.photo;
        photo.alt = member.name;
        name.textContent = member.name;
        role.textContent = member.role;
        description.textContent = member.description;
      };

      chips.forEach((chip) => {
        const memberKey = chip.dataset.member;
        chip.addEventListener("mouseenter", () => showMember(memberKey));
        chip.addEventListener("focus", () => showMember(memberKey));
        chip.addEventListener("click", () => showMember(memberKey));
      });

      showMember("danil");
    }

    async function fetchText(url) {
      const response = await fetch(url, { cache: "no-store" });
      if (!response.ok) {
        throw new Error(`${url} returned ${response.status}`);
      }
      return response.text();
    }

    function renderCurrentGold(data) {
      const price = Number(data.price);
      setText("currentPrice", Number.isFinite(price) ? money.format(price) : "$ --");
      setText("liveSource", data.source || "local API");

      if (Number.isFinite(data.change)) {
        const sign = data.change >= 0 ? "+" : "";
        setText("priceChange", `${sign}${money.format(data.change).replace("$", "$")} · ${sign}${compact.format(data.changePct)}%`);
        document.getElementById("priceChange").style.color = data.change >= 0 ? "var(--green)" : "var(--red)";
      } else {
        setText("priceChange", "change: local fallback");
      }

      const updated = data.updatedAt ? new Date(data.updatedAt).toLocaleTimeString("ru-RU") : "--";
      setText("lastUpdated", `updated: ${updated}`);
    }

    function renderSummary(data) {
      const { summary } = data;
      setText("dataPeriod", `${summary.dateStart} → ${summary.dateEnd}`);
      setText("lastLocalClose", money.format(summary.lastGoldClose));
    }

    async function renderMarketTables() {
      try {
        const csvText = await fetchText("/data/gold_market_data.csv");
        const rows = csvTextToObjects(csvText).map((row) => ({
          date: row.date,
          gold_close: toNumber(row.gold_close),
          usd_index_close: toNumber(row.usd_index_close),
          sp500_close: toNumber(row.sp500_close),
          wti_oil_close: toNumber(row.wti_oil_close),
          silver_close: toNumber(row.silver_close),
          us_10y_yield_close: toNumber(row.us_10y_yield_close),
        }));

        renderMarketSnapshot(rows);
        renderRecentMarketRows(rows);
        renderRiskMeter(rows);
      } catch (error) {
        console.error(error);
      }
    }

    function renderMarketSnapshot(rows) {
      const tbody = document.querySelector("#marketSnapshotTable tbody");
      if (!tbody || rows.length < 8) {
        return;
      }

      const assets = [
        ["gold_close", "Gold Futures", "GC=F"],
        ["usd_index_close", "US Dollar Index", "DX-Y.NYB"],
        ["sp500_close", "S&P 500", "^GSPC"],
        ["wti_oil_close", "WTI Oil", "CL=F"],
        ["silver_close", "Silver", "SI=F"],
        ["us_10y_yield_close", "US 10Y Yield", "^TNX"],
      ];

      const latestIndex = rows.length - 1;
      const latest = rows[latestIndex];

      tbody.innerHTML = assets
        .map(([key, name, ticker]) => {
          const previous = findPreviousValue(rows, latestIndex, key, 1);
          const previous7 = findPreviousValue(rows, latestIndex, key, 7);
          const lastValue = latest[key];
          const change1d = Number.isFinite(previous) ? lastValue - previous : null;
          const change7d = Number.isFinite(previous7) ? lastValue - previous7 : null;
          const change1dPct = Number.isFinite(previous) && previous !== 0 ? (change1d / previous) * 100 : null;
          const change7dPct = Number.isFinite(previous7) && previous7 !== 0 ? (change7d / previous7) * 100 : null;

          return `
            <tr>
              <td>
                <span class="asset-name">${escapeHtml(name)}</span>
                <span class="asset-ticker">${escapeHtml(ticker)}</span>
              </td>
              <td>${formatMarketValue(key, lastValue)}</td>
              <td class="${changeClass(change1d)}">${formatChange(key, change1d, change1dPct)}</td>
              <td class="${changeClass(change7d)}">${formatChange(key, change7d, change7dPct)}</td>
              <td>${escapeHtml(latest.date)}</td>
            </tr>
          `;
        })
        .join("");
    }

    function renderRecentMarketRows(rows) {
      const tbody = document.querySelector("#marketRecentTable tbody");
      if (!tbody) {
        return;
      }

      tbody.innerHTML = rows
        .slice(-8)
        .reverse()
        .map((row) => `
          <tr>
            <td>${escapeHtml(row.date)}</td>
            <td>${formatMarketValue("gold_close", row.gold_close)}</td>
            <td>${formatMarketValue("usd_index_close", row.usd_index_close)}</td>
            <td>${formatMarketValue("sp500_close", row.sp500_close)}</td>
            <td>${formatMarketValue("wti_oil_close", row.wti_oil_close)}</td>
            <td>${formatMarketValue("silver_close", row.silver_close)}</td>
            <td>${formatMarketValue("us_10y_yield_close", row.us_10y_yield_close)}</td>
          </tr>
        `)
        .join("");
    }

    function findPreviousValue(rows, latestIndex, key, offset) {
      let seen = 0;
      for (let index = latestIndex - 1; index >= 0; index -= 1) {
        if (Number.isFinite(rows[index][key])) {
          seen += 1;
        }
        if (seen === offset) {
          return rows[index][key];
        }
      }
      return null;
    }

    function formatMarketValue(key, value) {
      if (!Number.isFinite(value)) {
        return "--";
      }
      if (["gold_close", "wti_oil_close", "silver_close"].includes(key)) {
        return money.format(value);
      }
      if (key === "us_10y_yield_close") {
        return `${number.format(value)}%`;
      }
      return number.format(value);
    }

    function formatChange(key, change, changePct) {
      if (!Number.isFinite(change)) {
        return "--";
      }
      const sign = change >= 0 ? "+" : "";
      const value = formatMarketValue(key, Math.abs(change)).replace("$", "");
      const unitValue = ["gold_close", "wti_oil_close", "silver_close"].includes(key) ? `$${value}` : value;
      return `${sign}${unitValue} · ${sign}${compact.format(changePct)}%`;
    }

    function changeClass(value) {
      if (!Number.isFinite(value)) {
        return "";
      }
      return value >= 0 ? "positive-change" : "negative-change";
    }

    function renderRiskMeter(rows) {
      const goldPrices = rows.map((row) => row.gold_close).filter(Number.isFinite);
      if (goldPrices.length < 32) {
        return;
      }

      const recentPrices = goldPrices.slice(-31);
      const returns = [];
      for (let index = 1; index < recentPrices.length; index += 1) {
        returns.push(recentPrices[index] / recentPrices[index - 1] - 1);
      }

      const volatilityDaily = standardDeviation(returns);
      const volatilityAnnualized = volatilityDaily * Math.sqrt(252);
      const volatilityPct = volatilityAnnualized * 100;

      let level = "Low";
      let insight = "Рынок выглядит спокойнее обычного: краткосрочные колебания золота умеренные.";
      if (volatilityPct >= 22) {
        level = "High";
        insight = "Риск повышен: последние движения золота стали резче, прогноз нужно читать особенно осторожно.";
      } else if (volatilityPct >= 14) {
        level = "Medium";
        insight = "Риск средний: волатильность заметна, но не выглядит экстремальной для финансового ряда.";
      }

      const needlePosition = Math.max(5, Math.min(95, (volatilityPct / 32) * 100));
      const needle = document.getElementById("riskNeedle");
      if (needle) {
        needle.style.left = `${needlePosition}%`;
      }

      setText("riskLevel", `${level} risk`);
      setText("riskVolatility", `${number.format(volatilityPct)}% annualized`);
      setText("riskInsight", insight);
    }

    function standardDeviation(values) {
      if (!values.length) {
        return 0;
      }
      const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
      const variance = values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / values.length;
      return Math.sqrt(variance);
    }

    function csvTextToObjects(text) {
      const rows = parseCsv(text.trim());
      const headers = rows.shift() || [];
      return rows
        .filter((row) => row.length && row.some((value) => value !== ""))
        .map((row) => {
          const object = {};
          headers.forEach((header, index) => {
            object[header] = row[index] ?? "";
          });
          return object;
        });
    }

    function renderModels(data) {
      const models = data.modelResults || [];
      const baselines = data.baselineResults || [];
      const best = models[0] || {};
      const naive = baselines.find((row) => row.Model === "Naive forecast" && row.Split === "test") || {};

      setText("bestModelHero", best.Model || "--");
      setText("testMaeHero", best["MAE test"] ? money.format(best["MAE test"]) : "--");
      setText("bestModelCard", best.Model || "--");
      setText("validMaeCard", best["MAE valid"] ? money.format(best["MAE valid"]) : "--");
      setText("testMaeCard", best["MAE test"] ? money.format(best["MAE test"]) : "--");
      setText("naiveMaeCard", naive.MAE ? money.format(naive.MAE) : "--");

      if (Number.isFinite(best["MAE test"]) && Number.isFinite(naive.MAE)) {
        const diff = best["MAE test"] - naive.MAE;
        const label = diff > 0 ? `Naive better by ${money.format(diff)}` : `ML better by ${money.format(Math.abs(diff))}`;
        setText("baselineNote", label);
      }

      renderModelVsBaseline(best, naive);

      const tbody = document.querySelector("#modelTable tbody");
      tbody.innerHTML = models
        .map((row, index) => `
          <tr class="${index === 0 ? "best-row" : ""}">
            <td>${escapeHtml(row.Model)}</td>
            <td>${number.format(row["MAE valid"])}</td>
            <td>${number.format(row["RMSE valid"])}</td>
            <td>${number.format(row["MAPE valid"])}%</td>
            <td>${number.format(row["MAE test"])}</td>
            <td>${number.format(row["RMSE test"])}</td>
            <td>${number.format(row["MAPE test"])}%</td>
            <td>${number.format(row["Training time"])}s</td>
          </tr>
        `)
        .join("");

      renderMetricsChart(models);
    }

    function renderModelVsBaseline(best, naive) {
      if (!Number.isFinite(best["MAE test"]) || !Number.isFinite(naive.MAE)) {
        return;
      }

      const modelMae = best["MAE test"];
      const baselineMae = naive.MAE;
      const maxMae = Math.max(modelMae, baselineMae);
      const modelWidth = Math.max(4, (modelMae / maxMae) * 100);
      const baselineWidth = Math.max(4, (baselineMae / maxMae) * 100);
      const diff = modelMae - baselineMae;
      const diffPct = baselineMae ? (Math.abs(diff) / baselineMae) * 100 : 0;

      setText("compareModelName", best.Model || "ML model");
      setText("compareModelMae", money.format(modelMae));
      setText("compareBaselineMae", money.format(baselineMae));

      const modelBar = document.getElementById("modelMaeBar");
      const baselineBar = document.getElementById("baselineMaeBar");
      if (modelBar) {
        modelBar.style.width = `${modelWidth}%`;
      }
      if (baselineBar) {
        baselineBar.style.width = `${baselineWidth}%`;
      }

      const insight =
        diff > 0
          ? `Naive baseline лучше на ${money.format(diff)} (${compact.format(diffPct)}%). Это честный сигнал: краткосрочная цена золота очень инерционна.`
          : `ML-модель лучше baseline на ${money.format(Math.abs(diff))} (${compact.format(diffPct)}%).`;
      setText("compareInsight", insight);
    }

    function renderMetricsChart(models) {
      if (!window.Plotly || !models.length) {
        return;
      }

      const layout = baseLayout("MAE by model");
      layout.barmode = "group";
      layout.margin = { l: 54, r: 22, t: 16, b: 118 };
      layout.xaxis = { tickangle: -25, color: "#afa994" };
      layout.yaxis = { title: "MAE, USD", color: "#afa994", gridcolor: "rgba(214,170,63,0.12)" };

      Plotly.newPlot(
        "metricsChart",
        [
          {
            x: models.map((row) => row.Model),
            y: models.map((row) => row["MAE valid"]),
            type: "bar",
            name: "Validation",
            marker: { color: "#f2d16b" },
          },
          {
            x: models.map((row) => row.Model),
            y: models.map((row) => row["MAE test"]),
            type: "bar",
            name: "Test",
            marker: { color: "#6f7f73" },
          },
        ],
        layout,
        plotConfig()
      );
    }

    function renderForecast(data) {
      const forecast = data.forecast || [];
      const history = data.history || [];
      const first = forecast[0];
      const last = forecast[forecast.length - 1];

      if (first && last) {
        setText("forecastRange", `${first.date} → ${last.date}`);
        const direction = last.predicted_gold_price >= first.predicted_gold_price ? "рост" : "снижение";
        setText("forecastHeadline", `${direction}: ${money.format(first.predicted_gold_price)} → ${money.format(last.predicted_gold_price)}`);
      }

      const tbody = document.querySelector("#forecastTable tbody");
      tbody.innerHTML = forecast
        .map((row) => `
          <tr>
            <td>${escapeHtml(row.date)}</td>
            <td>${money.format(row.predicted_gold_price)}</td>
          </tr>
        `)
        .join("");

      if (!window.Plotly || !forecast.length) {
        return;
      }

      const layout = baseLayout("Historical and forecast price");
      layout.margin = { l: 64, r: 24, t: 20, b: 52 };
      layout.yaxis = { title: "Gold price, USD", color: "#afa994", gridcolor: "rgba(214,170,63,0.12)" };
      layout.xaxis = { color: "#afa994", gridcolor: "rgba(214,170,63,0.08)" };
      layout.legend = { orientation: "h", y: 1.08, x: 0 };

      Plotly.newPlot(
        "forecastChart",
        [
          {
            x: history.map((row) => row.date),
            y: history.map((row) => row.price),
            mode: "lines",
            name: "Historical",
            line: { color: "#f4efe2", width: 2.4 },
          },
          {
            x: forecast.map((row) => row.date),
            y: forecast.map((row) => row.predicted_gold_price),
            mode: "lines+markers",
            name: "Forecast",
            line: { color: "#f2d16b", width: 3 },
            marker: { size: 5, color: "#f2d16b" },
          },
        ],
        layout,
        plotConfig()
      );
    }

    function renderInterpretation(data) {
      renderFeatureChart(data.featureImportance || []);
      renderFeatureExplainer(data.featureImportance || []);
      renderActualChart((data.testPredictions || []).slice(-260));
    }

    function renderFeatureChart(features) {
      if (!window.Plotly || !features.length) {
        return;
      }

      const reversed = [...features].reverse();
      const layout = baseLayout("Feature importance");
      layout.margin = { l: 156, r: 20, t: 18, b: 40 };
      layout.xaxis = { color: "#afa994", gridcolor: "rgba(214,170,63,0.12)" };
      layout.yaxis = { color: "#afa994" };

      Plotly.newPlot(
        "featureChart",
        [
          {
            x: reversed.map((row) => row.importance),
            y: reversed.map((row) => row.feature),
            type: "bar",
            orientation: "h",
            marker: {
              color: reversed.map((_, index) => index),
              colorscale: [
                [0, "#8c6519"],
                [1, "#f2d16b"],
              ],
            },
            hovertemplate: "%{y}<br>importance: %{x:.2f}<extra></extra>",
          },
        ],
        layout,
        plotConfig()
      );
    }

    function renderFeatureExplainer(features) {
      const list = document.getElementById("featureList");
      if (!list || !features.length) {
        return;
      }

      const topFeatures = features.slice(0, 10);
      list.innerHTML = topFeatures
        .map((row, index) => `
          <button class="feature-token ${index === 0 ? "is-active" : ""}" type="button" data-feature="${escapeHtml(row.feature)}">
            ${escapeHtml(prettifyFeatureName(row.feature))}
          </button>
        `)
        .join("");

      const showFeature = (featureName) => {
        const active = features.find((row) => row.feature === featureName) || topFeatures[0];
        document.querySelectorAll(".feature-token").forEach((button) => {
          button.classList.toggle("is-active", button.dataset.feature === active.feature);
        });
        setText("featureExplainerTitle", prettifyFeatureName(active.feature));
        setText("featureExplainerText", explainFeature(active.feature));
      };

      list.querySelectorAll(".feature-token").forEach((button) => {
        button.addEventListener("click", () => showFeature(button.dataset.feature));
        button.addEventListener("mouseenter", () => showFeature(button.dataset.feature));
      });

      showFeature(topFeatures[0].feature);
    }

    function prettifyFeatureName(feature) {
      return String(feature)
        .replaceAll("_close", "")
        .replaceAll("_", " ")
        .replace(/\b\w/g, (letter) => letter.toUpperCase());
    }

    function explainFeature(feature) {
      const explanations = [
        {
          test: (name) => name === "gold_close",
          text: "Текущая цена золота является главным ориентиром для прогноза следующего дня. Для краткосрочного горизонта рынок часто инерционен: завтрашняя цена обычно близка к сегодняшней.",
        },
        {
          test: (name) => name.startsWith("gold_lag"),
          text: "Лаг цены золота показывает, каким был уровень цены несколько торговых дней назад. Он помогает модели уловить краткосрочную память ряда и локальный тренд.",
        },
        {
          test: (name) => name.startsWith("sma"),
          text: "Скользящая средняя сглаживает рыночный шум и показывает локальный тренд. Чем длиннее окно, тем спокойнее и устойчивее сигнал.",
        },
        {
          test: (name) => name.includes("usd_index"),
          text: "Индекс доллара важен для золота, потому что золото торгуется в долларах США. Сильный доллар часто давит на стоимость золота, а слабый доллар может поддерживать спрос.",
        },
        {
          test: (name) => name.includes("sp500"),
          text: "S&P 500 отражает общий риск-сентимент рынка. Когда инвесторы уходят из риска, защитные активы вроде золота могут становиться привлекательнее.",
        },
        {
          test: (name) => name.includes("silver"),
          text: "Серебро относится к драгоценным металлам и часто движется рядом с золотом. Этот признак помогает уловить общий импульс metals market.",
        },
        {
          test: (name) => name.includes("wti_oil"),
          text: "Нефть WTI связана с инфляционными ожиданиями и сырьевым циклом. Через макроэкономический фон она может косвенно влиять на золото.",
        },
        {
          test: (name) => name.includes("yield") || name.includes("tnx"),
          text: "Доходность 10-летних облигаций влияет на альтернативную стоимость владения золотом. Когда доходности растут, золоту сложнее конкурировать с процентными активами.",
        },
        {
          test: (name) => name.includes("return"),
          text: "Доходность показывает краткосрочный импульс: насколько быстро цена менялась в последние дни. Это помогает модели отличать спокойный рынок от ускоряющегося движения.",
        },
      ];

      const match = explanations.find((item) => item.test(feature));
      return match
        ? match.text
        : "Этот фактор помогает модели описывать рыночный контекст вокруг золота. Его важность означает, что он стабильно участвует в объяснении прогноза.";
    }

    function renderActualChart(predictions) {
      if (!window.Plotly || !predictions.length) {
        return;
      }

      const layout = baseLayout("Actual vs predicted");
      layout.margin = { l: 64, r: 22, t: 18, b: 48 };
      layout.yaxis = { title: "Gold price, USD", color: "#afa994", gridcolor: "rgba(214,170,63,0.12)" };
      layout.xaxis = { color: "#afa994", gridcolor: "rgba(214,170,63,0.08)" };
      layout.legend = { orientation: "h", y: 1.08, x: 0 };

      Plotly.newPlot(
        "actualChart",
        [
          {
            x: predictions.map((row) => row.date),
            y: predictions.map((row) => row.actual),
            mode: "lines",
            name: "Actual",
            line: { color: "#f4efe2", width: 2.2 },
          },
          {
            x: predictions.map((row) => row.date),
            y: predictions.map((row) => row.predicted),
            mode: "lines",
            name: "Predicted",
            line: { color: "#f2d16b", width: 2.2 },
          },
        ],
        layout,
        plotConfig()
      );
    }

    function baseLayout(title) {
      return {
        title: { text: title, font: { color: "#f4efe2", size: 13 } },
        paper_bgcolor: "rgba(0,0,0,0)",
        plot_bgcolor: "rgba(0,0,0,0)",
        font: { family: "IBM Plex Mono, monospace", color: "#afa994" },
        hoverlabel: {
          bgcolor: "#11130d",
          bordercolor: "#d6aa3f",
          font: { color: "#f4efe2" },
        },
      };
    }

    function plotConfig() {
      return {
        responsive: true,
        displayModeBar: false,
      };
    }

    function setText(id, value) {
      const element = document.getElementById(id);
      if (element) {
        element.textContent = value;
      }
    }

    function escapeHtml(value) {
      return String(value ?? "")
        .replaceAll("&", "&amp;")
        .replaceAll("<", "&lt;")
        .replaceAll(">", "&gt;")
        .replaceAll("\"", "&quot;")
        .replaceAll("'", "&#039;");
    }
  }
})();

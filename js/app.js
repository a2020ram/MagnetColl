(function () {
  const cfg = window.MAGNETS_CONFIG || {};
  const state = {
    items: [],
    selectedId: null,
    slide: {},
    markers: new Map(),
    map: null,
    places: [],
    coatFiles: {},
    editing: false,
    publishing: false
  };

  const els = {
    map: document.getElementById("map"),
    note: document.getElementById("map-note"),
    q: document.getElementById("q"),
    sort: document.getElementById("sort"),
    status: document.getElementById("status"),
    view: document.getElementById("view"),
    count: document.getElementById("count"),
    list: document.getElementById("list"),
    detail: document.getElementById("detail"),
    add: document.getElementById("add-btn"),
    git: document.getElementById("git-btn"),
    lan: document.getElementById("lan"),
    toggle: document.getElementById("panel-toggle"),
    panel: document.getElementById("panel")
  };

  function thumbUrl(item, size) {
    if (!item.driveFileId) return "";
    const key = item.resourceKey ? "&resourcekey=" + encodeURIComponent(item.resourceKey) : "";
    return "https://drive.google.com/thumbnail?id=" + encodeURIComponent(item.driveFileId) + "&sz=w" + size + key;
  }

  function markerSrc(item, size) {
    const name = localName((item.localPhotos || [])[0] || "");
    if (onThisMachine() && name) return "photos/" + encodeURIComponent(name) + "?w=" + size;
    return thumbUrl(item, size) || "";
  }

  function parseCsv(text) {
    const rows = [];
    let row = [];
    let cell = "";
    let quoted = false;
    const src = text.replace(/^\uFEFF/, "");
    for (let i = 0; i < src.length; i++) {
      const c = src[i];
      if (quoted) {
        if (c === '"') {
          if (src[i + 1] === '"') { cell += '"'; i++; }
          else quoted = false;
        } else cell += c;
      } else if (c === '"') quoted = true;
      else if (c === ",") { row.push(cell); cell = ""; }
      else if (c === "\n") { row.push(cell); rows.push(row); row = []; cell = ""; }
      else if (c !== "\r") cell += c;
    }
    if (cell.length || row.length) { row.push(cell); rows.push(row); }
    const head = rows.shift() || [];
    return rows.filter(function (r) { return r.some(Boolean); }).map(function (r) {
      const obj = {};
      head.forEach(function (key, i) { obj[key.trim()] = (r[i] || "").trim(); });
      obj.lat = parseFloat(obj.lat);
      obj.lng = parseFloat(obj.lng);
      return obj;
    });
  }

  function loadData() {
    const url = cfg.sheetCsvUrl
      ? cfg.sheetCsvUrl + (cfg.sheetCsvUrl.indexOf("?") >= 0 ? "&" : "?") + "t=" + Date.now()
      : cfg.dataUrl || "data/magnets.json";
    const magnets = fetch(url).then(function (res) {
      if (!res.ok) throw new Error("data " + res.status);
      return cfg.sheetCsvUrl ? res.text().then(parseCsv) : res.json();
    });
    const places = fetch("data/places.json").then(function (res) {
      return res.ok ? res.json() : [];
    }).catch(function () { return []; });
    const coats = fetch("data/coat-files.json").then(function (res) {
      return res.ok ? res.json() : {};
    }).catch(function () { return {}; });
    return Promise.all([magnets, places, coats]);
  }

  function hierarchy(item) {
    const parts = [item.continent, item.country, item.region, item.city]
      .map(function (s) { return (s || "").trim(); })
      .filter(Boolean);
    if (parts.length === 1 && parts[0] === (item.name || "").trim()) return [];
    return parts;
  }

  function visibleItems() {
    const q = els.q.value.trim().toLocaleLowerCase("ru");
    const status = els.status.value;
    let items = state.items.filter(function (item) {
      if (status !== "all" && (item.status || "owned") !== status) return false;
      if (!q) return true;
      return [item.name, item.country, item.region, item.city, item.continent]
        .join(" ")
        .toLocaleLowerCase("ru")
        .indexOf(q) >= 0;
    });
    const byName = function (a, b) {
      return (a.name || "").localeCompare(b.name || "", "ru", { sensitivity: "base" });
    };
    if (els.sort.value === "added") {
      items.sort(function (a, b) {
        const da = a.addedAt || "";
        const db = b.addedAt || "";
        if (da === db) return byName(a, b);
        if (!da) return 1;
        if (!db) return -1;
        return db.localeCompare(da);
      });
    } else items.sort(byName);
    return items;
  }

  function select(id) {
    if (state.editing) closeEditor();
    state.selectedId = id;
    const item = findItem(id);
    state.markers.forEach(function (pin, key) {
      pin.classList.toggle("active", key === id);
    });
    renderDetail(item);
    renderList();
    if (item && state.map && isFinite(item.lat) && isFinite(item.lng)) {
      state.map.focus(item.lat, item.lng, 6);
    }
    const node = els.list.querySelector('[data-id="' + cssEscape(id) + '"]');
    if (node) node.scrollIntoView({ block: "nearest" });
  }

  function cssEscape(value) {
    return window.CSS && CSS.escape ? CSS.escape(value) : String(value).replace(/"/g, "");
  }

  function localName(path) {
    return String(path || "").split(/[\\/]/).pop();
  }

  function onThisMachine() {
    const host = location.hostname;
    if (host === "localhost" || host === "127.0.0.1") return true;
    return /^(192\.168\.|10\.|172\.(1[6-9]|2\d|3[0-1])\.)/.test(host);
  }

  function coatSrc(item) {
    return item.coaWiki || "";
  }

  function gallery(item) {
    const local = [];
    if (onThisMachine()) {
      (item.localPhotos || []).forEach(function (path) {
        const name = localName(path);
        if (name) local.push("photos/" + encodeURIComponent(name));
      });
    }
    if (local.length) return local;
    const many = (item.drivePhotos || []).map(function (photo) {
      if (!photo.id) return "";
      return "https://drive.google.com/thumbnail?id=" + encodeURIComponent(photo.id) + "&sz=w1600";
    }).filter(Boolean);
    if (many.length) return many;
    const drive = thumbUrl(item, 1600);
    return drive ? [drive] : [];
  }

  function normStatus(item) {
    return item.status === "wishlist" ? "missing" : (item.status || "owned");
  }

  function matchesQuery(item) {
    const q = els.q.value.trim().toLocaleLowerCase("ru");
    if (!q) return true;
    return [item.name, item.nameEn, item.country, item.region, item.city, item.continent]
      .join(" ")
      .toLocaleLowerCase("ru")
      .indexOf(q) >= 0;
  }

  function missingPlaces() {
    const codes = new Set();
    state.items.forEach(function (item) {
      if (item.countryCode && normStatus(item) !== "missing") codes.add(item.countryCode);
    });
    return (state.places || []).filter(function (place) {
      return !codes.has(place.countryCode);
    }).map(function (place) {
      return {
        id: "place-" + place.countryCode,
        name: place.name,
        nameEn: place.nameEn || "",
        status: "missing",
        placeOnly: true,
        continent: place.continent,
        country: place.name,
        countryCode: place.countryCode,
        region: "",
        city: "",
        coaPath: place.coaPath || "",
        coaWiki: place.coaWiki || "",
        lat: null,
        lng: null,
        localPhotos: []
      };
    });
  }

  function findItem(id) {
    return state.items.find(function (it) { return it.id === id; })
      || missingPlaces().find(function (it) { return it.id === id; });
  }

  function renderDetail(item) {
    if (!item) { els.detail.hidden = true; els.detail.innerHTML = ""; return; }
    els.detail.hidden = false;
    const slides = gallery(item);
    let index = state.slide[item.id] || 0;
    if (index >= slides.length) index = 0;
    const coat = coatSrc(item);
    const missing = normStatus(item) === "missing";
    const status = missing ? "Нет" : "Есть";
    const placeParts = [];
    if (item.crimea) placeParts.push("Крым");
    [item.continent, item.country, item.region, item.city].forEach(function (part) {
      part = (part || "").trim();
      if (part && placeParts.indexOf(part) < 0 && part !== (item.name || "").trim()) placeParts.push(part);
    });
    const many = slides.length > 1;
    const showCoat = coat && (item.placeOnly || slides.length);
    els.detail.innerHTML =
      '<div class="detail-tools"><button type="button" class="detail-close" aria-label="Закрыть">×</button></div>' +
      (slides.length
        ? '<div class="viewer">' +
            '<button type="button" class="nav prev" ' + (many ? "" : "hidden") + " aria-label=\"Предыдущее фото\">‹</button>" +
            '<img alt="' + escapeAttr(item.name || "") + '">' +
            '<button type="button" class="nav next" ' + (many ? "" : "hidden") + " aria-label=\"Следующее фото\">›</button>" +
            '<span class="counter"></span>' +
          "</div>"
        : (item.placeOnly ? "" : '<p class="file">Фото нет</p>')) +
      (showCoat ? '<img class="coat" src="' + escapeAttr(coat) + '" data-wiki="' + escapeAttr(item.coaWiki || "") + '" alt="Герб">' : "") +
      "<h2>" + escapeHtml(item.name || "Без названия") + "</h2>" +
      '<p class="meta"><span class="badge ' + (missing ? "missing" : "") + '">' + status + "</span>" +
      (placeParts.length ? " · " + escapeHtml(placeParts.join(" · ")) : "") +
      (item.notes ? " · " + escapeHtml(item.notes) : "") +
      "</p>" +
      '<p class="file"></p>' +
      (onThisMachine()
        ? '<p class="actions"><button type="button" class="text-btn edit-card">' +
          (item.placeOnly ? "Добавить магнит" : "Править") + "</button></p>"
        : "");
    els.detail.querySelector(".detail-close").addEventListener("click", closeCard);
    const editCard = els.detail.querySelector(".edit-card");
    if (editCard) editCard.addEventListener("click", function () {
      openEditor(item.placeOnly ? {
        id: "",
        name: item.name || "",
        status: "owned",
        countryCode: item.countryCode || "",
        region: "",
        city: "",
        notes: "",
        lat: "",
        lng: "",
        localPhotos: []
      } : item);
    });
    const coatImg = els.detail.querySelector(".coat");
    if (coatImg) {
      coatImg.addEventListener("error", function () {
        const next = coatImg.getAttribute("data-wiki");
        if (next && coatImg.getAttribute("src") !== next) coatImg.src = next;
      });
    }
    const img = els.detail.querySelector(".viewer img");
    if (!img) return;
    const counter = els.detail.querySelector(".counter");
    const file = els.detail.querySelector(".file");
    let startX = 0;
    function show(step) {
      if (!slides.length) return;
      index = (step + slides.length) % slides.length;
      state.slide[item.id] = index;
      img.src = slides[index];
      counter.textContent = many ? (index + 1) + " / " + slides.length : "";
      const src = slides[index];
      file.textContent = src.indexOf("drive.google.com/thumbnail") >= 0
        ? ""
        : localName(decodeURIComponent(src.split("?")[0].split("/").pop()));
    }
    els.detail.querySelector(".prev").addEventListener("click", function () { show(index - 1); });
    els.detail.querySelector(".next").addEventListener("click", function () { show(index + 1); });
    img.addEventListener("pointerdown", function (event) { startX = event.clientX; });
    img.addEventListener("pointerup", function (event) {
      const dx = event.clientX - startX;
      if (dx > 40) show(index - 1);
      else if (dx < -40) show(index + 1);
    });
    show(index);
  }

  function listedMagnets() {
    const status = els.status.value;
    return state.items.filter(function (item) {
      const missing = normStatus(item) === "missing";
      if (status === "owned" && missing) return false;
      if (status === "missing" && !missing) return false;
      return matchesQuery(item);
    });
  }

  function renderList() {
    const magnets = listedMagnets();
    const gaps = els.status.value === "owned" ? [] : missingPlaces().filter(matchesQuery);
    els.count.textContent = "есть " + state.items.filter(function (item) {
      return normStatus(item) !== "missing";
    }).length + " · нет " + missingPlaces().length;
    if (els.view.value === "tree") renderTree(magnets, gaps);
    else renderFlat(els.status.value === "missing" ? gaps.concat(magnets) : magnets);
    syncMarkers(magnets.filter(function (item) { return normStatus(item) !== "missing"; }));
  }

  function renderFlat(items) {
    els.list.innerHTML = "";
    items.forEach(function (item) { els.list.appendChild(row(item)); });
  }

  function byRu(a, b) {
    return a.localeCompare(b, "ru", { sensitivity: "base" });
  }

  function branch(name, children, opened, missingItem) {
    const wrap = document.createElement("div");
    wrap.className = "tree-node";
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "tree-btn" + (missingItem ? " missing" : "");
    if (missingItem) {
      const src = coatSrc(missingItem);
      btn.innerHTML = (src ? '<img src="' + escapeAttr(src) + '" alt="">' : "") +
        "<span>" + escapeHtml(name) + " · нет</span>";
    } else btn.textContent = name;
    const box = document.createElement("div");
    box.hidden = !opened;
    children.forEach(function (child) { box.appendChild(child); });
    btn.addEventListener("click", function () {
      if (missingItem) select(missingItem.id);
      if (children.length) box.hidden = !box.hidden;
    });
    wrap.appendChild(btn);
    if (children.length) wrap.appendChild(box);
    return wrap;
  }

  function renderTree(magnets, gaps) {
    const order = {};
    (state.places || []).forEach(function (place) {
      if (order[place.continent] == null) order[place.continent] = place.continentOrder;
    });
    const continents = new Map();
    function countryNode(continentName, countryName) {
      if (!continents.has(continentName)) {
        continents.set(continentName, {
          order: order[continentName] == null ? 50 : order[continentName],
          countries: new Map()
        });
      }
      const continent = continents.get(continentName);
      if (!continent.countries.has(countryName)) {
        continent.countries.set(countryName, { item: null, magnets: [], regions: new Map() });
      }
      return continent.countries.get(countryName);
    }
    magnets.forEach(function (item) {
      if (item.crimea || !item.country) return;
      const node = countryNode(item.continent || "Без части света", item.country);
      const region = (item.region || "").trim();
      const city = (item.city || "").trim();
      if (!region && !city) { node.magnets.push(item); return; }
      const regionName = region || city;
      if (!node.regions.has(regionName)) node.regions.set(regionName, { magnets: [], cities: new Map() });
      const regionNode = node.regions.get(regionName);
      if (region && city && city !== region) {
        if (!regionNode.cities.has(city)) regionNode.cities.set(city, []);
        regionNode.cities.get(city).push(item);
      } else regionNode.magnets.push(item);
    });
    gaps.forEach(function (item) {
      countryNode(item.continent || "Без части света", item.country).item = item;
    });
    const opened = !!els.q.value.trim();
    els.list.innerHTML = "";
    const crimea = magnets.filter(function (item) { return item.crimea; });
    if (crimea.length) {
      els.list.appendChild(branch("Крым", crimea.slice().sort(function (a, b) {
        return byRu(a.name || "", b.name || "");
      }).map(row), opened));
    }
    Array.from(continents.keys()).sort(function (a, b) {
      return continents.get(a).order - continents.get(b).order || byRu(a, b);
    }).forEach(function (name) {
      const continent = continents.get(name);
      const countries = Array.from(continent.countries.keys()).sort(byRu).map(function (countryName) {
        const node = continent.countries.get(countryName);
        const children = node.magnets.map(row);
        Array.from(node.regions.keys()).sort(byRu).forEach(function (regionName) {
          const region = node.regions.get(regionName);
          const leaves = region.magnets.map(row);
          Array.from(region.cities.keys()).sort(byRu).forEach(function (city) {
            leaves.push(branch(city, region.cities.get(city).map(row), opened));
          });
          children.push(branch(regionName, leaves, opened));
        });
        if (node.item && !children.length) return branch(countryName, [], opened, node.item);
        return branch(countryName, children, opened);
      });
      els.list.appendChild(branch(name, countries, opened));
    });
    const loose = magnets.filter(function (item) { return !item.crimea && !item.country; });
    if (loose.length) els.list.appendChild(branch("Без места", loose.map(row), opened));
  }

  function row(item) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "item" + (item.id === state.selectedId ? " active" : "");
    btn.dataset.id = item.id;
    const src = item.placeOnly ? coatSrc(item) : markerSrc(item, 96);
    const img = src
      ? '<img src="' + escapeAttr(src) + '" alt="">'
      : '<span class="ph">' + (normStatus(item) === "missing" ? "нет" : "") + "</span>";
    const where = hierarchy(item).join(" · ");
    const count = gallery(item).length;
    btn.innerHTML = img + "<span><b>" + escapeHtml(item.name || "Без названия") + "</b>" +
      (where ? "<small>" + escapeHtml(where) + "</small>" : "") +
      (count > 1 ? "<small>" + count + " фото</small>" : "") + "</span>";
    btn.addEventListener("click", function () {
      select(item.id);
      syncToggle();
    });
    return btn;
  }

  function project(lat, lng, zoom) {
    const scale = 256 * Math.pow(2, zoom);
    const x = (lng + 180) / 360 * scale;
    const sin = Math.min(Math.max(Math.sin(lat * Math.PI / 180), -0.9999), 0.9999);
    const y = (0.5 - Math.log((1 + sin) / (1 - sin)) / (4 * Math.PI)) * scale;
    return { x: x, y: y };
  }

  function syncMarkers(items) {
    if (!state.map) return;
    const shown = new Set(items.map(function (it) { return it.id; }));
    state.markers.forEach(function (pin, id) { pin.hidden = !shown.has(id); });
    items.forEach(function (item) {
      if (!isFinite(item.lat) || !isFinite(item.lng) || state.markers.has(item.id)) return;
      const pin = document.createElement("button");
      pin.type = "button";
      pin.className = "magnet-pin" + (normStatus(item) === "missing" ? " missing" : "");
      pin.title = item.name || "";
      const src = markerSrc(item, 96);
      if (src) pin.style.backgroundImage = "url(\"" + src.replace(/"/g, "") + "\")";
      else { pin.classList.add("empty"); pin.textContent = normStatus(item) === "missing" ? "нет" : "•"; }
      pin.addEventListener("click", function (event) {
        event.stopPropagation();
        select(item.id);
      });
      state.map.pins.appendChild(pin);
      state.markers.set(item.id, pin);
    });
    state.map.draw();
  }

  function initMap() {
    const world = document.createElement("div");
    world.className = "map-world";
    const tiles = document.createElement("div");
    const pins = document.createElement("div");
    pins.className = "map-pins";
    world.appendChild(tiles);
    world.appendChild(pins);
    const controls = document.createElement("div");
    controls.className = "map-controls";
    controls.innerHTML = '<button type="button" data-z="1" aria-label="Ближе">+</button><button type="button" data-z="-1" aria-label="Дальше">−</button>';
    const credit = document.createElement("a");
    credit.className = "map-credit";
    credit.href = "https://www.openstreetmap.org/copyright";
    credit.target = "_blank";
    credit.rel = "noopener";
    credit.textContent = "© OpenStreetMap";
    els.map.appendChild(world);
    els.map.appendChild(controls);
    els.map.appendChild(credit);

    const view = { x: project(50, 20, 4).x, y: project(50, 20, 4).y, zoom: 4 };
    function size() { return { w: els.map.clientWidth || 800, h: els.map.clientHeight || 600 }; }
    function draw() {
      const box = size();
      const z = view.zoom;
      const n = Math.pow(2, z);
      const originX = view.x - box.w / 2;
      const originY = view.y - box.h / 2;
      world.style.transform = "translate(" + (-originX) + "px," + (-originY) + "px)";
      const x0 = Math.floor(originX / 256);
      const x1 = Math.floor((originX + box.w) / 256);
      const y0 = Math.max(0, Math.floor(originY / 256));
      const y1 = Math.min(n - 1, Math.floor((originY + box.h) / 256));
      const need = new Set();
      for (let x = x0; x <= x1; x++) {
        for (let y = y0; y <= y1; y++) need.add(x + ":" + y);
      }
      const have = new Map();
      Array.from(tiles.children).forEach(function (img) {
        if (!need.has(img.dataset.k)) img.remove();
        else have.set(img.dataset.k, img);
      });
      need.forEach(function (key) {
        if (have.has(key)) return;
        const parts = key.split(":");
        const x = Number(parts[0]);
        const y = Number(parts[1]);
        const img = document.createElement("img");
        img.className = "map-tile";
        img.alt = "";
        img.draggable = false;
        img.dataset.k = key;
        img.style.left = (x * 256) + "px";
        img.style.top = (y * 256) + "px";
        const wrap = ((x % n) + n) % n;
        const urls = [
          "https://tile.openstreetmap.org/" + z + "/" + wrap + "/" + y + ".png",
          "https://basemaps.cartocdn.com/rastertiles/voyager/" + z + "/" + wrap + "/" + y + ".png"
        ];
        img.src = urls[0];
        img.addEventListener("error", function () {
          if (img.dataset.fallback) return;
          img.dataset.fallback = "1";
          img.src = urls[1];
        });
        tiles.appendChild(img);
      });
      state.markers.forEach(function (pin, id) {
        const item = state.items.find(function (it) { return it.id === id; });
        if (!item) return;
        const point = project(item.lat, item.lng, z);
        pin.style.left = (point.x - 21) + "px";
        pin.style.top = (point.y - 21) + "px";
      });
    }
    function zoomBy(delta, anchor) {
      const next = Math.max(2, Math.min(16, view.zoom + delta));
      if (next === view.zoom) return;
      const box = size();
      const ax = anchor ? anchor.x : box.w / 2;
      const ay = anchor ? anchor.y : box.h / 2;
      const worldX = view.x - box.w / 2 + ax;
      const worldY = view.y - box.h / 2 + ay;
      const scale = Math.pow(2, next - view.zoom);
      view.zoom = next;
      view.x = worldX * scale - ax + box.w / 2;
      view.y = worldY * scale - ay + box.h / 2;
      tiles.innerHTML = "";
      draw();
    }
    controls.addEventListener("click", function (event) {
      const button = event.target.closest("button");
      if (button) zoomBy(Number(button.dataset.z));
    });
    els.map.addEventListener("wheel", function (event) {
      event.preventDefault();
      const rect = els.map.getBoundingClientRect();
      zoomBy(event.deltaY < 0 ? 1 : -1, { x: event.clientX - rect.left, y: event.clientY - rect.top });
    }, { passive: false });
    let drag = null;
    els.map.addEventListener("pointerdown", function (event) {
      if (event.target.closest(".magnet-pin, .map-controls, .map-credit")) return;
      drag = { x: event.clientX, y: event.clientY, vx: view.x, vy: view.y, id: event.pointerId };
      els.map.setPointerCapture(event.pointerId);
    });
    els.map.addEventListener("pointermove", function (event) {
      if (!drag || event.pointerId !== drag.id) return;
      view.x = drag.vx - (event.clientX - drag.x);
      view.y = drag.vy - (event.clientY - drag.y);
      draw();
    });
    function endDrag(event) { if (drag && event.pointerId === drag.id) drag = null; }
    els.map.addEventListener("pointerup", endDrag);
    els.map.addEventListener("pointercancel", endDrag);
    window.addEventListener("resize", draw);

    const pts = state.items.filter(function (it) { return isFinite(it.lat) && isFinite(it.lng); });
    const box = size();
    let zoom = 4;
    for (let z = 8; z >= 2; z--) {
      let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
      pts.forEach(function (it) {
        const point = project(it.lat, it.lng, z);
        minX = Math.min(minX, point.x); maxX = Math.max(maxX, point.x);
        minY = Math.min(minY, point.y); maxY = Math.max(maxY, point.y);
      });
      if (maxX - minX < box.w - 48 && maxY - minY < box.h - 48) { zoom = z; break; }
    }
    view.zoom = zoom;
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    pts.forEach(function (it) {
      const point = project(it.lat, it.lng, zoom);
      minX = Math.min(minX, point.x); maxX = Math.max(maxX, point.x);
      minY = Math.min(minY, point.y); maxY = Math.max(maxY, point.y);
    });
    if (pts.length) { view.x = (minX + maxX) / 2; view.y = (minY + maxY) / 2; }

    state.map = {
      pins: pins,
      draw: draw,
      focus: function (lat, lng, minZoom) {
        const next = Math.max(view.zoom, minZoom || view.zoom);
        if (next !== view.zoom) { view.zoom = next; tiles.innerHTML = ""; }
        const point = project(lat, lng, view.zoom);
        view.x = point.x;
        view.y = point.y;
        draw();
      }
    };
    renderList();
  }

  function showNote(text) {
    els.note.hidden = false;
    els.note.textContent = text;
  }

  function escapeHtml(value) {
    return String(value).replace(/[&<>]/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c];
    });
  }
  function escapeAttr(value) { return escapeHtml(value).replace(/"/g, "&quot;"); }

  ["input", "change"].forEach(function (type) {
    els.q.addEventListener(type, renderList);
  });
  [els.sort, els.status, els.view].forEach(function (el) {
    el.addEventListener("change", renderList);
  });
  function syncToggle() {
    const mobile = window.matchMedia("(max-width: 800px)").matches;
    const open = els.panel.classList.contains("open");
    els.toggle.textContent = mobile && open ? "Карта" : "Список";
  }
  els.toggle.addEventListener("click", function () {
    els.panel.classList.toggle("open");
    syncToggle();
  });
  syncToggle();
  document.addEventListener("keydown", function (event) {
    if (event.key === "Escape" && !els.detail.hidden) {
      event.preventDefault();
      closeCard();
      return;
    }
    if (event.target && (event.target.tagName === "INPUT" || event.target.tagName === "SELECT")) return;
    const item = findItem(state.selectedId);
    if (!item) return;
    const total = gallery(item).length;
    if (total < 2) return;
    const current = state.slide[item.id] || 0;
    if (event.key === "ArrowRight") state.slide[item.id] = (current + 1) % total;
    else if (event.key === "ArrowLeft") state.slide[item.id] = (current - 1 + total) % total;
    else return;
    event.preventDefault();
    renderDetail(item);
  });
  function closeEditor() {
    state.editing = false;
    els.list.hidden = false;
    els.detail.classList.remove("editor-open");
  }

  function closeCard() {
    closeEditor();
    state.selectedId = null;
    state.markers.forEach(function (pin) { pin.classList.remove("active"); });
    renderDetail(null);
    renderList();
  }

  function countryCenter(code) {
    if (code === "CRIMEA") return { lat: 45.3, lng: 34.1 };
    const place = state.places.find(function (item) { return item.countryCode === code; });
    if (!place || place.lat == null || place.lng == null) return null;
    return { lat: place.lat, lng: place.lng };
  }

  function writeCoord(form, point) {
    form.lat.value = Number(point.lat).toFixed(5);
    form.lng.value = Number(point.lng).toFixed(5);
  }

  function postJson(url, body) {
    return fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body || {})
    }).then(function (res) {
      return res.json().then(function (data) {
        if (!res.ok) throw new Error(data.error || "Не сохранились изменения");
        return data;
      });
    });
  }

  function remember(item) {
    const index = state.items.findIndex(function (it) { return it.id === item.id; });
    if (index >= 0) state.items[index] = item;
    else state.items.push(item);
  }

  function fileToBase64(file) {
    return new Promise(function (resolve, reject) {
      const reader = new FileReader();
      reader.onload = function () { resolve(String(reader.result).split(",")[1]); };
      reader.onerror = function () { reject(new Error("Не прочиталось фото")); };
      reader.readAsDataURL(file);
    });
  }

  function countryOptions(selected) {
    const rows = ['<option value="">Страна не выбрана</option>'];
    rows.push('<option value="CRIMEA"' + (selected === "CRIMEA" ? " selected" : "") + ">Крым</option>");
    state.places.forEach(function (place) {
      rows.push('<option value="' + escapeAttr(place.countryCode) + '"' +
        (place.countryCode === selected ? " selected" : "") + ">" + escapeHtml(place.name) + "</option>");
    });
    return rows.join("");
  }

  function fillRegions(select, code, current) {
    select.innerHTML = '<option value="">Регион не выбран</option>';
    if (!code || code === "CRIMEA") {
      if (current) select.add(new Option(current, current, true, true));
      return;
    }
    fetch("/api/regions?code=" + encodeURIComponent(code)).then(function (res) {
      return res.json();
    }).then(function (data) {
      const names = (data.regions || []).slice();
      if (current && names.indexOf(current) < 0) names.unshift(current);
      names.forEach(function (name) {
        select.add(new Option(name, name, false, name === current));
      });
    }).catch(function () {
      if (current) select.add(new Option(current, current, true, true));
    });
  }

  function openEditor(item) {
    if (!onThisMachine()) return;
    const card = item || {
      id: "", name: "", status: "owned", countryCode: "", region: "", city: "",
      notes: "", lat: "", lng: "", localPhotos: []
    };
    const countryValue = card.crimea ? "CRIMEA" : (card.countryCode || "");
    state.editing = true;
    els.list.hidden = true;
    els.detail.hidden = false;
    els.detail.classList.add("editor-open");
    els.panel.classList.add("open");
    syncToggle();
    const knownCenter = !card.id && !card.lat && !card.lng ? countryCenter(countryValue) : null;
    if (knownCenter) {
      card.lat = knownCenter.lat;
      card.lng = knownCenter.lng;
    }
    els.detail.innerHTML =
      '<div class="detail-tools"><button type="button" class="detail-close" aria-label="Закрыть">×</button></div>' +
      '<form class="editor">' +
        '<label>Название<input name="name" required value="' + escapeAttr(card.name || "") + '"></label>' +
        '<label>Статус<select name="status">' +
          '<option value="owned"' + (card.status === "missing" ? "" : " selected") + ">Есть</option>" +
          '<option value="missing"' + (card.status === "missing" ? " selected" : "") + ">Нет</option>" +
        "</select></label>" +
        '<label>Страна<select name="country">' + countryOptions(countryValue) + "</select></label>" +
        '<label>Регион<select name="region"></select></label>' +
        '<label>Город<input name="city" value="' + escapeAttr(card.city || "") + '"></label>' +
        '<label>Заметка<textarea name="notes" rows="2">' + escapeHtml(card.notes || "") + "</textarea></label>" +
        '<div class="pair">' +
          '<label>Широта<input name="lat" inputmode="decimal" value="' + escapeAttr(card.lat || "") + '"></label>' +
          '<label>Долгота<input name="lng" inputmode="decimal" value="' + escapeAttr(card.lng || "") + '"></label>' +
        "</div>" +
        '<div class="photos"></div>' +
        '<label>Фото<input name="photo" type="file" accept="image/*" capture="environment" multiple></label>' +
        '<div class="buttons">' +
          '<button type="button" class="geo">Автокоорд</button>' +
          '<button type="submit" class="primary">Сохранить</button>' +
          '<button type="button" class="cancel">Отмена</button>' +
          (card.id ? '<button type="button" class="danger">Удалить карточку</button>' : "") +
        "</div>" +
        '<p class="count form-msg"></p>' +
      "</form>";
    const form = els.detail.querySelector("form");
    els.detail.querySelector(".detail-close").addEventListener("click", closeCard);
    const region = form.region;
    fillRegions(region, countryValue, card.region || "");
    form.country.addEventListener("change", function () {
      fillRegions(region, form.country.value, "");
      if (!form.lat.value && !form.lng.value) {
        const point = countryCenter(form.country.value);
        if (point) writeCoord(form, point);
      }
    });
    const photos = els.detail.querySelector(".photos");
    function drawPhotos(names) {
      photos.innerHTML = "";
      (names || []).forEach(function (name) {
        const line = document.createElement("div");
        line.className = "photo-line";
        line.innerHTML = "<span>" + escapeHtml(name) + '</span><button type="button">Убрать фото</button>';
        line.querySelector("button").addEventListener("click", function () {
          postJson("/api/photo/delete", { id: card.id, name: name }).then(function (saved) {
            remember(saved);
            card.localPhotos = saved.localPhotos || [];
            drawPhotos(card.localPhotos);
          }).catch(function (error) {
            form.querySelector(".form-msg").textContent = error.message;
          });
        });
        photos.appendChild(line);
      });
    }
    drawPhotos(card.localPhotos || []);
    form.querySelector(".geo").addEventListener("click", function () {
      const msg = form.querySelector(".form-msg");
      const code = form.country.value;
      const regionName = form.region.value.trim();
      const cityName = form.city.value.trim();
      if (!code && !regionName && !cityName) {
        msg.textContent = "Сначала выберите страну или впишите город";
        return;
      }
      const params = new URLSearchParams({ code: code, region: regionName, city: cityName });
      msg.textContent = "Ищу центр…";
      fetch("/api/center?" + params.toString()).then(function (res) {
        return res.json().then(function (data) { return { ok: res.ok, data: data }; });
      }).then(function (result) {
        if (result.ok && result.data.lat != null) {
          writeCoord(form, result.data);
          msg.textContent = cityName ? "Центр города" : (regionName ? "Центр области" : "Центр страны");
          return;
        }
        if (!cityName && !regionName) {
          const local = countryCenter(code);
          if (!local) throw new Error("Для этой страны центр не задан");
          writeCoord(form, local);
          msg.textContent = "Центр страны";
          return;
        }
        const place = state.places.find(function (item) { return item.countryCode === code; });
        const countryName = code === "CRIMEA" ? "Crimea" : (place ? (place.nameEn || place.name) : "");
        const query = [cityName, regionName, countryName].filter(Boolean).join(", ");
        return fetch("https://photon.komoot.io/api/?limit=1&q=" + encodeURIComponent(query)).then(function (res) {
          if (!res.ok) throw new Error("Карта не ответила");
          return res.json();
        }).then(function (data) {
          const coords = data.features && data.features[0] && data.features[0].geometry && data.features[0].geometry.coordinates;
          if (!coords) throw new Error("Место не нашлось. Можно вписать координаты вручную");
          const point = { lat: coords[1], lng: coords[0] };
          writeCoord(form, point);
          msg.textContent = "Центр по карте, проверьте точку";
          return postJson("/api/center", {
            countryCode: code,
            region: regionName,
            city: cityName,
            lat: point.lat,
            lng: point.lng
          }).catch(function () {});
        });
      }).catch(function (error) {
        msg.textContent = error.message || "Центр не нашёлся. Можно вписать координаты вручную";
      });
    });
    form.querySelector(".cancel").addEventListener("click", function () {
      closeEditor();
      renderDetail(findItem(state.selectedId));
    });
    const danger = form.querySelector(".danger");
    if (danger) {
      danger.addEventListener("click", function () {
        if (!window.confirm("Удалить карточку «" + (card.name || "") + "»?")) return;
        postJson("/api/delete", { id: card.id }).then(function () {
          state.items = state.items.filter(function (it) { return it.id !== card.id; });
          closeEditor();
          state.selectedId = null;
          renderDetail(null);
          renderList();
        }).catch(function (error) {
          form.querySelector(".form-msg").textContent = error.message;
        });
      });
    }
    form.addEventListener("submit", function (event) {
      event.preventDefault();
      const msg = form.querySelector(".form-msg");
      msg.textContent = "Сохраняю…";
      const files = Array.from(form.photo.files || []);
      Promise.all(files.map(function (file) {
        return fileToBase64(file).then(function (encoded) {
          return { name: file.name, base64: encoded };
        });
      })).then(function (encodedPhotos) {
        return postJson("/api/save", {
          id: card.id,
          name: form.name.value.trim(),
          status: form.status.value,
          countryCode: form.country.value,
          region: form.region.value,
          city: form.city.value.trim(),
          notes: form.notes.value.trim(),
          lat: form.lat.value.trim(),
          lng: form.lng.value.trim(),
          photos: encodedPhotos
        });
      }).then(function (saved) {
        remember(saved);
        closeEditor();
        renderList();
        select(saved.id);
      }).catch(function (error) {
        msg.textContent = error.message;
      });
    });
  }

  if (onThisMachine()) {
    els.add.hidden = false;
    els.git.hidden = false;
    els.lan.hidden = false;
  }
  els.add.addEventListener("click", function () { openEditor(null); });
  function publishStep() {
    return postJson("/api/publish/step", {}).then(function (step) {
      showNote(step.message || "");
      if (!step.done) return publishStep();
      showNote("Отправляю каталог на Git…");
      return postJson("/api/publish", {});
    });
  }

  els.git.addEventListener("click", function () {
    if (state.publishing) return;
    state.publishing = true;
    showNote("Смотрю, что ещё не на Диске…");
    fetch("/api/publish/plan").then(function (res) {
      return res.json().then(function (data) {
        if (!res.ok) throw new Error(data.error || "Не удалось начать отправку");
        return data;
      });
    }).then(function (plan) {
      showNote(plan.message || "");
      return publishStep();
    }).then(function (data) {
      showNote((data && data.message) || "Готово");
    }).catch(function (error) {
      showNote(error.message);
    }).then(function () {
      state.publishing = false;
    });
  });
  fetch("/api/info").then(function (res) { return res.json(); }).then(function (data) {
    if (data.lan) els.lan.textContent = "Телефон в этой сети: " + data.lan;
  }).catch(function () {});

  loadData().then(function (loaded) {
    state.items = loaded[0];
    state.places = loaded[1] || [];
    state.coatFiles = loaded[2] || {};
    renderList();
    initMap();
  }).catch(function () {
    showNote("Не получилось загрузить список магнитов.");
  });
})();

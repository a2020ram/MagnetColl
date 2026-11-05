# -*- coding: utf-8 -*-
"""Local preview and catalog editor: site, photos, and magnet changes."""
import base64
import hashlib
import json
import re
import socket
import subprocess
import threading
import urllib.error
import urllib.request
from datetime import datetime, timezone
from http.server import ThreadingHTTPServer, SimpleHTTPRequestHandler
from pathlib import Path
from urllib.parse import parse_qs, quote, unquote, urlsplit

from PIL import Image

ROOT = Path(__file__).resolve().parent
PHOTOS = Path(r"X:\arslan_2020\Magnet_cloud_sync\Magnets_cloud")
COATS = Path(r"X:\CoA-media\coats")
THUMBS = Path(r"C:\pc-spool\magnetcoll\thumbs")
MAGNETS = ROOT / "data" / "magnets.json"
PLACES = ROOT / "data" / "places.json"
COAT_FILES = ROOT / "data" / "coat-files.json"
UPLOAD_CONFIG = ROOT / "data" / "upload.local.json"
PROGRESS = Path(r"C:\pc-spool\magnetcoll\meta\drive-progress.json")
FLUSH_EVERY = 50
FILE_MIME = {
    ".png": "image/png",
    ".gif": "image/gif",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".svg": "image/svg+xml",
    ".webp": "image/webp",
}
DIVISIONS = Path(r"C:\CoA-site\data\divisions.json")
COUNTRIES = Path(r"C:\CoA-site\data\countries.json")
SEARCH_INDEX = Path(r"C:\CoA-site\public\search-index.json")
CENTERS = Path(r"C:\pc-spool\magnetcoll\place-centers.json")
CRIMEA_LAT = 45.3
CRIMEA_LNG = 34.1
LOCK = threading.Lock()
REGION_CACHE = {}
COAT_INDEX = {"ready": False, "slug": {}, "city": {}, "division": {}, "division_wiki": {}}
COAT_TYPES = {
    ".png": "image/png",
    ".gif": "image/gif",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".svg": "image/svg+xml",
    ".webp": "image/webp",
}


def load_magnets():
    return json.loads(MAGNETS.read_text(encoding="utf-8"))


def save_magnets(items):
    MAGNETS.write_text(json.dumps(items, ensure_ascii=False, indent=2), encoding="utf-8")


def slug(name):
    text = (name or "").strip().casefold().replace("ё", "е")
    text = re.sub(r"[^\w]+", "-", text, flags=re.UNICODE).strip("-")
    return text or "magnet"


def unique_id(items, name):
    base = slug(name)
    taken = {item.get("id") for item in items}
    if base not in taken:
        return base
    number = 2
    while f"{base}-{number}" in taken:
        number += 1
    return f"{base}-{number}"


def safe_filename(name):
    name = Path(name or "photo.jpg").name
    name = re.sub(r"[^\w.\- ()]+", "_", name, flags=re.UNICODE).strip(" .")
    if not name or name.startswith("."):
        name = "photo.jpg"
    if "." not in name:
        name += ".jpg"
    return name


def unique_filename(name):
    candidate = safe_filename(name)
    stem = Path(candidate).stem
    suffix = Path(candidate).suffix
    number = 2
    while (PHOTOS / candidate).exists():
        candidate = f"{stem}-{number}{suffix}"
        number += 1
    return candidate


def store_photo(payload):
    raw_name = payload.get("name") or "photo.jpg"
    encoded = payload.get("base64") or ""
    if "," in encoded[:80]:
        encoded = encoded.split(",", 1)[1]
    data = base64.b64decode(encoded)
    if not data or len(data) > 15_000_000:
        raise ValueError("Фото пустое или больше 15 МБ")
    PHOTOS.mkdir(parents=True, exist_ok=True)
    filename = unique_filename(raw_name)
    (PHOTOS / filename).write_bytes(data)
    return filename


def regions_for(code):
    code = (code or "").upper()
    if code in REGION_CACHE:
        return REGION_CACHE[code]
    if not DIVISIONS.is_file():
        REGION_CACHE[code] = []
        return []
    divisions = json.loads(DIVISIONS.read_text(encoding="utf-8"))
    names = []
    seen = set()
    for item in divisions:
        if item.get("countryCode") != code or item.get("navLevel") != 1:
            continue
        name = ((item.get("name") or {}).get("ru") or (item.get("name") or {}).get("en") or "").strip()
        if not name or name in seen:
            continue
        seen.add(name)
        names.append(name)
    names.sort(key=lambda value: value.casefold())
    REGION_CACHE[code] = names
    return names


def fold(value):
    return (value or "").strip().casefold()


def wiki_file(url):
    if not url:
        return ""
    pos = url.lower().find("file:")
    if pos < 0:
        return ""
    name = unquote(url[pos + 5:].split("?", 1)[0].split("#", 1)[0]).strip()
    if not name:
        return ""
    return "https://commons.wikimedia.org/wiki/Special:FilePath/" + quote(name) + "?width=480"


def ensure_coat_index():
    if COAT_INDEX["ready"]:
        return
    slug = {}
    if COUNTRIES.is_file():
        for item in json.loads(COUNTRIES.read_text(encoding="utf-8")):
            code = item.get("countryCode")
            if code and item.get("slug"):
                slug[code] = item["slug"]
    city = {}
    division = {}
    if SEARCH_INDEX.is_file():
        for item in json.loads(SEARCH_INDEX.read_text(encoding="utf-8")):
            kind = item.get("type")
            path = item.get("coatPath") or ""
            href = item.get("href") or ""
            if kind not in ("city", "division") or not path or not href.startswith("/country/"):
                continue
            parts = [part for part in href.split("/") if part]
            if len(parts) < 2:
                continue
            parent = item.get("parentLabel") or {}
            parents = {fold(parent.get("ru")), fold(parent.get("en"))} - {""}
            names = []
            title = item.get("name") or {}
            names.extend([title.get("ru"), title.get("en")])
            names.extend(item.get("aliases") or [])
            bucket = city if kind == "city" else division
            for name in names:
                key = (parts[1], fold(name))
                if key[1]:
                    bucket.setdefault(key, []).append({"path": path, "parents": parents})
    division_wiki = {}
    if DIVISIONS.is_file():
        for item in json.loads(DIVISIONS.read_text(encoding="utf-8")):
            if item.get("navLevel") != 1:
                continue
            code = item.get("countryCode") or ""
            source = ((item.get("coatOfArms") or {}).get("source")) or ""
            wiki = wiki_file(source)
            if not wiki:
                for coat in item.get("coats") or []:
                    wiki = wiki_file(coat.get("source") or "")
                    if not wiki and coat.get("commonsFile"):
                        wiki = wiki_file("File:" + coat["commonsFile"])
                    if wiki:
                        break
            if not wiki:
                continue
            title = item.get("name") or {}
            for name in (title.get("ru"), title.get("en")):
                key = (code, fold(name))
                if key[1]:
                    division_wiki.setdefault(key, wiki)
    COAT_INDEX.update(ready=True, slug=slug, city=city, division=division, division_wiki=division_wiki)


def pick_coat(entries, region):
    if not entries:
        return ""
    wanted = fold(region)
    if wanted:
        for entry in entries:
            if wanted in entry["parents"]:
                return entry["path"]
    return entries[0]["path"]


def specific_coat(country_code, region, city):
    ensure_coat_index()
    slug = COAT_INDEX["slug"].get(country_code, "")
    if not slug:
        return "", ""
    if city:
        path = pick_coat(COAT_INDEX["city"].get((slug, fold(city))), region)
        if path:
            return path, ""
    if region:
        path = pick_coat(COAT_INDEX["division"].get((slug, fold(region))), "")
        if path:
            return path, COAT_INDEX["division_wiki"].get((country_code, fold(region)), "")
    return "", ""


def center_key(code, region, city):
    return "|".join([(code or "").upper(), fold(region), fold(city)])


def country_point(code):
    if code == "CRIMEA":
        return {"lat": CRIMEA_LAT, "lng": CRIMEA_LNG, "label": "Крым"}
    places = json.loads(PLACES.read_text(encoding="utf-8"))
    place = next((item for item in places if item.get("countryCode") == code), None)
    if not place or place.get("lat") is None or place.get("lng") is None:
        return None
    return {"lat": place["lat"], "lng": place["lng"], "label": place.get("name") or code}


def lookup_center(code, region, city):
    code = (code or "").strip().upper()
    region = (region or "").strip()
    city = (city or "").strip()
    if city or region:
        if CENTERS.is_file():
            cached = json.loads(CENTERS.read_text(encoding="utf-8")).get(center_key(code, region, city))
            if cached:
                return cached
        return None
    if not code:
        return None
    return country_point(code)


def remember_center(data):
    code = (data.get("countryCode") or "").strip().upper()
    region = (data.get("region") or "").strip()
    city = (data.get("city") or "").strip()
    lat = number_or_none(data.get("lat"))
    lng = number_or_none(data.get("lng"))
    if lat is None or lng is None or not (-90 <= lat <= 90 and -180 <= lng <= 180):
        raise ValueError("Неверные координаты")
    if not (city or region):
        point = country_point(code)
        if point is None:
            raise ValueError("Страна без центра")
        return point
    point = {"lat": round(lat, 5), "lng": round(lng, 5)}
    with LOCK:
        cached = json.loads(CENTERS.read_text(encoding="utf-8")) if CENTERS.is_file() else {}
        cached[center_key(code, region, city)] = point
        CENTERS.parent.mkdir(parents=True, exist_ok=True)
        CENTERS.write_text(json.dumps(cached, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    return point


def apply_place(magnet, country_code, region, city, previous_code):
    places = json.loads(PLACES.read_text(encoding="utf-8"))
    region = (region or "").strip()
    city = (city or "").strip()
    if country_code == "CRIMEA":
        magnet["crimea"] = True
        magnet["continent"] = ""
        magnet["country"] = ""
        magnet["countryCode"] = ""
        magnet["region"] = ""
        magnet["city"] = city
        if previous_code != "CRIMEA":
            magnet["coaPath"] = ""
            magnet["coaWiki"] = ""
        return
    place = next((item for item in places if item.get("countryCode") == country_code), None)
    magnet["crimea"] = False
    magnet["region"] = region
    magnet["city"] = city
    if not place:
        magnet["continent"] = ""
        magnet["country"] = ""
        magnet["countryCode"] = ""
        if previous_code:
            magnet["coaPath"] = ""
            magnet["coaWiki"] = ""
        return
    magnet["continent"] = place.get("continent") or ""
    magnet["country"] = place.get("name") or ""
    magnet["countryCode"] = place.get("countryCode") or ""
    path, wiki = specific_coat(country_code, region, city) if (region or city) else ("", "")
    if path:
        magnet["coaPath"] = path
        magnet["coaWiki"] = wiki or place.get("coaWiki") or ""
    elif country_code != previous_code or not (region or city):
        magnet["coaPath"] = place.get("coaPath") or ""
        magnet["coaWiki"] = place.get("coaWiki") or ""


def blank_magnet(name):
    return {
        "id": "",
        "name": name,
        "status": "owned",
        "addedAt": datetime.now(timezone.utc).date().isoformat(),
        "lat": None,
        "lng": None,
        "driveFileId": "",
        "resourceKey": "",
        "localPhotos": [],
        "continent": "",
        "country": "",
        "region": "",
        "city": "",
        "coaImageUrl": "",
        "notes": "",
        "crimea": False,
        "countryCode": "",
        "coaPath": "",
        "coaWiki": "",
    }


def number_or_none(value):
    if value is None or value == "":
        return None
    try:
        number = float(value)
    except (TypeError, ValueError):
        return None
    if number != number:
        return None
    return number


def save_card(data):
    if (data.get("region") or "").strip() or (data.get("city") or "").strip():
        ensure_coat_index()
    with LOCK:
        items = load_magnets()
        incoming_id = (data.get("id") or "").strip()
        current = next((item for item in items if item.get("id") == incoming_id), None) if incoming_id else None
        name = (data.get("name") or "").strip()
        if not name:
            raise ValueError("Нужно название")
        if current is None:
            current = blank_magnet(name)
            current["id"] = unique_id(items, name)
            items.append(current)
        previous = "CRIMEA" if current.get("crimea") else (current.get("countryCode") or "")
        current["name"] = name
        current["status"] = "missing" if data.get("status") == "missing" else "owned"
        current["notes"] = (data.get("notes") or "").strip()
        current["lat"] = number_or_none(data.get("lat"))
        current["lng"] = number_or_none(data.get("lng"))
        apply_place(current, (data.get("countryCode") or "").strip(), data.get("region"), data.get("city"), previous)
        photos = current.setdefault("localPhotos", [])
        for payload in data.get("photos") or []:
            photos.append(store_photo(payload))
        save_magnets(items)
        return current


def photo_name(filename):
    filename = Path(filename or "").name
    if not filename or filename.startswith(".") or "/" in filename or "\\" in filename:
        raise ValueError("Неверное имя фото")
    return filename


def delete_photo(magnet_id, filename):
    filename = photo_name(filename)
    with LOCK:
        items = load_magnets()
        current = next((item for item in items if item.get("id") == magnet_id), None)
        if current is None:
            raise ValueError("Карточка не найдена")
        photos = [name for name in current.get("localPhotos") or [] if name != filename]
        current["localPhotos"] = photos
        used = any(filename in (item.get("localPhotos") or []) for item in items)
        save_magnets(items)
    if not used:
        file = PHOTOS / filename
        if file.is_file():
            file.unlink()
    return current


def delete_magnet(magnet_id):
    with LOCK:
        items = load_magnets()
        current = next((item for item in items if item.get("id") == magnet_id), None)
        if current is None:
            raise ValueError("Карточка не найдена")
        filenames = list(current.get("localPhotos") or [])
        items = [item for item in items if item.get("id") != magnet_id]
        still = {name for item in items for name in (item.get("localPhotos") or [])}
        save_magnets(items)
    for filename in filenames:
        if filename in still:
            continue
        file = PHOTOS / filename
        if file.is_file():
            file.unlink()
    return {"ok": True}


def load_upload_config():
    if not UPLOAD_CONFIG.is_file():
        return {}
    return json.loads(UPLOAD_CONFIG.read_text(encoding="utf-8"))


def load_progress():
    if not PROGRESS.is_file():
        return {"photos": {}, "coats": {}, "skip": [], "since_flush": 0}
    data = json.loads(PROGRESS.read_text(encoding="utf-8"))
    data.setdefault("photos", {})
    data.setdefault("coats", {})
    data.setdefault("skip", [])
    data.setdefault("since_flush", 0)
    return data


def save_progress(data):
    PROGRESS.parent.mkdir(parents=True, exist_ok=True)
    PROGRESS.write_text(json.dumps(data, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def coat_disk_file(coa_path):
    rel = (coa_path or "").replace("\\", "/")
    if "/media/coats/" in rel:
        rel = rel.split("/media/coats/", 1)[1]
    rel = rel.lstrip("/")
    if not rel or ".." in rel.split("/"):
        return None, ""
    file = (COATS / rel).resolve()
    if not str(file).startswith(str(COATS.resolve())) or not file.is_file():
        return None, rel
    return file, rel


def collect_jobs(items, places, progress):
    jobs = []
    photos = progress["photos"]
    skip = set(progress["skip"])
    seen = set()
    for item in items:
        names = []
        for raw in item.get("localPhotos") or []:
            name = Path(str(raw)).name
            if name and name not in names:
                names.append(name)
        file_id = (item.get("driveFileId") or "").strip()
        if names and file_id and "/" not in file_id and "?" not in file_id:
            photos.setdefault(names[0], file_id)
        for pair in item.get("drivePhotos") or []:
            if pair.get("name") and pair.get("id"):
                photos.setdefault(pair["name"], pair["id"])
        for name in names:
            key = "photo:" + name
            if name in photos or key in skip or key in seen:
                continue
            if not (PHOTOS / name).is_file():
                progress["skip"].append(key)
                skip.add(key)
                continue
            seen.add(key)
            jobs.append({"kind": "photo", "name": name})
    paths = []
    for item in list(items) + list(places):
        path = item.get("coaPath") or ""
        if path and path not in paths:
            paths.append(path)
    for path in paths:
        key = "coat:" + path
        if path in progress["coats"] or key in skip or key in seen:
            continue
        file, _rel = coat_disk_file(path)
        if file is None:
            progress["skip"].append(key)
            skip.add(key)
            continue
        seen.add(key)
        jobs.append({"kind": "coat", "name": path})
    return jobs


def upload_file(kind, drive_name, data_bytes):
    config = load_upload_config()
    url = (config.get("uploadUrl") or "").strip()
    secret = (config.get("uploadSecret") or "").strip()
    if not url or not secret:
        raise ValueError("Сначала впишите адрес скрипта Google в data/upload.local.json.")
    mime = FILE_MIME.get(Path(drive_name).suffix.lower(), "application/octet-stream")
    payload = json.dumps({
        "secret": secret,
        "kind": kind,
        "name": drive_name,
        "mime": mime,
        "base64": base64.b64encode(data_bytes).decode("ascii"),
    }).encode("utf-8")
    request = urllib.request.Request(url, data=payload, headers={"Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(request, timeout=180) as response:
            body = response.read().decode("utf-8")
    except urllib.error.HTTPError as error:
        detail = error.read().decode("utf-8", "replace")[:300]
        raise ValueError("Диск ответил ошибкой: " + detail) from error
    except urllib.error.URLError as error:
        raise ValueError("Скрипт Google не открылся: " + str(error.reason)) from error
    try:
        result = json.loads(body)
    except json.JSONDecodeError as error:
        raise ValueError("Скрипт Google вернул страницу вместо ответа. Проверьте адрес, он должен кончаться на /exec, и доступ «Все».") from error
    if result.get("error"):
        raise ValueError(str(result["error"]))
    if not result.get("id"):
        raise ValueError("Диск не вернул ссылку на файл")
    return result["id"]


def flush_catalog(progress):
    with LOCK:
        items = load_magnets()
        for item in items:
            names = []
            for raw in item.get("localPhotos") or []:
                name = Path(str(raw)).name
                if name and name not in names:
                    names.append(name)
            pairs = []
            for name in names:
                file_id = (progress.get("photos") or {}).get(name) or ""
                if file_id:
                    pairs.append({"name": name, "id": file_id})
            if pairs:
                item["drivePhotos"] = pairs
                if not (item.get("driveFileId") or "").strip():
                    item["driveFileId"] = pairs[0]["id"]
        save_magnets(items)
        COAT_FILES.write_text(json.dumps(progress.get("coats") or {}, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    progress["since_flush"] = 0


def publish_plan():
    config = load_upload_config()
    if not (config.get("uploadUrl") or "").strip() or not (config.get("uploadSecret") or "").strip():
        raise ValueError("Сначала впишите адрес скрипта Google в data/upload.local.json.")
    progress = load_progress()
    items = load_magnets()
    places = json.loads(PLACES.read_text(encoding="utf-8"))
    jobs = collect_jobs(items, places, progress)
    save_progress(progress)
    return {"ok": True, "left": len(jobs), "message": "Осталось отправить на Диск: " + str(len(jobs))}


def publish_step():
    config = load_upload_config()
    if not (config.get("uploadUrl") or "").strip() or not (config.get("uploadSecret") or "").strip():
        raise ValueError("Сначала впишите адрес скрипта Google в data/upload.local.json.")
    progress = load_progress()
    items = load_magnets()
    places = json.loads(PLACES.read_text(encoding="utf-8"))
    jobs = collect_jobs(items, places, progress)
    if not jobs:
        flush_catalog(progress)
        save_progress(progress)
        return {"done": True, "message": "На Диске всё, что нужно."}
    job = jobs[0]
    if job["kind"] == "photo":
        data = (PHOTOS / job["name"]).read_bytes()
        file_id = upload_file("photo", job["name"], data)
        progress["photos"][job["name"]] = file_id
        label = "Фото"
        shown = job["name"]
    else:
        file, rel = coat_disk_file(job["name"])
        file_id = upload_file("coat", rel.replace("/", "__"), file.read_bytes())
        progress["coats"][job["name"]] = file_id
        label = "Герб"
        shown = rel
    progress["since_flush"] = int(progress.get("since_flush") or 0) + 1
    save_progress(progress)
    if progress["since_flush"] >= FLUSH_EVERY:
        flush_catalog(progress)
        save_progress(progress)
    left = len(jobs) - 1
    return {"done": False, "message": label + ": " + shown + " · осталось " + str(left)}


def publish_git():
    progress = load_progress()
    if progress.get("photos") or progress.get("coats"):
        flush_catalog(progress)
        save_progress(progress)
    if not (ROOT / ".git").exists():
        return "Каталог записан на компьютере. Репозиторий Git ещё не создан, на GitHub ничего не ушло."
    git = ["git", "-C", str(ROOT)]
    paths = ["data/magnets.json", "data/coat-files.json"]
    subprocess.run(git + ["add", "--"] + paths, check=True)
    status = subprocess.run(git + ["status", "--porcelain", "--"] + paths, capture_output=True, text=True, check=True)
    if status.stdout.strip():
        subprocess.run(git + ["commit", "-m", "Обновить каталог магнитов"], check=True)
    push = subprocess.run(git + ["push"], capture_output=True, text=True)
    if push.returncode != 0:
        detail = (push.stderr or push.stdout or "").strip()
        return "Изменения записаны в Git. Отправка не прошла: " + detail
    return "Каталог отправлен на GitHub."


def lan_addresses():
    found = []
    try:
        infos = socket.getaddrinfo(socket.gethostname(), None, socket.AF_INET)
    except OSError:
        infos = []
    for info in infos:
        ip = info[4][0]
        if ip.startswith("127.") or ip.startswith("169.254.") or ip in found:
            continue
        found.append(ip)
    home = [ip for ip in found if ip.startswith("192.168.")]
    return home or found


def lan_url():
    addresses = lan_addresses()
    ip = addresses[0] if addresses else "127.0.0.1"
    return f"http://{ip}:8765/"


class Handler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(ROOT), **kwargs)

    def do_GET(self):
        parts = urlsplit(self.path)
        path = unquote(parts.path)
        if path == "/api/publish/plan":
            try:
                self.send_json(200, publish_plan())
            except ValueError as error:
                self.send_json(400, {"error": str(error)})
            return
        if path == "/api/info":
            self.send_json(200, {"lan": lan_url()})
            return
        if path == "/api/center":
            query = parse_qs(parts.query)
            point = lookup_center(
                (query.get("code") or [""])[0],
                (query.get("region") or [""])[0],
                (query.get("city") or [""])[0],
            )
            if point is None:
                self.send_json(404, {"error": "Нет сохранённого центра"})
            else:
                self.send_json(200, point)
            return
        if path == "/api/regions":
            code = (parse_qs(parts.query).get("code") or [""])[0]
            self.send_json(200, {"regions": regions_for(code)})
            return
        if path.startswith("/photos/"):
            name = path[len("/photos/"):]
            if not name or "/" in name or "\\" in name or name.startswith("."):
                self.send_error(404)
                return
            file = PHOTOS / name
            if not file.is_file():
                self.send_error(404)
                return
            width = 0
            raw_w = (parse_qs(parts.query).get("w") or [""])[0]
            if raw_w.isdigit():
                width = min(int(raw_w), 800)
            data = thumb_bytes(file, width) if width else file.read_bytes()
            self.send_response(200)
            self.send_header("Content-Type", "image/jpeg")
            self.send_header("Content-Length", str(len(data)))
            self.send_header("Cache-Control", "public, max-age=86400")
            self.end_headers()
            self.wfile.write(data)
            return
        if path.startswith("/coats/"):
            rel = path[len("/coats/"):]
            if not rel or ".." in rel.split("/"):
                self.send_error(404)
                return
            file = (COATS / rel).resolve()
            if not str(file).startswith(str(COATS.resolve())) or not file.is_file():
                self.send_error(404)
                return
            data = file.read_bytes()
            self.send_response(200)
            self.send_header("Content-Type", COAT_TYPES.get(file.suffix.lower(), "application/octet-stream"))
            self.send_header("Content-Length", str(len(data)))
            self.send_header("Cache-Control", "public, max-age=86400")
            self.end_headers()
            self.wfile.write(data)
            return
        super().do_GET()

    def end_headers(self):
        path = urlsplit(self.path).path
        if path == "/" or path.endswith((".html", ".js", ".css")):
            self.send_header("Cache-Control", "no-cache")
        super().end_headers()

    def do_POST(self):
        path = unquote(urlsplit(self.path).path)
        try:
            length = int(self.headers.get("Content-Length") or 0)
            raw = self.rfile.read(length) if length else b"{}"
            data = json.loads(raw.decode("utf-8") or "{}")
            if path == "/api/save":
                saved = save_card(data)
                self.send_json(200, saved)
            elif path == "/api/photo/delete":
                saved = delete_photo(data.get("id") or "", data.get("name") or "")
                self.send_json(200, saved)
            elif path == "/api/delete":
                self.send_json(200, delete_magnet(data.get("id") or ""))
            elif path == "/api/center":
                self.send_json(200, remember_center(data))
            elif path == "/api/publish/step":
                self.send_json(200, publish_step())
            elif path == "/api/publish":
                self.send_json(200, {"message": publish_git()})
            else:
                self.send_json(404, {"error": "Нет такого действия"})
        except ValueError as error:
            self.send_json(400, {"error": str(error)})
        except Exception as error:
            self.send_json(500, {"error": str(error)})

    def send_json(self, status, payload):
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)


def thumb_bytes(file, width):
    stamp = file.stat().st_mtime_ns
    key = hashlib.sha1(f"{file.name}|{stamp}|{width}".encode("utf-8")).hexdigest()
    dest = THUMBS / (key + ".jpg")
    if dest.is_file():
        return dest.read_bytes()
    image = Image.open(file)
    image = image.convert("RGB")
    image.thumbnail((width, width))
    THUMBS.mkdir(parents=True, exist_ok=True)
    image.save(dest, "JPEG", quality=72)
    return dest.read_bytes()


if __name__ == "__main__":
    try:
        print("http://127.0.0.1:8765/")
        print("С телефона в этой сети: " + lan_url())
        ThreadingHTTPServer(("0.0.0.0", 8765), Handler).serve_forever()
    except OSError:
        print("Порт 8765 занят. Закройте предыдущее окно запуска.")
        raise SystemExit(1)

#!/usr/bin/env python3
"""KOReader Estante - Backend"""
import os, sys, json, sqlite3, datetime, urllib.parse, tempfile, hashlib, threading, time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

DB_PATH = os.environ.get("DB_PATH", "statistics.sqlite3")
PORT    = int(os.environ.get("PORT", "8080"))
HOST    = "0.0.0.0"
TZ_H    = int(os.environ.get("TZ_OFFSET_HOURS", "-3"))
TZ_OFF  = datetime.timezone(datetime.timedelta(hours=TZ_H))
TZ_SQL  = f"+{TZ_H:02d}:00" if TZ_H >= 0 else f"-{abs(TZ_H):02d}:00"
SETTINGS_PATH = os.environ.get(
    "SETTINGS_PATH",
    os.path.join(os.path.dirname(os.path.abspath(DB_PATH)), "settings.json"),
)

DEFAULT_SETTINGS = {
    "accent": None,
    "excludeAbandoned": False,
    "titleFilters": [],
    "authorFilters": [],
}
VALID_FILTER_OPS = {"contains", "equals", "starts_with", "ends_with"}

MIME = {".html":"text/html; charset=utf-8",".css":"text/css; charset=utf-8",
        ".js":"application/javascript; charset=utf-8",".json":"application/json; charset=utf-8",
        ".png":"image/png",".jpg":"image/jpeg",".svg":"image/svg+xml",".ico":"image/x-icon"}

def fmt_author(raw):
    if not raw or raw.lower()=="n/a": return "Autor Desconhecido"
    out=[]
    for a in [x.strip() for x in raw.split("\n") if x.strip()]:
        if "," in a and a.count(",")==1:
            s=a.split(","); out.append(f"{s[1].strip()} {s[0].strip()}")
        else: out.append(a)
    return ", ".join(out)

def get_db_status():
    if not os.path.exists(DB_PATH): return {"exists":False,"modified":0,"size":0}
    st=os.stat(DB_PATH); return {"exists":True,"modified":st.st_mtime,"size":st.st_size}

def _normalize_filter_list(items):
    out = []
    if not isinstance(items, list):
        return out
    for item in items:
        if not isinstance(item, dict):
            continue
        op = item.get("op", "contains")
        val = str(item.get("val", "")).strip()
        if op not in VALID_FILTER_OPS or not val:
            continue
        out.append({"op": op, "val": val})
    return out

def _normalize_settings(raw):
    s = dict(DEFAULT_SETTINGS)
    if not isinstance(raw, dict):
        return s

    accent = raw.get("accent", None)
    if accent in (None, ""):
        s["accent"] = None
    elif isinstance(accent, str) and len(accent) == 7 and accent.startswith("#"):
        s["accent"] = accent.lower()

    s["excludeAbandoned"] = bool(raw.get("excludeAbandoned", False))
    s["titleFilters"] = _normalize_filter_list(raw.get("titleFilters", []))
    s["authorFilters"] = _normalize_filter_list(raw.get("authorFilters", []))
    return s

def load_settings():
    try:
        with open(SETTINGS_PATH, "r", encoding="utf-8") as fh:
            return _normalize_settings(json.load(fh))
    except Exception:
        return dict(DEFAULT_SETTINGS)

def save_settings(settings):
    payload = json.dumps(_normalize_settings(settings), ensure_ascii=False, indent=2, sort_keys=True)
    settings_dir = os.path.dirname(SETTINGS_PATH)
    if settings_dir:
        os.makedirs(settings_dir, exist_ok=True)
    fd, tmp_path = tempfile.mkstemp(prefix=".settings.", dir=settings_dir or None)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as fh:
            fh.write(payload)
            fh.write("\n")
        os.replace(tmp_path, SETTINGS_PATH)
    finally:
        try:
            if os.path.exists(tmp_path):
                os.unlink(tmp_path)
        except OSError:
            pass

# ── Hardcover / Real Pages ───────────────────────────────────────────────

import hardcover

REAL_PAGES_DB = os.environ.get(
    "REAL_PAGES_DB",
    os.path.join(os.path.dirname(os.path.abspath(DB_PATH)), "real_pages.sqlite3"),
)

def init_real_pages_db():
    try:
        conn = sqlite3.connect(REAL_PAGES_DB)
        conn.execute(
            "CREATE TABLE IF NOT EXISTS real_pages ("
            "md5 TEXT PRIMARY KEY,"
            "pages INTEGER NOT NULL,"
            "title TEXT,"
            "author TEXT,"
            "edition_id TEXT,"
            "book_id TEXT,"
            "updated_at INTEGER NOT NULL)"
        )
        conn.commit()
        conn.close()
    except Exception as e:
        print(f"[real_pages] init error: {e}")

def get_all_real_pages():
    try:
        conn = sqlite3.connect(REAL_PAGES_DB)
        conn.row_factory = sqlite3.Row
        cur = conn.execute("SELECT * FROM real_pages ORDER BY updated_at DESC")
        rows = [dict(r) for r in cur.fetchall()]
        conn.close()
        return rows
    except Exception:
        return []

def save_real_page(md5, pages, title="", author="", edition_id="", book_id=""):
    try:
        conn = sqlite3.connect(REAL_PAGES_DB)
        conn.execute(
            "INSERT OR REPLACE INTO real_pages (md5, pages, title, author, edition_id, book_id, updated_at) "
            "VALUES (?, ?, ?, ?, ?, ?, ?)",
            (md5, pages, title, author, edition_id, book_id, int(time.time())),
        )
        conn.commit()
        conn.close()
        return True
    except Exception:
        return False

def delete_real_page(md5):
    try:
        conn = sqlite3.connect(REAL_PAGES_DB)
        conn.execute("DELETE FROM real_pages WHERE md5 = ?", (md5,))
        conn.commit()
        conn.close()
        return True
    except Exception:
        return False

# ── Filter helpers ────────────────────────────────────────────────────────

def _parse_filters(raw):
    """Parse JSON filters from query string. Returns dict or None."""
    if not raw:
        return None
    try:
        data = json.loads(raw)
        if not isinstance(data, dict):
            return None
        return data
    except (json.JSONDecodeError, TypeError):
        return None

def _filter_sql(sql, ids):
    """Inject ``AND/WHERE id_book IN (…)`` into a SQL query.

    Handles queries that already have ``WHERE``, ``GROUP BY``
    and/or ``ORDER BY``.

    *ids* may be *None* (no filtering), an empty tuple (no matches),
    or a tuple of integers.
    """
    if ids is None:
        return sql
    if not ids:
        ids = (-1,)  # impossible sentinel — ensures empty result
    placeholders = ",".join("?" * len(ids))
    clause = f"id_book IN ({placeholders})"
    connector = "AND" if "WHERE" in sql else "WHERE"
    insert = f"{connector} {clause}"
    if "GROUP BY" in sql:
        return sql.replace("GROUP BY", f"{insert} GROUP BY", 1)
    order_idx = sql.rfind("ORDER BY")
    if order_idx != -1:
        return sql[:order_idx] + insert + " " + sql[order_idx:]
    if "WHERE" in sql:
        return sql + f" {insert}"
    return f"{sql} {insert}"

def _match_book(book, filters, field):
    """Return True if *book* matches ANY of the *filters* for *field*."""
    if not filters:
        return True
    bval = (book.get(field) or "").lower().strip()
    for f in filters:
        op = f.get("op", "contains")
        val = (f.get("val") or "").lower().strip()
        if not val:
            continue
        if op == "equals" and bval == val:
            return True
        if op == "starts_with" and bval.startswith(val):
            return True
        if op == "ends_with" and bval.endswith(val):
            return True
        if op == "contains" and val in bval:
            return True
    return False

def _apply_book_filters(books, filters):
    """Return (filtered_books, applied_filter_description)."""
    if not filters:
        return books, None
    exclude_abandoned = filters.get("exclude_abandoned", False)
    title_filters     = filters.get("title_filters", []) or []
    author_filters    = filters.get("author_filters", []) or []

    out = list(books)

    if exclude_abandoned:
        out = [b for b in out if b["status"] != "abandoned"]

    if title_filters:
        out = [b for b in out if not _match_book(b, title_filters, "title")]
    if author_filters:
        out = [b for b in out if not _match_book(b, author_filters, "author")]

    applied = []
    if exclude_abandoned:
        applied.append("exclude_abandoned")
    if title_filters:
        applied.append(f"title_filters({len(title_filters)})")
    if author_filters:
        applied.append(f"author_filters({len(author_filters)})")
    desc = ", ".join(applied) if applied else None

    return out, desc

# ── Stats response cache ────────────────────────────────────────────────
_stats_cache = {}
_stats_cache_lock = threading.Lock()
_CACHE_MAX_ENTRIES = 20

STATS_CACHE_VERSION = "2"

def _cache_key(filters_raw, db_mtime):
    raw = f"v:{STATS_CACHE_VERSION}|f:{filters_raw or ''}|m:{db_mtime}"
    return hashlib.md5(raw.encode()).hexdigest()

def _check_stats_cache(filters_raw):
    try:
        mtime = os.stat(DB_PATH).st_mtime
    except OSError:
        return None
    key = _cache_key(filters_raw, mtime)
    with _stats_cache_lock:
        entry = _stats_cache.get(key)
        if entry:
            return entry
    return None

def _save_stats_cache(filters_raw, result):
    mtime = result.get("_mtime", 0)
    if not mtime:
        return
    key = _cache_key(filters_raw, mtime)
    with _stats_cache_lock:
        if len(_stats_cache) >= _CACHE_MAX_ENTRIES and key not in _stats_cache:
            _stats_cache.pop(next(iter(_stats_cache)))
        _stats_cache[key] = result

def _clear_stats_cache():
    with _stats_cache_lock:
        _stats_cache.clear()

# ── Statistics engine ─────────────────────────────────────────────────────

def get_statistics(raw_filters=None):
    """Compute and return all statistics, optionally applying *raw_filters*.

    *raw_filters* is a dict parsed from the JSON query parameter, or *None*.
    """
    if not os.path.exists(DB_PATH):
        return {"error":f"DB não encontrado: {os.path.abspath(DB_PATH)}"}
    try:
        conn=sqlite3.connect(f"file:{DB_PATH}?mode=ro",uri=True); c=conn.cursor()
        parsed_filters = _parse_filters(raw_filters)

        # ── 0. Load real pages ─────────────────────────────────────────
        real_pages_map = {r["md5"]: r for r in get_all_real_pages()}

        # ── 1. Load all books, deduplicate, determine status ────────────
        c.execute("SELECT id,title,authors,pages,total_read_pages,total_read_time,"
                  "last_open,highlights,notes,md5 FROM book ORDER BY last_open DESC")
        raw=c.fetchall()

        seen_set=set()
        books=[]
        for r in raw:
            md5=r[9]
            if md5:
                if md5 in seen_set: continue
                seen_set.add(md5)
            rp = real_pages_map.get(md5) if md5 else None
            has_rp = rp is not None
            ko_pages = r[3] or 1
            effective_pages = rp["pages"] if has_rp else ko_pages
            books.append({"id":r[0],"title":r[1] or "Sem Título","author":fmt_author(r[2]),
                "pages":ko_pages,"read_pages":r[4] or 0,"read_time":r[5] or 0,
                "last_open":r[6] or 0,"highlights":r[7] or 0,"notes":r[8] or 0,"md5":md5,
                "effective_pages":effective_pages,"has_real_pages":has_rp,
                "real_pages":rp["pages"] if has_rp else None})

        mx=max((b["last_open"] for b in books),default=0)
        books=[b for b in books if not ((b["read_pages"]<=5 or b["read_time"]<=300) and b["last_open"]<mx-7*86400)]

        for b in books:
            ep = b["effective_pages"]
            ko = b["pages"]
            b["progress"]=round(min(100.0,b["read_pages"]/ko*100 if ko>0 else 0),1)
            # Speed: use estimated pages read (capped at effective_pages when real_pages available)
            if b["has_real_pages"]:
                speed_pages = min(b["read_pages"], ep)
            else:
                speed_pages = b["read_pages"]
            b["speed"]=round(speed_pages/(b["read_time"]/3600.0),1) if b["read_time"]>0 else 0.0

        # Page stats for status computation
        c.execute("SELECT id_book,MAX(page),MAX(total_pages) FROM page_stat_data GROUP BY id_book")
        pstats={r[0]:(r[1],r[2]) for r in c.fetchall()}

        for b in books:
            mp,stp=pstats.get(b["id"],(0,0))
            koreader_done = (mp/(stp or 1)>=0.95 or mp/(b["pages"] or 1)>=0.95)
            if b["has_real_pages"]:
                fin = koreader_done
            else:
                fin = (b["progress"]>=95 or (koreader_done and b["progress"]>=50))
            b["status"]="finished" if fin else ("reading" if b["last_open"]>=mx-30*86400 else "abandoned")

        # ── 2. Apply user filters ───────────────────────────────────────
        books_before = len(books)
        books, filter_desc = _apply_book_filters(books, parsed_filters)
        filter_actually_changed = len(books) != books_before

        included_ids = tuple(b["id"] for b in books)
        ids_param = included_ids if filter_actually_changed else None

        has_filter = parsed_filters is not None and (
            parsed_filters.get("exclude_abandoned", False) or
            (parsed_filters.get("title_filters") or []) or
            (parsed_filters.get("author_filters") or [])
        )

        # ── 3. Aggregations on page_stat_data (with optional filter) ────
        q_avg = _filter_sql(
            "SELECT AVG(duration) FROM page_stat_data WHERE duration>0 AND duration<1800",
            ids_param)
        c.execute(q_avg) if ids_param is None else c.execute(q_avg, included_ids)
        avg_pt=c.fetchone()[0] or 0.0

        q_monthly = _filter_sql(
            f"SELECT strftime('%Y-%m',datetime(start_time,'unixepoch','{TZ_SQL}')) AS m,"
            f"SUM(duration)/3600.0,COUNT(DISTINCT id_book) FROM page_stat_data "
            f"WHERE start_time>0 GROUP BY m ORDER BY m",
            ids_param)
        params = () if ids_param is None else included_ids
        c.execute(q_monthly, params) if ids_param is not None else c.execute(q_monthly)
        monthly=[{"month":r[0],"hours":round(r[1],2),"books":r[2]} for r in c.fetchall()]

        q_hourly = _filter_sql(
            f"SELECT strftime('%H',datetime(start_time,'unixepoch','{TZ_SQL}')) AS h,"
            f"SUM(duration)/3600.0 FROM page_stat_data WHERE start_time>0 "
            f"GROUP BY h ORDER BY h",
            ids_param)
        c.execute(q_hourly, params) if ids_param is not None else c.execute(q_hourly)
        hmap={f"{i:02d}":0.0 for i in range(24)}
        for r in c.fetchall(): hmap[r[0]]=round(r[1],2)
        hourly=[{"hour":k,"hours":v} for k,v in sorted(hmap.items())]

        q_weekly = _filter_sql(
            f"SELECT strftime('%w',datetime(start_time,'unixepoch','{TZ_SQL}')) AS d,"
            f"SUM(duration)/3600.0 FROM page_stat_data WHERE start_time>0 "
            f"GROUP BY d ORDER BY d",
            ids_param)
        c.execute(q_weekly, params) if ids_param is not None else c.execute(q_weekly)
        dow=["Dom","Seg","Ter","Qua","Qui","Sex","Sáb"]; wmap={str(i):0.0 for i in range(7)}
        for r in c.fetchall(): wmap[r[0]]=round(r[1],2)
        weekly=[{"dow":int(k),"day":dow[int(k)],"hours":v} for k,v in sorted(wmap.items())]

        c.execute(
            f"SELECT DISTINCT date(start_time,'unixepoch','{TZ_SQL}') "
            f"FROM page_stat_data WHERE start_time>0 ORDER BY 1")
        dates=[datetime.date.fromisoformat(r[0]) for r in c.fetchall()]

        c.execute(
            f"SELECT date(start_time,'unixepoch','{TZ_SQL}') AS d,"
            f"ROUND(SUM(COALESCE(duration,0))/3600.0,3) FROM page_stat_data WHERE start_time>0 AND duration>0 "
            f"GROUP BY d ORDER BY d")
        hm_raw={r[0]:r[1] for r in c.fetchall()}

        q_span = _filter_sql(
            f"SELECT id_book,COUNT(DISTINCT date(start_time,'unixepoch','{TZ_SQL}')) "
            f"FROM page_stat_data WHERE start_time>0 GROUP BY id_book",
            ids_param)
        c.execute(q_span, params) if ids_param is not None else c.execute(q_span)
        reading_span={r[0]:r[1] for r in c.fetchall()}

        conn.close()

        # ── 4. Compute derived summaries ────────────────────────────────
        today=datetime.date.today()
        nf=sum(1 for b in books if b["status"]=="finished")
        nr=sum(1 for b in books if b["status"]=="reading")
        na=sum(1 for b in books if b["status"]=="abandoned")
        ts=sum(b["read_time"] for b in books)
        tp=sum(min(b["read_pages"], b["effective_pages"]) if b["has_real_pages"] else b["read_pages"] for b in books)
        th=sum(b["highlights"] for b in books); tn=sum(b["notes"] for b in books)
        spd=round(tp/(ts/3600.0),1) if ts>0 else 0.0
        d30=today-datetime.timedelta(days=30)
        days30=sum(1 for d in hm_raw if datetime.date.fromisoformat(d)>=d30)
        hrs30=round(sum(v for k,v in hm_raw.items() if datetime.date.fromisoformat(k)>=d30),1)

        sr=["<100","100–199","200–299","300–399","400–499","500–999","1000–1999","2000–2999","3000+"]; sc=[0]*9
        for b in books:
            p=b["effective_pages"]
            if p<100:sc[0]+=1
            elif p<200:sc[1]+=1
            elif p<300:sc[2]+=1
            elif p<400:sc[3]+=1
            elif p<500:sc[4]+=1
            elif p<1000:sc[5]+=1
            elif p<2000:sc[6]+=1
            elif p<3000:sc[7]+=1
            else:sc[8]+=1
        size_dist=[{"range":r,"count":c} for r,c in zip(sr,sc)]

        wpm_list = []
        for b in books:
            w = round(b["speed"] * 300 / 60, 0) if b["speed"] > 0 else 0
            if b["has_real_pages"] and w > 0:
                wpm_list.append(w)

        avg_wpm = round(sum(wpm_list) / len(wpm_list), 0) if wpm_list else 0
        if avg_wpm <= 200:
            wpm_profile = "Leitor Analítico"
        elif avg_wpm <= 300:
            wpm_profile = "Velocidade Padrão"
        else:
            wpm_profile = "Leitor Rápido"

        summary={"total_books":len(books),"finished_books":nf,"reading_books":nr,"abandoned_books":na,
            "total_time_seconds":ts,"total_pages_read":tp,"total_highlights":th,"total_notes":tn,
            "avg_speed_pages_hour":spd,"avg_page_time_seconds":round(avg_pt,1),
            "days_read_30d":days30,"hours_30d":hrs30,"avg_wpm":avg_wpm,"wpm_profile":wpm_profile}

        amap={}
        for b in books:
            a=b["author"]
            if a and a!="Autor Desconhecido":
                if a not in amap: amap[a]={"time":0,"books":0}
                amap[a]["time"]+=b["read_time"]; amap[a]["books"]+=1
        top_authors=sorted([{"author":k,"hours":round(v["time"]/3600.0,1),"books":v["books"]} for k,v in amap.items()],key=lambda x:x["hours"],reverse=True)[:10]

        books_out=[]
        for b in books:
            lo=(datetime.datetime.fromtimestamp(b["last_open"],tz=TZ_OFF).strftime('%Y-%m-%d %H:%M') if b["last_open"] else "N/A")
            wpm = round(b["speed"] * 300 / 60, 0) if b["speed"] > 0 else 0
            books_out.append({"id":b["id"],"title":b["title"],"author":b["author"],"pages":b["pages"],
                "read_pages":b["read_pages"],"progress":b["progress"],"time_hours":round(b["read_time"]/3600.0,1),
                "speed_pages_hour":b["speed"],"last_open":lo,"highlights":b["highlights"],"notes":b["notes"],
                "status":b["status"],"reading_days":reading_span.get(b["id"],0),"md5":b["md5"],
                "has_real_pages":b["has_real_pages"],"real_pages":b["real_pages"],
                "effective_pages":b["effective_pages"],"wpm":wpm})

        ms=cs=0
        if dates:
            tmp,streaks=1,[]
            for i in range(1,len(dates)):
                d=(dates[i]-dates[i-1]).days
                if d==1:tmp+=1
                elif d>1:streaks.append(tmp);tmp=1
            streaks.append(tmp); ms=max(streaks)
            yest=today-datetime.timedelta(days=1)
            if dates[-1]==today or dates[-1]==yest:
                cs=1
                for i in range(len(dates)-2,-1,-1):
                    if (dates[i+1]-dates[i]).days==1:cs+=1
                    else:break

        dsun=(today.weekday()+1)%7; wsun=today-datetime.timedelta(days=dsun)
        hm_start=wsun-datetime.timedelta(weeks=51); hm_end=wsun+datetime.timedelta(days=6)
        cells=[]; d=hm_start
        while d<=hm_end:
            ds=d.strftime("%Y-%m-%d")
            cells.append({"date":ds,"hours":hm_raw.get(ds,0.0),"future":d>today})
            d+=datetime.timedelta(days=1)

        ph,prof="N/A","Leitor Casual"
        if hourly:
            mh=max(hourly,key=lambda x:x["hours"])
            if mh["hours"]>0:
                hv=int(mh["hour"]); ph=f"{hv:02d}:00"
                if hv>=22 or hv<5:prof="Coruja Noturna"
                elif hv<11:prof="Madrugador"
                elif hv<14:prof="Leitor de Almoço"
                elif hv<18:prof="Leitor de Tarde"
                else:prof="Leitor Crepuscular"
        pd="N/A"
        if weekly:
            md=max(weekly,key=lambda x:x["hours"])
            if md["hours"]>0:pd=md["day"]

        def snap(b,ek,ev): return {"title":b["title"],"author":b["author"],ek:ev}
        lng=mt=fb=sb={"title":"N/A","author":"N/A"}
        if books:
            lb=max(books,key=lambda x:x["effective_pages"]); lng=snap(lb,"pages",lb["effective_pages"])
            mb=max(books,key=lambda x:x["read_time"]); mt=snap(mb,"hours",round(mb["read_time"]/3600.0,1))
            el=[b for b in books if b["read_pages"]>=50 and b["read_time"]>0]
            if el:
                fb2=max(el,key=lambda x:x["speed"]); fb=snap(fb2,"speed_pages_hour",fb2["speed"])
                sb2=min(el,key=lambda x:x["speed"]); sb=snap(sb2,"speed_pages_hour",sb2["speed"])

        def book_snap(b, extra_key, extra_val):
            return {"title":b["title"],"author":b["author"],extra_key:extra_val}

        top10_longest=sorted([book_snap(b,"pages",b["effective_pages"]) for b in books],key=lambda x:x["pages"],reverse=True)[:10]
        top10_most_time=sorted([book_snap(b,"hours",round(b["read_time"]/3600.0,1)) for b in books],key=lambda x:x["hours"],reverse=True)[:10]
        el=[b for b in books if b["read_pages"]>=50 and b["read_time"]>0]
        top10_fastest=sorted([book_snap(b,"speed_pages_hour",b["speed"]) for b in el],key=lambda x:x["speed_pages_hour"],reverse=True)[:10]
        top10_slowest=sorted([book_snap(b,"speed_pages_hour",b["speed"]) for b in el],key=lambda x:x["speed_pages_hour"])[:10]

        insights={"max_streak":ms,"current_streak":cs,"total_reading_days":len(dates),
            "longest_book":lng,"most_time_book":mt,"fastest_book":fb,"slowest_book":sb,
            "preferred_hour":ph,"preferred_dow":pd,"reader_profile":prof,
            "top10_longest":top10_longest,"top10_most_time":top10_most_time,
            "top10_fastest":top10_fastest,"top10_slowest":top10_slowest,
            "avg_wpm":avg_wpm,"wpm_profile":wpm_profile}

        result={
            "summary":summary,"insights":insights,
            "charts":{"monthly":monthly,"hourly":hourly,"weekly":weekly,"size_distribution":size_dist},
            "heatmap":cells,"top_authors":top_authors,"books":books_out,
            "filter_info":{
                "active": has_filter,
                "description": filter_desc,
                "total_after_filter": len(books_out),
            },
            "_mtime": os.stat(DB_PATH).st_mtime,
        }

        return result

    except Exception as e:
        import traceback; return {"error":str(e),"detail":traceback.format_exc()}


# ── HTTP Server ───────────────────────────────────────────────────────────

class Handler(BaseHTTPRequestHandler):
    def log_message(self,fmt,*args):
        if args and len(args)>=2 and str(args[1])[0] in("4","5"): super().log_message(fmt,*args)
    def send_json(self,data,status=200):
        body=json.dumps(data,ensure_ascii=False).encode("utf-8")
        try:
            self.send_response(status); self.send_header("Content-Type","application/json; charset=utf-8")
            self.send_header("Access-Control-Allow-Origin","*"); self.send_header("Cache-Control","no-store")
            self.send_header("Content-Length",str(len(body))); self.end_headers(); self.wfile.write(body)
        except (BrokenPipeError, ConnectionResetError, ConnectionAbortedError):
            pass
    def _respond_cached(self, data):
        body = json.dumps(data, ensure_ascii=False).encode("utf-8")
        etag = '"' + hashlib.md5(body).hexdigest() + '"'
        try:
            if self.headers.get("If-None-Match") == etag:
                self.send_response(304)
                self.send_header("Access-Control-Allow-Origin", "*")
                self.end_headers()
                return
            self.send_response(200)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Access-Control-Allow-Origin", "*")
            self.send_header("Cache-Control", "no-cache")
            self.send_header("ETag", etag)
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
        except (BrokenPipeError, ConnectionResetError, ConnectionAbortedError):
            pass
    def _read_json_body(self):
        length = int(self.headers.get("Content-Length", "0") or "0")
        raw = self.rfile.read(length) if length > 0 else b"{}"
        return json.loads(raw.decode("utf-8") or "{}")
    def do_GET(self):
        parsed=urllib.parse.urlparse(self.path)
        path=parsed.path
        qs=urllib.parse.parse_qs(parsed.query)

        if path=="/api/status":
            self.send_json(get_db_status()); return

        if path=="/api/settings":
            self.send_json(load_settings()); return

        if path=="/api/real-pages":
            self.send_json({"entries": get_all_real_pages()}); return

        if path=="/api/stats":
            filters_raw = qs.get("filters", [None])[0]
            cached = _check_stats_cache(filters_raw)
            if cached is not None:
                self._respond_cached(cached)
                return
            result = get_statistics(filters_raw)
            if "error" in result:
                self.send_json(result)
                return
            _save_stats_cache(filters_raw, result)
            self._respond_cached(result)
            return

        fp="web/index.html" if path=="/" else os.path.normpath(os.path.join("web",path.lstrip("/")))
        if not (fp.startswith("web"+os.sep) or fp=="web"): self.send_error(403); return
        if os.path.isfile(fp):
            _,ext=os.path.splitext(fp); ct=MIME.get(ext.lower(),"application/octet-stream")
            try:
                with open(fp,"rb") as f: content=f.read()
                self.send_response(200); self.send_header("Content-Type",ct)
                self.send_header("Cache-Control","max-age=30"); self.send_header("Content-Length",str(len(content)))
                self.end_headers(); self.wfile.write(content)
            except Exception as e: self.send_error(500,str(e))
        else: self.send_error(404)
    def do_POST(self):
        parsed=urllib.parse.urlparse(self.path)
        if parsed.path == "/api/real-pages/search":
            try:
                body = self._read_json_body()
                title = body.get("title", "").strip()
                author = body.get("author", "").strip()
                if not title:
                    self.send_json({"error": "title is required"}, status=400); return
                query = f"{title} {author}" if author else title
                results = hardcover.search_editions(query)
                self.send_json({"results": results})
            except Exception as e:
                self.send_json({"error": str(e)}, status=500)
            return

        if parsed.path == "/api/real-pages/save":
            try:
                body = self._read_json_body()
                md5 = body.get("md5", "").strip()
                pages = body.get("pages")
                if not md5 or pages is None:
                    self.send_json({"error": "md5 and pages are required"}, status=400); return
                ok = save_real_page(
                    md5=md5,
                    pages=int(pages),
                    title=body.get("title", ""),
                    author=body.get("author", ""),
                    edition_id=body.get("edition_id", ""),
                    book_id=body.get("book_id", ""),
                )
                if ok:
                    _clear_stats_cache()
                self.send_json({"ok": ok})
            except Exception as e:
                self.send_json({"error": str(e)}, status=500)
            return

        if parsed.path == "/api/real-pages/delete":
            try:
                body = self._read_json_body()
                md5 = body.get("md5", "").strip()
                if not md5:
                    self.send_json({"error": "md5 is required"}, status=400); return
                ok = delete_real_page(md5)
                if ok:
                    _clear_stats_cache()
                self.send_json({"ok": ok})
            except Exception as e:
                self.send_json({"error": str(e)}, status=500)
            return

        if parsed.path != "/api/settings":
            self.send_error(404)
            return
        try:
            incoming = self._read_json_body()
        except Exception as exc:
            self.send_json({"error": f"JSON inválido: {exc}"}, status=400)
            return

        current = load_settings()
        current.update(incoming if isinstance(incoming, dict) else {})
        normalized = _normalize_settings(current)
        try:
            save_settings(normalized)
        except Exception as exc:
            self.send_json({"error": f"Falha ao salvar settings: {exc}"}, status=500)
            return
        self.send_json(normalized)

def run():
    init_real_pages_db()
    print(f"{'─'*52}\n  KOReader Estante · http://localhost:{PORT}")
    print(f"  DB: {os.path.abspath(DB_PATH)}")
    print(f"  Status: {'✓ Disponível' if os.path.exists(DB_PATH) else '⚠ Não encontrado'}\n{'─'*52}")
    srv=ThreadingHTTPServer((HOST,PORT),Handler)
    try: srv.serve_forever()
    except KeyboardInterrupt: print("\nEncerrado."); sys.exit(0)

if __name__=="__main__": run()

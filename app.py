#!/usr/bin/env python3
"""KOReader Estante - Backend"""
import os, sys, json, sqlite3, datetime, urllib.parse
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

DB_PATH = os.environ.get("DB_PATH", "statistics.sqlite3")
PORT    = int(os.environ.get("PORT", "8080"))
HOST    = "0.0.0.0"
TZ_H    = int(os.environ.get("TZ_OFFSET_HOURS", "-3"))
TZ_OFF  = datetime.timezone(datetime.timedelta(hours=TZ_H))
TZ_SQL  = f"+{TZ_H:02d}:00" if TZ_H >= 0 else f"-{abs(TZ_H):02d}:00"

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
    # Insert before GROUP BY if present (must be checked before ORDER BY
    # since GROUP BY logically comes before ORDER BY in SQL)
    if "GROUP BY" in sql:
        return sql.replace("GROUP BY", f"{insert} GROUP BY", 1)
    # Insert before ORDER BY if present
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
            books.append({"id":r[0],"title":r[1] or "Sem Título","author":fmt_author(r[2]),
                "pages":r[3] or 1,"read_pages":r[4] or 0,"read_time":r[5] or 0,
                "last_open":r[6] or 0,"highlights":r[7] or 0,"notes":r[8] or 0,"md5":md5})

        mx=max((b["last_open"] for b in books),default=0)
        books=[b for b in books if not ((b["read_pages"]<=5 or b["read_time"]<=300) and b["last_open"]<mx-7*86400)]

        for b in books:
            b["progress"]=round(min(100.0,b["read_pages"]/b["pages"]*100 if b["pages"]>0 else 0),1)
            b["speed"]=round(b["read_pages"]/(b["read_time"]/3600.0),1) if b["read_time"]>0 else 0.0

        # Page stats for status computation
        c.execute("SELECT id_book,MAX(page),MAX(total_pages) FROM page_stat_data GROUP BY id_book")
        pstats={r[0]:(r[1],r[2]) for r in c.fetchall()}

        for b in books:
            mp,stp=pstats.get(b["id"],(0,0))
            fin=(b["progress"]>=95 or ((mp/(stp or 1)>=0.95 or mp/(b["pages"] or 1)>=0.95) and b["progress"]>=50))
            b["status"]="finished" if fin else ("reading" if b["last_open"]>=mx-30*86400 else "abandoned")

        # ── 2. Apply user filters ───────────────────────────────────────
        books_before = len(books)
        books, filter_desc = _apply_book_filters(books, parsed_filters)
        # Only restrict page_stat_data queries if books were actually removed
        filter_actually_changed = len(books) != books_before

        included_ids = tuple(b["id"] for b in books)
        ids_param = included_ids if filter_actually_changed else None

        # Report whether filters are active (for the UI banner)
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

        # Streak & total reading days are always computed from ALL books
        c.execute(
            f"SELECT DISTINCT date(start_time,'unixepoch','{TZ_SQL}') "
            f"FROM page_stat_data WHERE start_time>0 ORDER BY 1")
        dates=[datetime.date.fromisoformat(r[0]) for r in c.fetchall()]

        q_daily = _filter_sql(
            f"SELECT date(start_time,'unixepoch','{TZ_SQL}') AS d,"
            f"ROUND(SUM(duration)/3600.0,3) FROM page_stat_data WHERE start_time>0 "
            f"GROUP BY d ORDER BY d",
            ids_param)
        c.execute(q_daily, params) if ids_param is not None else c.execute(q_daily)
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
        ts=sum(b["read_time"] for b in books); tp=sum(b["read_pages"] for b in books)
        th=sum(b["highlights"] for b in books); tn=sum(b["notes"] for b in books)
        spd=round(tp/(ts/3600.0),1) if ts>0 else 0.0
        d30=today-datetime.timedelta(days=30)
        days30=sum(1 for d in hm_raw if datetime.date.fromisoformat(d)>=d30)
        hrs30=round(sum(v for k,v in hm_raw.items() if datetime.date.fromisoformat(k)>=d30),1)

        sr=["<100","100–199","200–299","300–399","400–499","500–999","1000–1999","2000–2999","3000+"]; sc=[0]*9
        for b in books:
            p=b["pages"]
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

        summary={"total_books":len(books),"finished_books":nf,"reading_books":nr,"abandoned_books":na,
            "total_time_seconds":ts,"total_pages_read":tp,"total_highlights":th,"total_notes":tn,
            "avg_speed_pages_hour":spd,"avg_page_time_seconds":round(avg_pt,1),
            "days_read_30d":days30,"hours_30d":hrs30}

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
            books_out.append({"id":b["id"],"title":b["title"],"author":b["author"],"pages":b["pages"],
                "read_pages":b["read_pages"],"progress":b["progress"],"time_hours":round(b["read_time"]/3600.0,1),
                "speed_pages_hour":b["speed"],"last_open":lo,"highlights":b["highlights"],"notes":b["notes"],
                "status":b["status"],"reading_days":reading_span.get(b["id"],0)})

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
            lb=max(books,key=lambda x:x["pages"]); lng=snap(lb,"pages",lb["pages"])
            mb=max(books,key=lambda x:x["read_time"]); mt=snap(mb,"hours",round(mb["read_time"]/3600.0,1))
            el=[b for b in books if b["read_pages"]>=50 and b["read_time"]>0]
            if el:
                fb2=max(el,key=lambda x:x["speed"]); fb=snap(fb2,"speed_pages_hour",fb2["speed"])
                sb2=min(el,key=lambda x:x["speed"]); sb=snap(sb2,"speed_pages_hour",sb2["speed"])

        def book_snap(b, extra_key, extra_val):
            return {"title":b["title"],"author":b["author"],extra_key:extra_val}

        top10_longest=sorted([book_snap(b,"pages",b["pages"]) for b in books],key=lambda x:x["pages"],reverse=True)[:10]
        top10_most_time=sorted([book_snap(b,"hours",round(b["read_time"]/3600.0,1)) for b in books],key=lambda x:x["hours"],reverse=True)[:10]
        el=[b for b in books if b["read_pages"]>=50 and b["read_time"]>0]
        top10_fastest=sorted([book_snap(b,"speed_pages_hour",b["speed"]) for b in el],key=lambda x:x["speed_pages_hour"],reverse=True)[:10]
        top10_slowest=sorted([book_snap(b,"speed_pages_hour",b["speed"]) for b in el],key=lambda x:x["speed_pages_hour"])[:10]

        insights={"max_streak":ms,"current_streak":cs,"total_reading_days":len(dates),
            "longest_book":lng,"most_time_book":mt,"fastest_book":fb,"slowest_book":sb,
            "preferred_hour":ph,"preferred_dow":pd,"reader_profile":prof,
            "top10_longest":top10_longest,"top10_most_time":top10_most_time,
            "top10_fastest":top10_fastest,"top10_slowest":top10_slowest}

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
        self.send_response(status); self.send_header("Content-Type","application/json; charset=utf-8")
        self.send_header("Access-Control-Allow-Origin","*"); self.send_header("Cache-Control","no-store")
        self.send_header("Content-Length",str(len(body))); self.end_headers(); self.wfile.write(body)
    def do_GET(self):
        parsed=urllib.parse.urlparse(self.path)
        path=parsed.path
        qs=urllib.parse.parse_qs(parsed.query)

        if path=="/api/status":
            self.send_json(get_db_status()); return

        if path=="/api/stats":
            filters_raw = qs.get("filters", [None])[0]
            self.send_json(get_statistics(filters_raw)); return

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

def run():
    print(f"{'─'*52}\n  KOReader Estante · http://localhost:{PORT}")
    print(f"  DB: {os.path.abspath(DB_PATH)}")
    print(f"  Status: {'✓ Disponível' if os.path.exists(DB_PATH) else '⚠ Não encontrado'}\n{'─'*52}")
    srv=ThreadingHTTPServer((HOST,PORT),Handler)
    try: srv.serve_forever()
    except KeyboardInterrupt: print("\nEncerrado."); sys.exit(0)

if __name__=="__main__": run()

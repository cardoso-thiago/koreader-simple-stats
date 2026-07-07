import json, os, urllib.request, urllib.error

HARDCOVER_API_KEY = os.environ.get("HARDCOVER_API_KEY", "")
HARDCOVER_API_URL = "https://api.hardcover.app/v1/graphql"

def _log(msg):
    print(f"[hardcover] {msg}")

def _auth_header():
    k = HARDCOVER_API_KEY.strip()
    if not k:
        return ""
    if k.startswith("Bearer "):
        return k
    return f"Bearer {k}"

def has_key():
    return bool(_auth_header())

def _graphql_query(query, variables=None, label=""):
    if not has_key():
        _log(f"[{label}] no API key")
        return None
    headers = {
        "Content-Type": "application/json",
        "Authorization": _auth_header(),
    }
    body = json.dumps({"query": query, "variables": variables or {}}).encode("utf-8")
    req = urllib.request.Request(HARDCOVER_API_URL, data=body, headers=headers, method="POST")
    try:
        with urllib.request.urlopen(req, timeout=15) as resp:
            raw = resp.read().decode("utf-8")
            data = json.loads(raw)
            if data.get("errors"):
                _log(f"[{label}] GraphQL error: {data['errors'][0].get('message', 'unknown')}")
                return None
            return data.get("data")
    except urllib.error.HTTPError as e:
        _log(f"[{label}] HTTP {e.code}: {e.reason}")
        return None
    except urllib.error.URLError as e:
        _log(f"[{label}] connection error: {e.reason}")
        return None
    except (json.JSONDecodeError, OSError) as e:
        _log(f"[{label}] {type(e).__name__}: {e}")
        return None

SEARCH_IDS_QUERY = """
query SearchBookIds($query: String!, $perPage: Int!) {
  search(query: $query, query_type: "Book", per_page: $perPage, page: 1) { ids }
}
"""

BOOKS_WITH_EDITIONS_QUERY = """
query BooksByIds($ids: [Int!]!, $limit: Int!) {
  books(where: { id: { _in: $ids } }, limit: $limit, order_by: { users_count: desc_nulls_last }) {
    id
    title
    contributions(limit: 3) {
      author { name }
    }
    editions(limit: 20, order_by: { users_read_count: desc_nulls_last }) {
      id
      title
      edition_format
      pages
      isbn_13
      isbn_10
      language { language }
    }
  }
}
"""

def search_editions(title, per_page=8):
    if not has_key() or not title:
        return []

    search_data = _graphql_query(SEARCH_IDS_QUERY, {"query": title, "perPage": per_page}, label="search")
    if not search_data:
        return []

    ids = search_data.get("search", {}).get("ids", [])
    if not ids:
        return []

    books_data = _graphql_query(BOOKS_WITH_EDITIONS_QUERY, {"ids": ids, "limit": per_page}, label="books")
    if not books_data:
        return []

    books = books_data.get("books", [])
    result = []
    for book in books:
        editions = []
        for ed in (book.get("editions") or []):
            lang = ed.get("language", {}) or {}
            editions.append({
                "id": str(ed["id"]),
                "title": ed.get("title") or book.get("title") or "",
                "format": ed.get("edition_format") or "",
                "pages": ed.get("pages"),
                "isbn_13": ed.get("isbn_13") or "",
                "isbn_10": ed.get("isbn_10") or "",
                "language": (lang.get("language") if isinstance(lang, dict) else lang) or "",
            })

        if editions:
            authors = []
            for c in (book.get("contributions") or []):
                author = c.get("author") or {}
                if author.get("name"):
                    authors.append(author["name"])
            result.append({
                "book_id": str(book["id"]),
                "book_title": book.get("title") or "",
                "authors": authors,
                "editions": editions,
            })

    return result

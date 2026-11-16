"""
convertibility.py - server-side check: can <source language> be converted to <target language>?

Usage:
    from convertibility import check_convertible
    error = check_convertible("Python", "SQL")
    if error:
        ...  # show the error, do not call the AI
    # error is None  ->  convertible (or unknown), carry on as normal

It returns None when everything is fine ("returns nothing"), otherwise a
short human-readable error string.
"""

# --- 1. Known languages, grouped by what KIND of language they are -------------

# Normal programming languages: can be translated between each other.
GENERAL = {
    "python", "java", "c", "c++", "c#", "javascript", "typescript", "go", "rust",
    "php", "swift", "kotlin", "ruby", "scala", "dart", "r", "lua", "perl",
    "haskell", "matlab", "objective-c", "bash", "powershell", "julia", "groovy",
    "elixir", "clojure", "f#", "visual basic", "cobol", "fortran", "pascal",
}

# SQL and its dialects: declarative query languages (no loops, classes, etc.).
SQL = {"sql", "mysql", "postgresql", "sqlite", "t-sql", "pl/sql"}

# Data / config formats: can only be converted between each other.
DATA = {"json", "yaml", "xml", "toml"}

# Markup / styling: describe documents, they are not programs.
MARKUP = {"html", "css", "markdown"}

# Hardware description languages: describe circuits, not software.
HDL = {"verilog", "vhdl"}

# Short names people may type  ->  the canonical name used above.
ALIASES = {
    "py": "python", "python3": "python",
    "js": "javascript", "node": "javascript", "nodejs": "javascript", "node.js": "javascript",
    "ts": "typescript",
    "cpp": "c++", "cplusplus": "c++",
    "csharp": "c#", "c sharp": "c#", "cs": "c#",
    "golang": "go",
    "rs": "rust",
    "rb": "ruby",
    "kt": "kotlin",
    "objectivec": "objective-c", "objc": "objective-c",
    "sh": "bash", "shell": "bash", "zsh": "bash",
    "ps1": "powershell",
    "fsharp": "f#",
    "vb": "visual basic", "vb.net": "visual basic", "vbnet": "visual basic",
    "postgres": "postgresql", "psql": "postgresql",
    "tsql": "t-sql", "transact-sql": "t-sql", "mssql": "t-sql", "sql server": "t-sql",
    "plsql": "pl/sql", "oracle sql": "pl/sql",
    "yml": "yaml",
    "md": "markdown",
    "html5": "html", "css3": "css",
}

PAIR_REASONS = {}  # optional: add ("python", "cobol"): "reason" for special cases


def normalize(name):
    """'  Python 3 ' -> 'python'.  Unknown names are just lower-cased."""
    key = (name or "").strip().lower()
    key = " ".join(key.split())
    if key.startswith("python "):
        key = "python"
    return ALIASES.get(key, key)


def _group(lang):
    if lang in GENERAL:
        return "general"
    if lang in SQL:
        return "sql"
    if lang in DATA:
        return "data"
    if lang in MARKUP:
        return "markup"
    if lang in HDL:
        return "hdl"
    return None  # unknown language


_KIND_TEXT = {
    "general": "a programming language",
    "sql": "a database query language",
    "data": "a data format",
    "markup": "a markup/styling language",
    "hdl": "a hardware description language",
}

_WHY = {
    ("general", "sql"): "SQL only describes database queries, so program logic such as loops, classes and functions has no SQL equivalent.",
    ("sql", "general"): "SQL queries describe data, not a complete program, so they cannot be turned into a program in this way.",
    ("general", "data"): "Data formats only store values; they cannot hold program logic.",
    ("data", "general"): "A data file holds values, not logic, so there is no program to produce.",
    ("general", "markup"): "Markup/styling languages describe documents, not program logic.",
    ("markup", "general"): "Markup/styling languages describe documents, not program logic.",
    ("general", "hdl"): "Hardware description languages describe circuits, not sequential software.",
    ("hdl", "general"): "Hardware description languages describe circuits, not sequential software.",
}


def check_convertible(source_language, target_language):
    """
    Returns None if the conversion is possible (or cannot be judged),
    otherwise a string explaining why the code cannot be converted.
    """
    src = normalize(source_language)
    dst = normalize(target_language)

    # Nothing chosen -> let the normal flow handle it.
    if not src or not dst:
        return None

    # 1) Converting a language to itself is pointless.
    if src == dst:
        return f"Cannot convert: source and target are both {target_language.strip()}. Please choose a different target language."

    # 2) Explicit special cases.
    reason = PAIR_REASONS.get((src, dst))
    if reason:
        return f"Cannot convert {source_language.strip()} to {target_language.strip()}. {reason}"

    src_group, dst_group = _group(src), _group(dst)

    # 3) A language we do not know about: we cannot judge, so let the AI decide.
    if src_group is None or dst_group is None:
        return None

    # 4) Same kind of language -> convertible
    #    (general<->general, SQL dialect<->dialect, json<->yaml, ...).
    #    Markup and HDL only convert to themselves, so they fall through below.
    if src_group == dst_group and src_group in ("general", "sql", "data"):
        return None

    # 5) HTML <-> Markdown is a normal conversion.
    if {src, dst} == {"html", "markdown"}:
        return None

    # 6) Everything else is a mismatch of kinds.
    why = _WHY.get((src_group, dst_group), "These two languages do not have equivalent features.")
    return (
        f"Cannot convert {source_language.strip()} ({_KIND_TEXT[src_group]}) to "
        f"{target_language.strip()} ({_KIND_TEXT[dst_group]}). {why}"
    )
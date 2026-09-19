#!/usr/bin/env python3
"""Dump Enshido from SOURCE DATABASE_URL (public) into DEST schema enshido.

Usage:
  DEST_DATABASE_URL='postgresql://...' python3 scripts/copy-public-to-enshido.py
"""
from __future__ import annotations

import os
import re
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
ENV_FILE = Path(os.environ.get("ENV_FILE", ROOT / ".env"))
DUMP = Path(os.environ.get("DUMP", "/tmp/enshido-public.dump.sql"))
DEST_SCHEMA = os.environ.get("DEST_SCHEMA", "enshido")
IMAGE = os.environ.get("PG_IMAGE", "postgres:17-alpine")


def load_env(path: Path) -> dict[str, str]:
    out: dict[str, str] = {}
    if not path.is_file():
        raise SystemExit(f"Missing {path}")
    for raw in path.read_text().splitlines():
        line = raw.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        value = value.strip()
        if len(value) >= 2 and value[0] == value[-1] and value[0] in {'"', "'"}:
            value = value[1:-1]
        out[key.strip()] = value
    return out


def strip_prisma_query(url: str) -> str:
    """pg_dump/psql do not understand Prisma's schema= query param."""
    if "?" not in url:
        return url
    base, query = url.split("?", 1)
    keep = []
    for part in query.split("&"):
        key = part.split("=", 1)[0].lower()
        if key in {"schema", "pgbouncer", "connection_limit", "pool_timeout", "connect_timeout"}:
            continue
        keep.append(part)
    return f"{base}?{'&'.join(keep)}" if keep else base


def docker_pg(url: str, args: list[str], stdin: str | None = None) -> str:
    cmd = [
        "docker",
        "run",
        "--rm",
        "-i",
        "-e",
        "PGSSLMODE=require",
        IMAGE,
        *args,
        url,
    ]
    result = subprocess.run(
        cmd,
        input=stdin,
        text=True,
        capture_output=True,
    )
    if result.returncode != 0:
        sys.stderr.write(result.stderr)
        raise SystemExit(result.returncode)
    return result.stdout


def list_tables(url: str, schema: str) -> str:
    sql = f"""
SELECT n.nspname AS schema, c.relname AS table, c.reltuples::bigint AS est_rows
FROM pg_class c
JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = '{schema}' AND c.relkind = 'r'
ORDER BY 2;
"""
    return docker_pg(url, ["psql", "-v", "ON_ERROR_STOP=1", "-c", sql.strip()])


def rewrite_public_to_schema(sql: str, schema: str) -> str:
    sql = re.sub(r"^CREATE SCHEMA public;.*\n", f"CREATE SCHEMA IF NOT EXISTS {schema};\n", sql, flags=re.M)
    sql = re.sub(r"^ALTER SCHEMA public .*\n", "", sql, flags=re.M)
    sql = re.sub(r"^DROP SCHEMA IF EXISTS public CASCADE;.*\n", "", sql, flags=re.M)
    sql = re.sub(r"^SET search_path = public.*$", f"SET search_path = {schema}, public;", sql, flags=re.M)
    return sql.replace("public.", f"{schema}.")


def main() -> None:
    env = load_env(ENV_FILE)
    source = strip_prisma_query(
        os.environ.get("SOURCE_DATABASE_URL")
        or env.get("DIRECT_URL")
        or env.get("DATABASE_URL")
        or ""
    )
    dest = strip_prisma_query(os.environ.get("DEST_DATABASE_URL", ""))
    if not source:
        raise SystemExit("SOURCE DATABASE_URL is empty")

    print("==> Source public tables")
    print(list_tables(source, "public"))

    print(f"==> Dumping source public schema -> {DUMP}")
    dump_sql = docker_pg(
        source,
        [
            "pg_dump",
            "--schema=public",
            "--no-owner",
            "--no-acl",
            "--no-comments",
            "--format=plain",
        ],
    )
    DUMP.write_text(dump_sql)
    print(f"==> Dump size: {DUMP.stat().st_size} bytes")

    if not dest:
        print()
        print("Dump xong. Chưa restore vì thiếu DEST_DATABASE_URL (connection string CQA_HRM).")
        print("Chạy lại:")
        print(
            "  DEST_DATABASE_URL='postgresql://USER:PASS@HOST:5432/postgres?sslmode=require' "
            "python3 scripts/copy-public-to-enshido.py"
        )
        return

    rewritten = Path(str(DUMP) + f".{DEST_SCHEMA}.sql")
    print(f"==> Rewriting public. -> {DEST_SCHEMA}.")
    rewritten.write_text(rewrite_public_to_schema(dump_sql, DEST_SCHEMA))

    print(f"==> Creating schema {DEST_SCHEMA} on dest")
    docker_pg(dest, ["psql", "-v", "ON_ERROR_STOP=1"], stdin=f"CREATE SCHEMA IF NOT EXISTS {DEST_SCHEMA};\n")

    print(f"==> Restoring into dest schema {DEST_SCHEMA}")
    docker_pg(dest, ["psql", "-v", "ON_ERROR_STOP=1"], stdin=rewritten.read_text())

    print(f"==> Dest tables in {DEST_SCHEMA}")
    print(list_tables(dest, DEST_SCHEMA))
    print(f"Done. Point Enshido DATABASE_URL at dest with schema={DEST_SCHEMA}")


if __name__ == "__main__":
    main()

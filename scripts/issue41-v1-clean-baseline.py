#!/usr/bin/env python3
"""Create an isolated Issue #41 Local Supabase baseline on the Mac host.

Run from the repository root. This script never stops, resets, or removes an
existing container. On failure, it leaves the backup, logs, and new instance
in place for diagnosis.
"""

import hashlib
import json
import os
from pathlib import Path
import re
import secrets
import shutil
import socket
import subprocess
import sys
import tempfile
import urllib.error
import urllib.request

try:
    import tomllib  # Python 3.11+
except ModuleNotFoundError:
    try:
        import tomli as tomllib
    except ModuleNotFoundError:
        try:
            from pip._vendor import tomli as tomllib  # Python 3.10 with pip
        except ImportError:
            raise SystemExit("TOML parser unavailable: install tomli for Python 3.10.")


REPO = Path(__file__).resolve().parent.parent
SOURCE = REPO / "supabase"
ORIGINAL_DB = "supabase_db_live-translate"
PORTS = {
    "api": 56421,
    "db": 56422,
    "studio": 56423,
    "local_smtp": 56424,
    "db.pooler": 56427,
    "analytics": 56428,
}
REDIS_PORT = 16389


def run(args, *, input_file=None, output_file=None, check=True):
    return subprocess.run(
        args, cwd=REPO, stdin=input_file, stdout=output_file or subprocess.PIPE,
        stderr=subprocess.PIPE, check=check, text=False,
    )


def check_local_docker():
    context = run(["docker", "context", "show"]).stdout.decode().strip()
    endpoint = json.loads(run([
        "docker", "context", "inspect", context, "--format",
        "{{json .Endpoints.docker.Host}}",
    ]).stdout)
    if not endpoint.startswith("unix://") or not Path(endpoint[7:]).is_socket():
        raise RuntimeError("Docker context must use an existing local Unix socket.")
    if os.environ.get("DOCKER_HOST") or os.environ.get("DOCKER_CONTEXT"):
        raise RuntimeError("Unset DOCKER_HOST and DOCKER_CONTEXT before running.")
    run(["docker", "info", "--format", "{{.ServerVersion}}"])
    details = json.loads(run(["docker", "inspect", ORIGINAL_DB]).stdout)[0]
    if details["Name"] != "/" + ORIGINAL_DB or not details["State"]["Running"]:
        raise RuntimeError("Original Local DB container identity/state differs.")
    count = run([
        "docker", "exec", ORIGINAL_DB, "psql", "-U", "postgres", "-d", "postgres",
        "-Atqc", "select count(*) from supabase_migrations.schema_migrations",
    ]).stdout.decode().strip()
    if count != "41":
        raise RuntimeError("Original Local DB migration count is not the confirmed 41.")


def check_ports():
    for port in [*PORTS.values(), REDIS_PORT, 3000, 5173]:
        for family, address in ((socket.AF_INET, "127.0.0.1"), (socket.AF_INET6, "::1")):
            with socket.socket(family, socket.SOCK_STREAM) as sock:
                try:
                    sock.bind((address, port))
                except OSError as error:
                    if family == socket.AF_INET6 and error.errno in (47, 97):
                        continue  # IPv6 disabled on this host.
                    raise RuntimeError("Port {} unavailable on {}.".format(port, address)) from error


def migration_files():
    files = sorted((SOURCE / "migrations").glob("*.sql"))
    versions = [path.name[:14] for path in files]
    if len(files) != 53 or len(set(versions)) != 53 or any(
        not re.fullmatch(r"\d{14}_.+\.sql", path.name) for path in files
    ):
        raise RuntimeError("Repository migration inventory is not 53 unique versions.")
    return files, versions


def set_port(config, section, port):
    header = re.compile(r"(?m)^\[" + re.escape(section) + r"\]\s*$")
    matches = list(header.finditer(config))
    if len(matches) > 1:
        raise RuntimeError("Duplicate TOML section: " + section)
    if not matches:
        return config.rstrip() + "\n\n[{}]\nport = {}\n".format(section, port)
    start = matches[0].end()
    next_header = re.search(r"(?m)^\[", config[start:])
    end = start + next_header.start() if next_header else len(config)
    body = config[start:end]
    port_pattern = re.compile(r"(?m)^port\s*=.*$")
    if len(port_pattern.findall(body)) > 1:
        raise RuntimeError("Duplicate port key: " + section)
    if port_pattern.search(body):
        body = port_pattern.sub("port = {}".format(port), body)
    else:
        body = "\nport = {}".format(port) + body
    return config[:start] + body + config[end:]


def isolated_config(project_id):
    original = (SOURCE / "config.toml").read_text()
    parsed = tomllib.loads(original)
    if parsed.get("project_id") != "live-translate":
        raise RuntimeError("Original config project_id differs from expected Local project.")
    config, replaced = re.subn(
        r'(?m)^project_id\s*=\s*"live-translate"\s*$',
        'project_id = "{}"'.format(project_id), original,
    )
    if replaced != 1:
        raise RuntimeError("Cannot uniquely replace project_id in copied config.")
    for section, port in PORTS.items():
        config = set_port(config, section, port)
    updated = tomllib.loads(config)
    if updated["project_id"] != project_id:
        raise RuntimeError("Isolated TOML validation failed.")
    for section, port in PORTS.items():
        value = updated
        for part in section.split("."):
            value = value[part]
        if value["port"] != port:
            raise RuntimeError("Isolated TOML port validation failed: " + section)
    if tomllib.loads(original) != parsed:
        raise RuntimeError("Original config changed during preparation.")
    return config


def backup(root):
    destination = root / "backup" / "original-local-db.dump"
    destination.parent.mkdir(mode=0o700)
    with destination.open("xb") as output:
        os.chmod(destination, 0o600)
        run(["docker", "exec", ORIGINAL_DB, "pg_dump", "-U", "postgres",
             "-d", "postgres", "-Fc"], output_file=output)
    if destination.stat().st_size == 0:
        raise RuntimeError("Backup is empty.")
    with destination.open("rb") as source:
        run(["docker", "exec", "-i", ORIGINAL_DB, "pg_restore", "--list"],
            input_file=source, output_file=subprocess.DEVNULL)
    return destination


def require_http(url, headers=None):
    request = urllib.request.Request(url, headers=headers or {})
    try:
        with urllib.request.urlopen(request, timeout=8) as response:
            if response.status != 200:
                raise RuntimeError("Local endpoint returned HTTP {}: {}".format(response.status, url))
    except urllib.error.HTTPError as error:
        raise RuntimeError("Local endpoint returned HTTP {}: {}".format(error.code, url)) from error


def main():
    os.umask(0o077)
    check_local_docker()
    check_ports()
    files, versions = migration_files()
    project_id = "issue41-v1-" + secrets.token_hex(4)
    root = Path(tempfile.gettempdir()) / project_id
    db_container = "supabase_db_" + project_id
    if run(["docker", "inspect", db_container], check=False).returncode == 0:
        raise RuntimeError("New project ID already has a Docker DB container.")
    config = isolated_config(project_id)
    root.mkdir(mode=0o700)
    print("Isolated project:", project_id, flush=True)
    print("Diagnostic directory:", root, flush=True)
    backup_path = backup(root)
    print("Backup verified:", backup_path, flush=True)

    target = root / "supabase"
    target.mkdir(mode=0o700)
    (target / "config.toml").write_text(config)
    shutil.copytree(SOURCE / "migrations", target / "migrations")
    for source in files:
        copied = target / "migrations" / source.name
        if hashlib.sha256(source.read_bytes()).digest() != hashlib.sha256(copied.read_bytes()).digest():
            raise RuntimeError("Migration copy differs: " + source.name)

    redis_args = [
        "redis-server", "--bind", "127.0.0.1", "--port", str(REDIS_PORT),
        "--save", "", "--appendonly", "no", "--daemonize", "yes",
        "--pidfile", str(root / "redis.pid"), "--logfile", str(root / "redis.log"),
    ]
    run(redis_args)
    if run(["redis-cli", "-h", "127.0.0.1", "-p", str(REDIS_PORT), "PING"]).stdout.strip() != b"PONG":
        raise RuntimeError("Isolated Redis did not answer PING.")
    print("Isolated Redis ready on 127.0.0.1:{}".format(REDIS_PORT), flush=True)

    log = root / "supabase-start.log"
    with log.open("xb") as output:
        os.chmod(log, 0o600)
        # CLI output may contain credentials; keep all of it in the private log.
        result = subprocess.run(
            ["supabase", "start", "--workdir", str(root), "--yes"],
            cwd=REPO, stdout=output, stderr=subprocess.STDOUT, check=False,
        )
    if result.returncode:
        raise RuntimeError("Supabase start/migration failed. Inspect private log: " + str(log))
    if run(["docker", "inspect", db_container], check=False).returncode:
        raise RuntimeError("Expected isolated DB container was not created.")
    applied = run([
        "docker", "exec", db_container, "psql", "-U", "postgres", "-d", "postgres",
        "-Atqc", "select version from supabase_migrations.schema_migrations order by version",
    ]).stdout.decode().splitlines()
    if applied != versions:
        (root / "expected-versions.txt").write_text("\n".join(versions) + "\n")
        (root / "applied-versions.txt").write_text("\n".join(applied) + "\n")
        raise RuntimeError("Migration history mismatch; inspect version lists in " + str(root))
    print("Migration history: 53/53 exact match", flush=True)
    run(["docker", "exec", db_container, "psql", "-U", "postgres", "-d", "postgres",
         "-Atqc", "select 1"])
    status = json.loads(run(["supabase", "status", "-o", "json", "--workdir", str(root)]).stdout)
    api_url = status["API_URL"].rstrip("/")
    from urllib.parse import urlparse
    parsed_url = urlparse(api_url)
    if parsed_url.scheme != "http" or parsed_url.hostname not in ("127.0.0.1", "localhost", "::1") or parsed_url.port != PORTS["api"]:
        raise RuntimeError("Supabase status returned a non-isolated API target.")
    require_http(api_url + "/auth/v1/health")
    headers = {"apikey": status["ANON_KEY"], "Authorization": "Bearer " + status["ANON_KEY"]}
    require_http(api_url + "/rest/v1/", headers)
    require_http(api_url + "/storage/v1/status", headers)
    print("Isolated DB, Auth, REST, Storage: healthy", flush=True)

    env = os.environ.copy()
    env.update({
        "LOCAL_SUPABASE_WORKDIR": str(root),
        "LOCAL_REDIS_URL": "redis://127.0.0.1:{}".format(REDIS_PORT),
        "AUTH_ALLOWED_EMAIL_DOMAINS": env.get("AUTH_ALLOWED_EMAIL_DOMAINS") or "example.com",
    })
    result = subprocess.run(["npm", "run", "start:local", "--", "--check"],
                            cwd=REPO, env=env, check=False)
    if result.returncode:
        raise RuntimeError("start:local --check failed; isolated instance remains for diagnosis.")
    print("start:local --check: PASS", flush=True)
    print("Launch in this Mac Terminal:", flush=True)
    print("LOCAL_SUPABASE_WORKDIR={} LOCAL_REDIS_URL=redis://127.0.0.1:{} AUTH_ALLOWED_EMAIL_DOMAINS=example.com npm run start:local".format(
        root, REDIS_PORT), flush=True)
    print("Keep the private backup and log; no existing Local container was changed.", flush=True)


if __name__ == "__main__":
    try:
        main()
    except (RuntimeError, OSError, subprocess.CalledProcessError, KeyError, ValueError) as error:
        # Never echo subprocess stderr: CLI diagnostics can contain credentials.
        print("BLOCKED:", error if not isinstance(error, subprocess.CalledProcessError)
              else "Command failed: " + " ".join(error.cmd[:2]), file=sys.stderr)
        sys.exit(1)

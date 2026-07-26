#!/usr/bin/env bash

set -Eeuo pipefail

random_secret() {
  od -An -N32 -tx1 /dev/urandom | tr -d ' \n'
}

validate_existing_config() {
  local key count
  [ -f "$DATABENCH_CONFIG_FILE" ] || die "configuration is missing: $DATABENCH_CONFIG_FILE"
  for key in POSTGRES_USER POSTGRES_PASSWORD POSTGRES_DB DATABASE_URL MINIO_ROOT_USER \
    MINIO_ROOT_PASSWORD S3_ENDPOINT S3_REGION S3_BUCKET S3_ACCESS_KEY_ID \
    S3_SECRET_ACCESS_KEY S3_FORCE_PATH_STYLE DATABENCH_OBJECT_STORE DATABENCH_ROOT \
    DATABENCH_V2_CURSOR_SECRET PORT; do
    count="$(grep -Ec "^${key}=.+" "$DATABENCH_CONFIG_FILE" || true)"
    [ "$count" -eq 1 ] || die "configuration must contain exactly one non-empty $key"
  done
  [ "$(stat -c '%a' "$DATABENCH_CONFIG_FILE")" = '600' ] ||
    die "configuration permissions must be 0600: $DATABENCH_CONFIG_FILE"
}

validate_mcp_public_base_url() {
  local value="$1" label="${2:-DATABENCH_MCP_PUBLIC_BASE_URL}" scheme authority host port
  local octet dns_label
  local -a labels octets
  [ "$value" != *'\'* ] ||
    die "$label must not contain a backslash"
  [[ "$value" =~ ^(https?)://([^/?#@[:space:]]+)/api$ ]] ||
    die "$label must be an agent-reachable http(s)://DNS-or-IPv4[:port]/api URL without credentials, query, fragment, or trailing slash"
  scheme="${BASH_REMATCH[1]}"
  authority="${BASH_REMATCH[2]}"
  if [[ "$authority" =~ ^([^:]+):([0-9]+)$ ]]; then
    host="${BASH_REMATCH[1]}"
    port="${BASH_REMATCH[2]}"
    [[ "$port" =~ ^(0|[1-9][0-9]*)$ ]] ||
      die "$label port must use canonical decimal form"
    [ "${#port}" -le 5 ] && [ "$((10#$port))" -ge 1 ] &&
      [ "$((10#$port))" -le 65535 ] ||
      die "$label port must be between 1 and 65535"
    if { [ "$scheme" = 'http' ] && [ "$port" = '80' ]; } ||
      { [ "$scheme" = 'https' ] && [ "$port" = '443' ]; }; then
      die "$label must omit the default HTTP(S) port"
    fi
  else
    [ "$authority" != *:* ] ||
      die "$label authority must use DNS or IPv4 with an optional numeric port"
    host="$authority"
  fi

  if [[ "$host" =~ ^[0-9.]+$ ]]; then
    IFS=. read -r -a octets <<< "$host"
    [ "${#octets[@]}" -eq 4 ] ||
      die "$label contains an invalid IPv4 address"
    for octet in "${octets[@]}"; do
      [[ "$octet" =~ ^(0|[1-9][0-9]{0,2})$ ]] && [ "$((10#$octet))" -le 255 ] ||
        die "$label contains an invalid IPv4 address"
    done
    return
  fi

  case "$host" in
    *[A-Z]*) die "$label DNS name must be lowercase" ;;
  esac
  [ "${#host}" -le 253 ] || die "$label DNS name is too long"
  IFS=. read -r -a labels <<< "$host"
  for dns_label in "${labels[@]}"; do
    [ "${#dns_label}" -le 63 ] &&
      [[ "$dns_label" =~ ^[A-Za-z0-9]([A-Za-z0-9-]*[A-Za-z0-9])?$ ]] &&
      [[ ! "$dns_label" =~ ^0[xX][0-9A-Fa-f]+$ ]] ||
      die "$label contains an invalid DNS name"
  done
}

validate_mcp_origins() {
  local value="$1" entry trimmed scheme authority port
  local -a entries=()
  [ "$value" != *$'\n'* ] && [ "$value" != *$'\r'* ] ||
    die "DATABENCH_MCP_ORIGINS must be a single line"
  [ -n "$value" ] || return 0
  IFS=, read -r -a entries <<< "$value"
  for entry in "${entries[@]}"; do
    trimmed="${entry#"${entry%%[![:space:]]*}"}"
    trimmed="${trimmed%"${trimmed##*[![:space:]]}"}"
    [ -n "$trimmed" ] || continue
    case "$trimmed" in
      *[A-Z]*) die "DATABENCH_MCP_ORIGINS entries must be exact lowercase HTTP(S) origins" ;;
    esac
    [[ "$trimmed" =~ ^(https?)://([^/?#@[:space:]]+)$ ]] ||
      die "DATABENCH_MCP_ORIGINS entries must be exact lowercase HTTP(S) origins"
    scheme="${BASH_REMATCH[1]}"
    authority="${BASH_REMATCH[2]}"
    if [[ "$authority" =~ :([0-9]+)$ ]]; then
      port="${BASH_REMATCH[1]}"
      [[ "$port" =~ ^(0|[1-9][0-9]*)$ ]] ||
        die "DATABENCH_MCP_ORIGINS ports must use canonical decimal form"
      if { [ "$scheme" = 'http' ] && [ "$port" = '80' ]; } ||
        { [ "$scheme" = 'https' ] && [ "$port" = '443' ]; }; then
        die "DATABENCH_MCP_ORIGINS entries must omit default ports"
      fi
    fi
    validate_mcp_public_base_url "${trimmed}/api" 'DATABENCH_MCP_ORIGINS entry'
  done
}

validate_mcp_config() {
  local key count enabled auth_mode public_base origins
  [ -f "$DATABENCH_MCP_CONFIG_FILE" ] ||
    die "MCP configuration is missing: $DATABENCH_MCP_CONFIG_FILE"
  for key in DATABENCH_MCP_ENABLED DATABENCH_MCP_AUTH_MODE \
    DATABENCH_MCP_PUBLIC_BASE_URL DATABENCH_MCP_ORIGINS; do
    count="$(grep -Ec "^${key}=" "$DATABENCH_MCP_CONFIG_FILE" || true)"
    [ "$count" -eq 1 ] || die "MCP configuration must contain exactly one $key"
  done
  enabled="$(grep -E '^DATABENCH_MCP_ENABLED=' "$DATABENCH_MCP_CONFIG_FILE" | cut -d= -f2-)"
  auth_mode="$(grep -E '^DATABENCH_MCP_AUTH_MODE=' "$DATABENCH_MCP_CONFIG_FILE" | cut -d= -f2-)"
  public_base="$(grep -E '^DATABENCH_MCP_PUBLIC_BASE_URL=' "$DATABENCH_MCP_CONFIG_FILE" | cut -d= -f2-)"
  origins="$(grep -E '^DATABENCH_MCP_ORIGINS=' "$DATABENCH_MCP_CONFIG_FILE" | cut -d= -f2-)"
  [ "$enabled" = 'true' ] || die "offline MCP configuration must set DATABENCH_MCP_ENABLED=true"
  [ "$auth_mode" = 'none' ] ||
    die "offline MCP configuration must set DATABENCH_MCP_AUTH_MODE=none"
  validate_mcp_public_base_url "$public_base"
  validate_mcp_origins "$origins"
  [ "$(stat -c '%a' "$DATABENCH_MCP_CONFIG_FILE")" = '600' ] ||
    die "MCP configuration permissions must be 0600: $DATABENCH_MCP_CONFIG_FILE"
  [ "$(stat -c '%U:%G' "$DATABENCH_MCP_CONFIG_FILE")" = 'root:root' ] ||
    die "MCP configuration owner must be root:root: $DATABENCH_MCP_CONFIG_FILE"
}

ensure_mcp_config() {
  local configured_base requested_base origins temp
  if [ -e "$DATABENCH_MCP_CONFIG_FILE" ]; then
    validate_mcp_config
    configured_base="$(grep -E '^DATABENCH_MCP_PUBLIC_BASE_URL=' "$DATABENCH_MCP_CONFIG_FILE" | cut -d= -f2-)"
    requested_base="${DATABENCH_MCP_PUBLIC_BASE_URL:-}"
    if [ -n "$requested_base" ] && [ "$requested_base" != "$configured_base" ]; then
      die "MCP public base is already configured as $configured_base; update $DATABENCH_MCP_CONFIG_FILE explicitly during a maintenance window"
    fi
    log "reusing MCP public base $configured_base"
    return
  fi

  requested_base="${DATABENCH_MCP_PUBLIC_BASE_URL:-}"
  [ -n "$requested_base" ] ||
    die "set DATABENCH_MCP_PUBLIC_BASE_URL to the stable agent-reachable http(s)://host[:port]/api URL"
  validate_mcp_public_base_url "$requested_base"
  origins="${DATABENCH_MCP_ORIGINS:-}"
  validate_mcp_origins "$origins"

  temp="${DATABENCH_MCP_CONFIG_FILE}.tmp.$$"
  umask 077
  {
    printf 'DATABENCH_MCP_ENABLED=true\n'
    printf 'DATABENCH_MCP_AUTH_MODE=none\n'
    printf 'DATABENCH_MCP_PUBLIC_BASE_URL=%s\n' "$requested_base"
    printf 'DATABENCH_MCP_ORIGINS=%s\n' "$origins"
  } > "$temp"
  chown root:root "$temp"
  chmod 0600 "$temp"
  mv -f "$temp" "$DATABENCH_MCP_CONFIG_FILE"
  validate_mcp_config
  log "wrote anonymous trusted-network MCP configuration to $DATABENCH_MCP_CONFIG_FILE"
}

release_requires_mcp_config() {
  local release_dir="$1"
  [ -f "${release_dir}/compose.yml" ] || die "release is missing compose.yml: $release_dir"
  grep -Eq '/mcp\.env([[:space:]]|$)' "${release_dir}/compose.yml"
}

validate_release_mcp_config_if_required() {
  local release_dir="$1"
  if release_requires_mcp_config "$release_dir"; then
    validate_mcp_config
  fi
}

validate_backup_key() {
  [ -f "$DATABENCH_BACKUP_KEY_FILE" ] ||
    die "backup escrow key is missing: $DATABENCH_BACKUP_KEY_FILE"
  [ -s "$DATABENCH_BACKUP_KEY_FILE" ] ||
    die "backup escrow key is empty: $DATABENCH_BACKUP_KEY_FILE"
  [ "$(stat -c '%a' "$DATABENCH_BACKUP_KEY_FILE")" = '600' ] ||
    die "backup escrow key permissions must be 0600: $DATABENCH_BACKUP_KEY_FILE"
}

ensure_secret_config() {
  local postgres_password minio_root_password minio_app_password cursor_secret temp
  if [ -e "$DATABENCH_CONFIG_FILE" ]; then
    validate_existing_config
    log "reusing existing secrets from $DATABENCH_CONFIG_FILE"
  else
    postgres_password="$(random_secret)"
    minio_root_password="$(random_secret)"
    minio_app_password="$(random_secret)"
    cursor_secret="$(random_secret)"
    temp="${DATABENCH_CONFIG_FILE}.tmp.$$"
    umask 077
    {
      printf 'POSTGRES_USER=databench\n'
      printf 'POSTGRES_PASSWORD=%s\n' "$postgres_password"
      printf 'POSTGRES_DB=databench\n'
      printf 'DATABASE_URL=postgresql://databench:%s@postgres:5432/databench?schema=public\n' "$postgres_password"
      printf 'MINIO_ROOT_USER=databench_root\n'
      printf 'MINIO_ROOT_PASSWORD=%s\n' "$minio_root_password"
      printf 'S3_ENDPOINT=http://minio:9000\n'
      printf 'S3_REGION=us-east-1\n'
      printf 'S3_BUCKET=databench\n'
      printf 'S3_ACCESS_KEY_ID=databench_app\n'
      printf 'S3_SECRET_ACCESS_KEY=%s\n' "$minio_app_password"
      printf 'S3_FORCE_PATH_STYLE=true\n'
      printf 'DATABENCH_OBJECT_STORE=s3\n'
      printf 'DATABENCH_CORS_ORIGINS=\n'
      printf 'DATABENCH_ROOT=/var/lib/databench\n'
      printf 'DATABENCH_V2_CURSOR_SECRET=%s\n' "$cursor_secret"
      printf 'PORT=8000\n'
    } > "$temp"
    chown root:root "$temp"
    chmod 0600 "$temp"
    mv -f "$temp" "$DATABENCH_CONFIG_FILE"
    log "generated secrets in $DATABENCH_CONFIG_FILE"
  fi

  if [ ! -e "$DATABENCH_BACKUP_KEY_FILE" ]; then
    umask 077
    random_secret > "$DATABENCH_BACKUP_KEY_FILE"
    chown root:root "$DATABENCH_BACKUP_KEY_FILE"
    chmod 0600 "$DATABENCH_BACKUP_KEY_FILE"
    log "generated backup escrow key in $DATABENCH_BACKUP_KEY_FILE"
  fi
  validate_backup_key
}

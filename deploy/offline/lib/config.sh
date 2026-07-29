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
    DATABENCH_V2_CURSOR_SECRET DATABENCH_MODEL_DEPLOYMENT_OPERATOR_TOKEN \
    DATABENCH_SERVICE_CREDENTIAL PORT; do
    count="$(grep -Ec "^${key}=.+" "$DATABENCH_CONFIG_FILE" || true)"
    [ "$count" -eq 1 ] || die "configuration must contain exactly one non-empty $key"
  done
  [ "$(stat -c '%a' "$DATABENCH_CONFIG_FILE")" = '600' ] ||
    die "configuration permissions must be 0600: $DATABENCH_CONFIG_FILE"
  [ "$(stat -c '%U:%G' "$DATABENCH_CONFIG_FILE")" = 'root:root' ] ||
    die "configuration owner must be root:root: $DATABENCH_CONFIG_FILE"
  local operator_token service_credential
  operator_token="$(grep -E '^DATABENCH_MODEL_DEPLOYMENT_OPERATOR_TOKEN=' "$DATABENCH_CONFIG_FILE" | cut -d= -f2-)"
  service_credential="$(grep -E '^DATABENCH_SERVICE_CREDENTIAL=' "$DATABENCH_CONFIG_FILE" | cut -d= -f2-)"
  [[ "$operator_token" =~ ^[0-9a-f]{64}$ ]] ||
    die "model Deployment operator token must be 32 random bytes in hex"
  [[ "$service_credential" =~ ^[0-9a-f]{64}$ ]] ||
    die "Databench service credential must be 32 random bytes in hex"
  [ "$operator_token" != "$service_credential" ] ||
    die "model Deployment operator and service credentials must be distinct"
}

ensure_model_deployment_credentials() {
  local operator_count service_count operator_token service_credential temp
  operator_count="$(grep -Ec '^DATABENCH_MODEL_DEPLOYMENT_OPERATOR_TOKEN=' "$DATABENCH_CONFIG_FILE" || true)"
  service_count="$(grep -Ec '^DATABENCH_SERVICE_CREDENTIAL=' "$DATABENCH_CONFIG_FILE" || true)"
  if [ "$operator_count" -eq 1 ] && [ "$service_count" -eq 1 ]; then
    return
  fi
  [ "$operator_count" -eq 0 ] && [ "$service_count" -eq 0 ] ||
    die "existing configuration has an incomplete model Deployment credential pair"
  operator_token="$(random_secret)"
  service_credential="$(random_secret)"
  temp="${DATABENCH_CONFIG_FILE}.tmp.$$"
  umask 077
  cp "$DATABENCH_CONFIG_FILE" "$temp"
  {
    printf 'DATABENCH_MODEL_DEPLOYMENT_OPERATOR_TOKEN=%s\n' "$operator_token"
    printf 'DATABENCH_SERVICE_CREDENTIAL=%s\n' "$service_credential"
  } >> "$temp"
  chown root:root "$temp"
  chmod 0600 "$temp"
  mv -f "$temp" "$DATABENCH_CONFIG_FILE"
  log "added model Deployment credentials to $DATABENCH_CONFIG_FILE"
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

validate_evalscope_positive_bound() {
  local key="$1" maximum="$2" value
  value="$(grep -E "^${key}=" "$DATABENCH_EVALSCOPE_CONFIG_FILE" | cut -d= -f2-)"
  [[ "$value" =~ ^[1-9][0-9]*$ ]] && [ "${#value}" -le 11 ] &&
    [ "$((10#$value))" -le "$maximum" ] ||
    die "$key must be a positive integer no greater than $maximum"
}

validate_evalscope_config() {
  local key count task_key operator_token origin model_allowlist dataset_allowlist public_base
  local service_credential expected_service_credential
  [ -f "$DATABENCH_EVALSCOPE_CONFIG_FILE" ] ||
    die "EvalScope configuration is missing: $DATABENCH_EVALSCOPE_CONFIG_FILE"
  validate_mcp_config
  for key in EVALSCOPE_TASK_CONFIG_HMAC_KEY EVALSCOPE_OPERATOR_TOKEN DATABENCH_ORIGIN \
    EVALSCOPE_MODEL_ENDPOINT_ALLOWLIST EVALSCOPE_DATASET_ENDPOINT_ALLOWLIST \
    EVALSCOPE_INPUT_MAX_BYTES EVALSCOPE_OUTPUT_MAX_BYTES EVALSCOPE_ARCHIVE_MAX_BYTES \
    EVALSCOPE_REQUEST_MAX_BYTES EVALSCOPE_RESPONSE_MAX_BYTES EVALSCOPE_DOCUMENT_MAX_BYTES \
    EVALSCOPE_DOCUMENT_TTL_SECONDS EVALSCOPE_MAX_CONCURRENT_EVALS \
    EVALSCOPE_MAX_CONCURRENT_PERF EVALSCOPE_MAX_TASKS EVALSCOPE_TASK_RUNTIME_SECONDS \
    EVALSCOPE_EVALUATION_SAMPLE_LIMIT_MAX EVALSCOPE_EVALUATION_BATCH_SIZE_MAX \
    EVALSCOPE_EVALUATION_REPEATS_MAX EVALSCOPE_PERFORMANCE_PARALLEL_MAX \
    EVALSCOPE_PERFORMANCE_REQUESTS_MAX EVALSCOPE_PERFORMANCE_RATE_MAX \
    EVALSCOPE_MODEL_TOKENS_MAX EVALSCOPE_REQUEST_TIMEOUT_SECONDS_MAX \
    DATABENCH_SERVICE_CREDENTIAL; do
    count="$(grep -Ec "^${key}=" "$DATABENCH_EVALSCOPE_CONFIG_FILE" || true)"
    [ "$count" -eq 1 ] || die "EvalScope configuration must contain exactly one $key"
  done
  task_key="$(grep -E '^EVALSCOPE_TASK_CONFIG_HMAC_KEY=' "$DATABENCH_EVALSCOPE_CONFIG_FILE" | cut -d= -f2-)"
  operator_token="$(grep -E '^EVALSCOPE_OPERATOR_TOKEN=' "$DATABENCH_EVALSCOPE_CONFIG_FILE" | cut -d= -f2-)"
  [[ "$task_key" =~ ^[0-9a-f]{64}$ ]] || die "EvalScope task HMAC key must be 32 random bytes in hex"
  [[ "$operator_token" =~ ^[0-9a-f]{64}$ ]] || die "EvalScope operator token must be 32 random bytes in hex"
  origin="$(grep -E '^DATABENCH_ORIGIN=' "$DATABENCH_EVALSCOPE_CONFIG_FILE" | cut -d= -f2-)"
  validate_mcp_public_base_url "${origin}/api" 'DATABENCH_ORIGIN'
  public_base="$(grep -E '^DATABENCH_MCP_PUBLIC_BASE_URL=' "$DATABENCH_MCP_CONFIG_FILE" | cut -d= -f2-)"
  [ "$origin" = "${public_base%/api}" ] ||
    die "DATABENCH_ORIGIN must match the configured offline public base origin"
  service_credential="$(grep -E '^DATABENCH_SERVICE_CREDENTIAL=' "$DATABENCH_EVALSCOPE_CONFIG_FILE" | cut -d= -f2-)"
  expected_service_credential="$(grep -E '^DATABENCH_SERVICE_CREDENTIAL=' "$DATABENCH_CONFIG_FILE" | cut -d= -f2-)"
  [[ "$service_credential" =~ ^[0-9a-f]{64}$ ]] ||
    die "EvalScope Databench service credential must be 32 random bytes in hex"
  [ "$service_credential" = "$expected_service_credential" ] ||
    die "EvalScope and API Databench service credentials must match"
  model_allowlist="$(grep -E '^EVALSCOPE_MODEL_ENDPOINT_ALLOWLIST=' "$DATABENCH_EVALSCOPE_CONFIG_FILE" | cut -d= -f2-)"
  dataset_allowlist="$(grep -E '^EVALSCOPE_DATASET_ENDPOINT_ALLOWLIST=' "$DATABENCH_EVALSCOPE_CONFIG_FILE" | cut -d= -f2-)"
  [[ "$model_allowlist" =~ ^[A-Za-z0-9.,\|:/_-]*$ ]] ||
    die "EvalScope model endpoint allowlist contains unsupported characters"
  [ -z "$dataset_allowlist" ] || die "offline EvalScope Dataset endpoint allowlist must remain empty"
  validate_evalscope_positive_bound EVALSCOPE_INPUT_MAX_BYTES 4294967296
  validate_evalscope_positive_bound EVALSCOPE_OUTPUT_MAX_BYTES 17179869184
  validate_evalscope_positive_bound EVALSCOPE_ARCHIVE_MAX_BYTES 1073741824
  validate_evalscope_positive_bound EVALSCOPE_REQUEST_MAX_BYTES 16777216
  validate_evalscope_positive_bound EVALSCOPE_RESPONSE_MAX_BYTES 67108864
  validate_evalscope_positive_bound EVALSCOPE_DOCUMENT_MAX_BYTES 67108864
  validate_evalscope_positive_bound EVALSCOPE_DOCUMENT_TTL_SECONDS 86400
  validate_evalscope_positive_bound EVALSCOPE_MAX_CONCURRENT_EVALS 16
  validate_evalscope_positive_bound EVALSCOPE_MAX_CONCURRENT_PERF 16
  validate_evalscope_positive_bound EVALSCOPE_MAX_TASKS 100000
  validate_evalscope_positive_bound EVALSCOPE_TASK_RUNTIME_SECONDS 86400
  validate_evalscope_positive_bound EVALSCOPE_EVALUATION_SAMPLE_LIMIT_MAX 1000000
  validate_evalscope_positive_bound EVALSCOPE_EVALUATION_BATCH_SIZE_MAX 1024
  validate_evalscope_positive_bound EVALSCOPE_EVALUATION_REPEATS_MAX 100
  validate_evalscope_positive_bound EVALSCOPE_PERFORMANCE_PARALLEL_MAX 1024
  validate_evalscope_positive_bound EVALSCOPE_PERFORMANCE_REQUESTS_MAX 10000000
  validate_evalscope_positive_bound EVALSCOPE_PERFORMANCE_RATE_MAX 100000
  validate_evalscope_positive_bound EVALSCOPE_MODEL_TOKENS_MAX 131072
  validate_evalscope_positive_bound EVALSCOPE_REQUEST_TIMEOUT_SECONDS_MAX 86400
  [ "$(stat -c '%a' "$DATABENCH_EVALSCOPE_CONFIG_FILE")" = '600' ] ||
    die "EvalScope configuration permissions must be 0600: $DATABENCH_EVALSCOPE_CONFIG_FILE"
  [ "$(stat -c '%U:%G' "$DATABENCH_EVALSCOPE_CONFIG_FILE")" = 'root:root' ] ||
    die "EvalScope configuration owner must be root:root: $DATABENCH_EVALSCOPE_CONFIG_FILE"
}

ensure_evalscope_config() {
  local public_base origin task_key operator_token model_allowlist service_credential temp
  if [ -e "$DATABENCH_EVALSCOPE_CONFIG_FILE" ]; then
    ensure_evalscope_service_credential
    validate_evalscope_config
    ensure_evalscope_swift_allowlist
    validate_evalscope_config
    log "reusing EvalScope configuration from $DATABENCH_EVALSCOPE_CONFIG_FILE"
    return
  fi
  validate_mcp_config
  public_base="$(grep -E '^DATABENCH_MCP_PUBLIC_BASE_URL=' "$DATABENCH_MCP_CONFIG_FILE" | cut -d= -f2-)"
  origin="${public_base%/api}"
  task_key="$(random_secret)"
  operator_token="$(random_secret)"
  service_credential="$(grep -E '^DATABENCH_SERVICE_CREDENTIAL=' "$DATABENCH_CONFIG_FILE" | cut -d= -f2-)"
  model_allowlist="${DATABENCH_EVALSCOPE_MODEL_ENDPOINT_ALLOWLIST:-}"
  [[ "$model_allowlist" =~ ^[A-Za-z0-9.,\|:/_-]*$ ]] ||
    die "DATABENCH_EVALSCOPE_MODEL_ENDPOINT_ALLOWLIST contains unsupported characters"
  temp="${DATABENCH_EVALSCOPE_CONFIG_FILE}.tmp.$$"
  umask 077
  {
    printf 'EVALSCOPE_TASK_CONFIG_HMAC_KEY=%s\n' "$task_key"
    printf 'EVALSCOPE_OPERATOR_TOKEN=%s\n' "$operator_token"
    printf 'DATABENCH_ORIGIN=%s\n' "$origin"
    printf 'DATABENCH_SERVICE_CREDENTIAL=%s\n' "$service_credential"
    printf 'EVALSCOPE_MODEL_ENDPOINT_ALLOWLIST=%s\n' "$model_allowlist"
    printf 'EVALSCOPE_DATASET_ENDPOINT_ALLOWLIST=\n'
    printf 'EVALSCOPE_INPUT_MAX_BYTES=1073741824\n'
    printf 'EVALSCOPE_OUTPUT_MAX_BYTES=4294967296\n'
    printf 'EVALSCOPE_ARCHIVE_MAX_BYTES=1073741824\n'
    printf 'EVALSCOPE_REQUEST_MAX_BYTES=1048576\n'
    printf 'EVALSCOPE_RESPONSE_MAX_BYTES=16777216\n'
    printf 'EVALSCOPE_DOCUMENT_MAX_BYTES=16777216\n'
    printf 'EVALSCOPE_DOCUMENT_TTL_SECONDS=900\n'
    printf 'EVALSCOPE_MAX_CONCURRENT_EVALS=2\n'
    printf 'EVALSCOPE_MAX_CONCURRENT_PERF=2\n'
    printf 'EVALSCOPE_MAX_TASKS=10000\n'
    printf 'EVALSCOPE_TASK_RUNTIME_SECONDS=86400\n'
    printf 'EVALSCOPE_EVALUATION_SAMPLE_LIMIT_MAX=100000\n'
    printf 'EVALSCOPE_EVALUATION_BATCH_SIZE_MAX=256\n'
    printf 'EVALSCOPE_EVALUATION_REPEATS_MAX=10\n'
    printf 'EVALSCOPE_PERFORMANCE_PARALLEL_MAX=256\n'
    printf 'EVALSCOPE_PERFORMANCE_REQUESTS_MAX=1000000\n'
    printf 'EVALSCOPE_PERFORMANCE_RATE_MAX=10000\n'
    printf 'EVALSCOPE_MODEL_TOKENS_MAX=32768\n'
    printf 'EVALSCOPE_REQUEST_TIMEOUT_SECONDS_MAX=3600\n'
  } > "$temp"
  chown root:root "$temp"
  chmod 0600 "$temp"
  mv -f "$temp" "$DATABENCH_EVALSCOPE_CONFIG_FILE"
  ensure_evalscope_swift_allowlist
  validate_evalscope_config
  log "wrote EvalScope runtime configuration to $DATABENCH_EVALSCOPE_CONFIG_FILE"
}

ensure_evalscope_service_credential() {
  local count service_credential temp
  count="$(grep -Ec '^DATABENCH_SERVICE_CREDENTIAL=' "$DATABENCH_EVALSCOPE_CONFIG_FILE" || true)"
  if [ "$count" -eq 1 ]; then
    return
  fi
  [ "$count" -eq 0 ] ||
    die "EvalScope configuration contains duplicate Databench service credentials"
  service_credential="$(grep -E '^DATABENCH_SERVICE_CREDENTIAL=' "$DATABENCH_CONFIG_FILE" | cut -d= -f2-)"
  [[ "$service_credential" =~ ^[0-9a-f]{64}$ ]] ||
    die "Databench service credential is unavailable for EvalScope"
  temp="${DATABENCH_EVALSCOPE_CONFIG_FILE}.tmp.$$"
  umask 077
  cp "$DATABENCH_EVALSCOPE_CONFIG_FILE" "$temp"
  printf 'DATABENCH_SERVICE_CREDENTIAL=%s\n' "$service_credential" >> "$temp"
  chown root:root "$temp"
  chmod 0600 "$temp"
  mv -f "$temp" "$DATABENCH_EVALSCOPE_CONFIG_FILE"
}

ensure_evalscope_swift_allowlist() {
  local current updated rule temp
  [ -f "$DATABENCH_SWIFT_CONFIG_FILE" ] || return
  grep -qx 'DATABENCH_SWIFT_ENABLED=true' "$DATABENCH_SWIFT_CONFIG_FILE" || return
  current="$(grep -E '^EVALSCOPE_MODEL_ENDPOINT_ALLOWLIST=' "$DATABENCH_EVALSCOPE_CONFIG_FILE" | cut -d= -f2-)"
  updated="$current"
  for rule in \
    'http|10.0.0.0/8|8000' \
    'http|172.16.0.0/12|8000' \
    'http|192.168.0.0/16|8000'; do
    case ",${updated}," in
      *",${rule},"*) ;;
      *)
        if [ -n "$updated" ]; then
          updated="${updated},${rule}"
        else
          updated="$rule"
        fi
        ;;
    esac
  done
  [ "$updated" != "$current" ] || return
  temp="${DATABENCH_EVALSCOPE_CONFIG_FILE}.tmp.$$"
  umask 077
  awk -v value="$updated" '
    /^EVALSCOPE_MODEL_ENDPOINT_ALLOWLIST=/ {
      print "EVALSCOPE_MODEL_ENDPOINT_ALLOWLIST=" value
      next
    }
    { print }
  ' "$DATABENCH_EVALSCOPE_CONFIG_FILE" > "$temp"
  chown root:root "$temp"
  chmod 0600 "$temp"
  mv -f "$temp" "$DATABENCH_EVALSCOPE_CONFIG_FILE"
  log "allowed Docker-private Swift serving endpoints on port 8000 for EvalScope"
}

validate_swift_config() {
  local key count enabled device_id api_credential provider_credential
  [ -f "$DATABENCH_SWIFT_CONFIG_FILE" ] ||
    die "Swift configuration is missing: $DATABENCH_SWIFT_CONFIG_FILE"
  for key in DATABENCH_SWIFT_ENABLED DATABENCH_SWIFT_GPU_DEVICE_ID \
    DATABENCH_SWIFT_STUDIO_PROVIDER_CREDENTIAL DATABENCH_SWIFT_PROVIDER_CREDENTIAL; do
    count="$(grep -Ec "^${key}=.+" "$DATABENCH_SWIFT_CONFIG_FILE" || true)"
    [ "$count" -eq 1 ] || die "Swift configuration must contain exactly one non-empty $key"
  done
  enabled="$(grep -E '^DATABENCH_SWIFT_ENABLED=' "$DATABENCH_SWIFT_CONFIG_FILE" | cut -d= -f2-)"
  [ "$enabled" = 'true' ] || [ "$enabled" = 'false' ] ||
    die "DATABENCH_SWIFT_ENABLED must be true or false"
  device_id="$(grep -E '^DATABENCH_SWIFT_GPU_DEVICE_ID=' "$DATABENCH_SWIFT_CONFIG_FILE" | cut -d= -f2-)"
  [[ "$device_id" =~ ^(0|[1-9][0-9]*)$ ]] && [ "${#device_id}" -le 4 ] ||
    die "DATABENCH_SWIFT_GPU_DEVICE_ID must be a canonical non-negative integer"
  api_credential="$(grep -E '^DATABENCH_SWIFT_STUDIO_PROVIDER_CREDENTIAL=' "$DATABENCH_SWIFT_CONFIG_FILE" | cut -d= -f2-)"
  provider_credential="$(grep -E '^DATABENCH_SWIFT_PROVIDER_CREDENTIAL=' "$DATABENCH_SWIFT_CONFIG_FILE" | cut -d= -f2-)"
  [[ "$api_credential" =~ ^[0-9a-f]{64}$ ]] ||
    die "Swift API Provider credential must be 32 random bytes in hex"
  [ "$api_credential" = "$provider_credential" ] ||
    die "Swift API and Provider credentials must match"
  [ "$(stat -c '%a' "$DATABENCH_SWIFT_CONFIG_FILE")" = '600' ] ||
    die "Swift configuration permissions must be 0600: $DATABENCH_SWIFT_CONFIG_FILE"
  [ "$(stat -c '%U:%G' "$DATABENCH_SWIFT_CONFIG_FILE")" = 'root:root' ] ||
    die "Swift configuration owner must be root:root: $DATABENCH_SWIFT_CONFIG_FILE"
}

ensure_swift_config() {
  local requested enabled device_id credential temp
  requested="${DATABENCH_ENABLE_SWIFT_GPU:-}"
  case "$requested" in
    ''|true|false) ;;
    *) die "DATABENCH_ENABLE_SWIFT_GPU must be true or false" ;;
  esac
  if [ -e "$DATABENCH_SWIFT_CONFIG_FILE" ]; then
    validate_swift_config
    enabled="$(grep -E '^DATABENCH_SWIFT_ENABLED=' "$DATABENCH_SWIFT_CONFIG_FILE" | cut -d= -f2-)"
    if [ -n "$requested" ] && [ "$requested" != "$enabled" ]; then
      set_swift_enabled_state "$requested"
    fi
    validate_swift_config
    return
  fi

  enabled="${requested:-false}"
  device_id="${DATABENCH_SWIFT_GPU_DEVICE_ID:-0}"
  [[ "$device_id" =~ ^(0|[1-9][0-9]*)$ ]] && [ "${#device_id}" -le 4 ] ||
    die "DATABENCH_SWIFT_GPU_DEVICE_ID must be a canonical non-negative integer"
  credential="$(random_secret)"
  temp="${DATABENCH_SWIFT_CONFIG_FILE}.tmp.$$"
  umask 077
  {
    printf 'DATABENCH_SWIFT_ENABLED=%s\n' "$enabled"
    printf 'DATABENCH_SWIFT_GPU_DEVICE_ID=%s\n' "$device_id"
    printf 'DATABENCH_SWIFT_STUDIO_PROVIDER_CREDENTIAL=%s\n' "$credential"
    printf 'DATABENCH_SWIFT_PROVIDER_CREDENTIAL=%s\n' "$credential"
  } > "$temp"
  chown root:root "$temp"
  chmod 0600 "$temp"
  mv -f "$temp" "$DATABENCH_SWIFT_CONFIG_FILE"
  validate_swift_config
  log "wrote Swift GPU runtime configuration to $DATABENCH_SWIFT_CONFIG_FILE"
}

set_swift_enabled_state() {
  local enabled="$1" current temp
  [ "$enabled" = 'true' ] || [ "$enabled" = 'false' ] ||
    die "Swift enabled state must be true or false"
  validate_swift_config
  current="$(grep -E '^DATABENCH_SWIFT_ENABLED=' "$DATABENCH_SWIFT_CONFIG_FILE" | cut -d= -f2-)"
  [ "$current" != "$enabled" ] || return
  temp="${DATABENCH_SWIFT_CONFIG_FILE}.tmp.$$"
  umask 077
  awk -v value="$enabled" '
    /^DATABENCH_SWIFT_ENABLED=/ {
      print "DATABENCH_SWIFT_ENABLED=" value
      next
    }
    { print }
  ' "$DATABENCH_SWIFT_CONFIG_FILE" > "$temp"
  chown root:root "$temp"
  chmod 0600 "$temp"
  mv -f "$temp" "$DATABENCH_SWIFT_CONFIG_FILE"
  validate_swift_config
  log "updated Swift GPU runtime enabled state to $enabled"
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
  local postgres_password minio_root_password minio_app_password cursor_secret
  local operator_token service_credential temp
  if [ -e "$DATABENCH_CONFIG_FILE" ]; then
    ensure_model_deployment_credentials
    validate_existing_config
    log "reusing existing secrets from $DATABENCH_CONFIG_FILE"
  else
    postgres_password="$(random_secret)"
    minio_root_password="$(random_secret)"
    minio_app_password="$(random_secret)"
    cursor_secret="$(random_secret)"
    operator_token="$(random_secret)"
    service_credential="$(random_secret)"
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
      printf 'DATABENCH_MODEL_DEPLOYMENT_OPERATOR_TOKEN=%s\n' "$operator_token"
      printf 'DATABENCH_SERVICE_CREDENTIAL=%s\n' "$service_credential"
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

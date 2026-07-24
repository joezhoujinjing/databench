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

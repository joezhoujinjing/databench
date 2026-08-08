#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ECS_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
TEST_ROOT="$(mktemp -d)"
trap 'rm -rf "${TEST_ROOT}"' EXIT
mkdir -p "${TEST_ROOT}/bin"

cat > "${TEST_ROOT}/bin/aliyun" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail

command_name="${1:-} ${2:-}"
shift 2
case "${command_name}" in
  'cdn DescribeCdnDomainConfigs')
    cat <<'JSON'
{"DomainConfigs":{"DomainConfig":[{"ConfigId":"10","FunctionName":"condition","FunctionArgs":{"FunctionArg":[{"ArgName":"rule","ArgValue":"{\"name\":\"databench-evalscope-api-v1\"}"}]}},{"ConfigId":"11","ParentId":"10","FunctionName":"origin_dns_host","FunctionArgs":{"FunctionArg":[]}},{"ConfigId":"12","ParentId":"0","FunctionName":"origin_host","FunctionArgs":{"FunctionArg":[{"ArgName":"origin","ArgValue":"api.databench.jinjing.me"},{"ArgName":"host","ArgValue":"api.databench.jinjing.me"}]}},{"ConfigId":"13","FunctionName":"path_based_ttl_set","FunctionArgs":{"FunctionArg":[{"ArgName":"path","ArgValue":"/evalscope-api/"}]}},{"ConfigId":"14","FunctionName":"path_based_ttl_set","FunctionArgs":{"FunctionArg":[{"ArgName":"path","ArgValue":"/assets"}]}}]}}
JSON
    ;;
  'cdn DeleteSpecificConfig')
    while [[ $# -gt 0 ]]; do
      if [[ "$1" == '--ConfigId' ]]; then
        printf '%s\n' "$2" >> "${FAKE_ALIYUN_DELETED}"
        exit 0
      fi
      shift
    done
    exit 1
    ;;
  'cdn BatchSetCdnDomainConfig')
    functions=''
    while [[ $# -gt 0 ]]; do
      if [[ "$1" == '--Functions' ]]; then
        functions="$2"
        break
      fi
      shift
    done
    [[ -n "${functions}" ]]
    printf '%s\n' "${functions}" >> "${FAKE_ALIYUN_FUNCTIONS}"
    if jq -e '.[0].functionName == "condition"' <<< "${functions}" >/dev/null; then
      printf '%s\n' '{"DomainConfigList":{"DomainConfigModel":[{"ConfigId":"20"}]}}'
    else
      printf '%s\n' '{}'
    fi
    ;;
  *)
    echo "unexpected fake aliyun invocation: ${command_name} $*" >&2
    exit 1
    ;;
esac
EOF
chmod +x "${TEST_ROOT}/bin/aliyun"

export PATH="${TEST_ROOT}/bin:${PATH}"
export CDN_DOMAIN=databench.jinjing.me
export EVALSCOPE_ORIGIN_HOST=api.databench.jinjing.me
export FAKE_ALIYUN_DELETED="${TEST_ROOT}/deleted"
export FAKE_ALIYUN_FUNCTIONS="${TEST_ROOT}/functions"

"${ECS_DIR}/configure-cdn-evalscope.sh"

sort -u "${FAKE_ALIYUN_DELETED}" > "${TEST_ROOT}/deleted.sorted"
printf '%s\n' 10 11 12 13 > "${TEST_ROOT}/deleted.expected"
cmp "${TEST_ROOT}/deleted.expected" "${TEST_ROOT}/deleted.sorted"
test "$(wc -l < "${FAKE_ALIYUN_FUNCTIONS}" | tr -d ' ')" = 3

condition="$(sed -n '1p' "${FAKE_ALIYUN_FUNCTIONS}")"
child="$(sed -n '2p' "${FAKE_ALIYUN_FUNCTIONS}")"
standalone="$(sed -n '3p' "${FAKE_ALIYUN_FUNCTIONS}")"

jq -e '
  length == 1
  and .[0].functionName == "condition"
  and (.[0].functionArgs[0].argValue | fromjson
    | .match.criteria[0].matchType == "uri"
    and .match.criteria[0].matchOperator == "contains"
    and .match.criteria[0].matchValue == ["/evalscope-api/*"])
' <<< "${condition}" >/dev/null
jq -e '
  length == 1
  and .[0].functionName == "origin_dns_host"
  and .[0].parentId == "20"
' <<< "${child}" >/dev/null
jq -e '
  length == 2
  and any(.[]; .functionName == "origin_host" and (has("parentId") | not))
  and any(.[];
    .functionName == "path_based_ttl_set"
    and (has("parentId") | not)
    and any(.functionArgs[]; .argName == "path" and .argValue == "/evalscope-api")
    and any(.functionArgs[]; .argName == "swift_no_cache_low" and .argValue == "on"))
' <<< "${standalone}" >/dev/null

echo 'ecs CDN configuration tests passed'

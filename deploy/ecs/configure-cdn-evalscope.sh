#!/usr/bin/env bash
set -euo pipefail

CDN_DOMAIN="${CDN_DOMAIN:?set CDN_DOMAIN}"
EVALSCOPE_ORIGIN_HOST="${EVALSCOPE_ORIGIN_HOST:-api.databench.jinjing.me}"
ALIYUN_PROFILE="${ALIYUN_PROFILE:-ci}"
RULE_NAME="databench-evalscope-api-v1"

require_command() {
  command -v "$1" >/dev/null 2>&1 || {
    echo "missing required command: $1" >&2
    exit 69
  }
}

require_command aliyun
require_command jq

describe_file="$(mktemp)"
trap 'rm -f "${describe_file}"' EXIT

aliyun cdn DescribeCdnDomainConfigs \
  --DomainName "${CDN_DOMAIN}" \
  --FunctionNames condition,origin_dns_host,origin_host,path_based_ttl_set \
  --profile "${ALIYUN_PROFILE}" > "${describe_file}"

prior_condition_ids=()
while IFS= read -r config_id; do
  [[ -n "${config_id}" ]] && prior_condition_ids+=("${config_id}")
done < <(
  jq -r --arg name "${RULE_NAME}" '
    (.DomainConfigs.DomainConfig // [])[]
    | select(.FunctionName == "condition")
    | select((.FunctionArgs | tostring) | contains($name))
    | .ConfigId
  ' "${describe_file}"
)

for condition_id in "${prior_condition_ids[@]}"; do
  child_ids=()
  while IFS= read -r config_id; do
    [[ -n "${config_id}" ]] && child_ids+=("${config_id}")
  done < <(
    jq -r --arg parent "${condition_id}" '
      (.DomainConfigs.DomainConfig // [])[]
      | select((.ParentId // "" | tostring) == $parent)
      | .ConfigId
    ' "${describe_file}"
  )
  for config_id in "${child_ids[@]}"; do
    aliyun cdn DeleteSpecificConfig \
      --DomainName "${CDN_DOMAIN}" --ConfigId "${config_id}" --profile "${ALIYUN_PROFILE}" >/dev/null
  done
  aliyun cdn DeleteSpecificConfig \
    --DomainName "${CDN_DOMAIN}" --ConfigId "${condition_id}" --profile "${ALIYUN_PROFILE}" >/dev/null
done

prior_standalone_ids=()
while IFS= read -r config_id; do
  [[ -n "${config_id}" ]] && prior_standalone_ids+=("${config_id}")
done < <(
  jq -r --arg origin "${EVALSCOPE_ORIGIN_HOST}" '
    def args:
      ((.FunctionArgs.FunctionArg // []) | if type == "array" then . else [.] end);
    (.DomainConfigs.DomainConfig // [])[]
    | select((.ParentId // "0" | tostring) == "0" or (.ParentId // "") == "")
    | select(
        (.FunctionName == "origin_host"
          and any(args[]; .ArgName == "origin" and .ArgValue == $origin)
          and any(args[]; .ArgName == "host" and .ArgValue == $origin))
        or
        (.FunctionName == "path_based_ttl_set"
          and any(args[];
            .ArgName == "path"
            and (.ArgValue == "/evalscope-api" or .ArgValue == "/evalscope-api/")))
      )
    | .ConfigId
  ' "${describe_file}" | sort -u
)
for config_id in "${prior_standalone_ids[@]}"; do
  aliyun cdn DeleteSpecificConfig \
    --DomainName "${CDN_DOMAIN}" --ConfigId "${config_id}" --profile "${ALIYUN_PROFILE}" >/dev/null
done

rule="$(jq -cn --arg name "${RULE_NAME}" '{
  match: {
    logic: "and",
    criteria: [{
      matchType: "uri",
      matchOperator: "contains",
      matchValue: ["/evalscope-api/*"],
      negate: false
    }]
  },
  name: $name,
  status: "enable"
}')"
condition_functions="$(jq -cn --arg rule "${rule}" '[{
  functionArgs: [{argName: "rule", argValue: $rule}],
  functionName: "condition"
}]')"
condition_response="$(aliyun cdn BatchSetCdnDomainConfig \
  --DomainNames "${CDN_DOMAIN}" \
  --Functions "${condition_functions}" \
  --profile "${ALIYUN_PROFILE}")"
condition_id="$(jq -er '.DomainConfigList.DomainConfigModel[0].ConfigId' <<< "${condition_response}")"

origin_child_functions="$(jq -cn \
  --arg parent "${condition_id}" \
  --arg origin "${EVALSCOPE_ORIGIN_HOST}" '[{
    functionArgs: [{argName: "ali_origin_dns_host", argValue: $origin}],
    functionName: "origin_dns_host",
    parentId: $parent
  }]')"
aliyun cdn BatchSetCdnDomainConfig \
  --DomainNames "${CDN_DOMAIN}" \
  --Functions "${origin_child_functions}" \
  --profile "${ALIYUN_PROFILE}" >/dev/null

standalone_functions="$(jq -cn \
  --arg origin "${EVALSCOPE_ORIGIN_HOST}" '[{
    functionArgs: [
      {argName: "origin", argValue: $origin},
      {argName: "host", argValue: $origin}
    ],
    functionName: "origin_host"
  }, {
    functionArgs: [
      {argName: "path", argValue: "/evalscope-api"},
      {argName: "weight", argValue: "99"},
      {argName: "ttl", argValue: "1"},
      {argName: "swift_origin_cache_high", argValue: "off"},
      {argName: "swift_no_cache_low", argValue: "on"},
      {argName: "swift_follow_cachetime", argValue: "off"}
    ],
    functionName: "path_based_ttl_set"
  }]')"
aliyun cdn BatchSetCdnDomainConfig \
  --DomainNames "${CDN_DOMAIN}" \
  --Functions "${standalone_functions}" \
  --profile "${ALIYUN_PROFILE}" >/dev/null

echo "configured ${CDN_DOMAIN}/evalscope-api/* -> ${EVALSCOPE_ORIGIN_HOST} (condition ${condition_id})"

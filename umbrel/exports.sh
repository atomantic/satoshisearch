# Generate and persist a vault key once, so recovered keys can be encrypted at
# rest across restarts. Stored in the app data dir, never in the repo.
SATOSHISEARCH_ENV_FILE="${EXPORTS_APP_DIR}/data/vault.env"

if [[ ! -f "${SATOSHISEARCH_ENV_FILE}" ]]; then
	mkdir -p "$(dirname "${SATOSHISEARCH_ENV_FILE}")"
	generated_key="$(head -c 32 /dev/urandom | xxd -p -c 32)"
	echo "export APP_SATOSHISEARCH_VAULT_KEY='${generated_key}'" > "${SATOSHISEARCH_ENV_FILE}"
	chmod 600 "${SATOSHISEARCH_ENV_FILE}"
fi

# shellcheck source=/dev/null
. "${SATOSHISEARCH_ENV_FILE}"
export APP_SATOSHISEARCH_VAULT_KEY

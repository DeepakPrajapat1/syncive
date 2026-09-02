# Syncive — HubSpot app upload

The HubSpot CLI v7.4+ writes a global config to `~/.hscli/config.yml`.
To leave your existing setup untouched, we point `HOME` at a throwaway
directory and never install the CLI globally.

## 1. Auth (only you can do this step)

Open https://app.hubspot.com/l/personal-access-key while logged into the
**app developer account**, generate a key, and copy it. The CLI will prompt
you to paste it.

```bash
cd ~/Downloads/syncive-v2/hubspot-app   # wherever you unzipped it
export HSHOME=$(mktemp -d)
HOME=$HSHOME npx @hubspot/cli@latest init
```

Pick the developer account, paste the personal access key when asked, and
give the account a nickname (e.g. `syncive-dev`).

## 2. Upload the project

```bash
HOME=$HSHOME npx @hubspot/cli@latest project upload
```

Re-run this after any edit to the JSON files.

## 3. Grab the credentials

```bash
HOME=$HSHOME npx @hubspot/cli@latest project open
```

Copy the app's **Client ID** and **Client secret** into the engine's env
(`HUBSPOT_CLIENT_ID`, `HUBSPOT_CLIENT_SECRET`) on Render, then confirm
`/setup` reports `"hubspotConfigured": true`.

Keep the `HOME=$HSHOME` prefix on every command, in one shell session.
